import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getPiCommand, shouldUseShellForPiCommand } from './command.js'
import {
  PI_STARTUP_STDERR_DRAIN_TIMEOUT_MS,
  PiStartupDiagnosticCapture,
  type PiStartupDiagnostic
} from './diagnostics.js'
import { LfJsonlReader } from './lf-jsonl-reader.js'

export class PiRpcSpawnError extends Error {
  /** Stable spawn/diagnostic code, e.g. ENOENT or PI_EXTENSION_LOAD_FAILED. */
  code?: string
  readonly diagnostic?: Readonly<PiStartupDiagnostic>
  /** Internal cleanup handle for any failed spawn whose direct-child termination remains unconfirmed. */
  readonly candidate?: PiRpcProcess

  constructor(
    message: string,
    opts?: {
      code?: string
      cause?: unknown
      diagnostic?: Readonly<PiStartupDiagnostic>
      candidate?: PiRpcProcess
    }
  ) {
    super(message)
    this.name = 'PiRpcSpawnError'
    this.code = opts?.code
    this.diagnostic = opts?.diagnostic
    if (opts?.candidate) {
      Object.defineProperty(this, 'candidate', {
        value: opts.candidate,
        enumerable: false,
        configurable: false,
        writable: false
      })
    }
    ;(this as any).cause = opts?.cause
  }
}

export const PI_RPC_PROCESS_TERMINATED_CODE = 'PI_RPC_PROCESS_TERMINATED' as const
export const PI_RPC_PROCESS_CLEANUP_UNCONFIRMED_CODE = 'PI_RPC_PROCESS_CLEANUP_UNCONFIRMED' as const
export const PI_RPC_HANDSHAKE_TIMEOUT_CODE = 'PI_RPC_HANDSHAKE_TIMEOUT' as const
export const PI_RPC_HANDSHAKE_FAILED_CODE = 'PI_RPC_HANDSHAKE_FAILED' as const
export const PI_RPC_EXECUTE_COMMAND_PROTOCOL_ERROR_CODE = 'PI_RPC_EXECUTE_COMMAND_PROTOCOL_ERROR' as const
export const PI_RPC_EXECUTE_COMMAND_FAILURE_CODES = [
  'COMMAND_INVALID_REQUEST',
  'COMMAND_NOT_FOUND',
  'COMMAND_BUSY',
  'COMMAND_REQUEST_CONFLICT',
  'COMMAND_HANDLER_FAILED'
] as const
export const PI_RPC_PROJECT_TRUST_POLICY = Object.freeze({
  policy: 'force-approve' as const,
  adapterOverride: 'approve' as const,
  perProjectConsent: false as const,
  basis: 'cli-approve' as const,
  cliArgument: '--approve' as const
})

export type PiRpcProcessTerminationCause =
  | 'exit'
  | 'process_error'
  | 'stdin_write_failure'
  | 'stdin_closed'
  | 'stdout_eof'
  | 'stdout_error'
  | 'stopped'

export type PiRpcProcessTerminatedData = Readonly<{
  code: typeof PI_RPC_PROCESS_TERMINATED_CODE
  piAcp: Readonly<{
    process: Readonly<{
      state: 'terminated'
      cause: PiRpcProcessTerminationCause
      exitCode?: number
      signal?: NodeJS.Signals
    }>
    recovery: Readonly<{
      strategy: 'restore_session_on_next_request'
      automaticReplay: false
    }>
    diagnostic?: Readonly<PiStartupDiagnostic>
  }>
}>

export class PiRpcProcessTerminatedError extends Error {
  readonly code = PI_RPC_PROCESS_TERMINATED_CODE
  readonly data: PiRpcProcessTerminatedData

  constructor(
    message: string,
    readonly diagnostic?: Readonly<PiStartupDiagnostic>,
    cause: {
      kind: PiRpcProcessTerminationCause
      code?: number | null
      signal?: NodeJS.Signals | null
    } = { kind: 'exit' }
  ) {
    super(message)
    this.name = 'PiRpcProcessTerminatedError'
    const processData = Object.freeze({
      state: 'terminated' as const,
      cause: cause.kind,
      ...(typeof cause.code === 'number' ? { exitCode: cause.code } : {}),
      ...(cause.signal ? { signal: cause.signal } : {})
    })
    const recovery = Object.freeze({
      strategy: 'restore_session_on_next_request' as const,
      automaticReplay: false as const
    })
    this.data = Object.freeze({
      code: PI_RPC_PROCESS_TERMINATED_CODE,
      piAcp: Object.freeze({
        process: processData,
        recovery,
        ...(diagnostic ? { diagnostic } : {})
      })
    })
  }
}

export function piRpcProcessTerminatedErrorData(error: PiRpcProcessTerminatedError): PiRpcProcessTerminatedData {
  return error.data
}

export class PiRpcProcessCleanupError extends Error {
  readonly code = PI_RPC_PROCESS_CLEANUP_UNCONFIRMED_CODE
  readonly data = Object.freeze({ code: PI_RPC_PROCESS_CLEANUP_UNCONFIRMED_CODE })

  constructor() {
    super('Pi process cleanup could not be confirmed after bounded graceful, TERM, and KILL attempts.')
    this.name = 'PiRpcProcessCleanupError'
  }
}

export function piRpcSpawnErrorData(error: PiRpcSpawnError): Record<string, unknown> {
  return {
    ...(error.code ? { code: error.code } : {}),
    ...(error.diagnostic ? { piAcp: { diagnostic: error.diagnostic } } : {})
  }
}

export type PiRpcExecuteCommandFailureCode = (typeof PI_RPC_EXECUTE_COMMAND_FAILURE_CODES)[number]

export type PiRpcExecuteCommandSuccess = Readonly<{
  success: true
  data: Readonly<{
    requestId: string
    name: string
    source: 'extension'
    sourceInfo: Readonly<Record<string, unknown>>
    disposition: 'handled' | 'agent_run'
  }>
}>

export type PiRpcExecuteCommandFailure = Readonly<{
  success: false
  error: string
  data: Readonly<{
    requestId: string
    name: string
    disposition: 'rejected'
    code: PiRpcExecuteCommandFailureCode
  }>
}>

export type PiRpcExecuteCommandResult = PiRpcExecuteCommandSuccess | PiRpcExecuteCommandFailure

export class PiRpcExecuteCommandProtocolError extends Error {
  readonly code = PI_RPC_EXECUTE_COMMAND_PROTOCOL_ERROR_CODE
  readonly data = Object.freeze({ code: PI_RPC_EXECUTE_COMMAND_PROTOCOL_ERROR_CODE })

  constructor(message = 'Pi returned an invalid execute_command response.') {
    super(message)
    this.name = 'PiRpcExecuteCommandProtocolError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function invalidExecuteCommandResponse(): never {
  throw new PiRpcExecuteCommandProtocolError()
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

export function validatePiRpcExecuteCommandResponse(
  response: unknown,
  requestId: string,
  name: string
): PiRpcExecuteCommandResult {
  if (!isRecord(response)) invalidExecuteCommandResponse()
  if (
    response.type !== 'response' ||
    response.id !== requestId ||
    response.command !== 'execute_command' ||
    typeof response.success !== 'boolean' ||
    !isRecord(response.data)
  ) {
    invalidExecuteCommandResponse()
  }

  const data = response.data
  if (data.requestId !== requestId || data.name !== name) invalidExecuteCommandResponse()

  if (response.success) {
    if (
      !hasExactKeys(data, ['requestId', 'name', 'source', 'sourceInfo', 'disposition']) ||
      response.error !== undefined ||
      data.source !== 'extension' ||
      (data.disposition !== 'handled' && data.disposition !== 'agent_run') ||
      !isRecord(data.sourceInfo) ||
      Object.keys(data.sourceInfo).length !== 0
    ) {
      invalidExecuteCommandResponse()
    }
    return Object.freeze({
      success: true,
      data: Object.freeze({
        requestId,
        name,
        source: 'extension',
        sourceInfo: Object.freeze({}),
        disposition: data.disposition
      })
    })
  }

  if (
    !hasExactKeys(data, ['requestId', 'name', 'disposition', 'code']) ||
    typeof response.error !== 'string' ||
    response.error.trim().length === 0 ||
    data.disposition !== 'rejected' ||
    typeof data.code !== 'string' ||
    !(PI_RPC_EXECUTE_COMMAND_FAILURE_CODES as readonly string[]).includes(data.code)
  ) {
    invalidExecuteCommandResponse()
  }

  return Object.freeze({
    success: false,
    error: response.error,
    data: Object.freeze({
      requestId,
      name,
      disposition: 'rejected',
      code: data.code as PiRpcExecuteCommandFailureCode
    })
  })
}

const ESC = String.fromCharCode(0x1b)
const CSI = String.fromCharCode(0x9b)

const ANSI_ESCAPE_REGEX = new RegExp(
  `[${ESC}${CSI}][[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]`,
  'g'
)

const PI_STDIN_TERMINATION_TIMEOUT_MS = 250

function stripAnsi(s: string): string {
  // Basic ANSI escape stripping (colors, cursor movement, etc.)
  return s.replace(ANSI_ESCAPE_REGEX, '')
}

type PiRpcCommand =
  | { type: 'prompt'; id?: string; message: string; images?: unknown[] }
  | { type: 'abort'; id?: string }
  | { type: 'get_state'; id?: string }
  // Model
  | { type: 'get_available_models'; id?: string }
  | { type: 'set_model'; id?: string; provider: string; modelId: string }
  // Thinking
  | { type: 'set_thinking_level'; id?: string; level: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' }
  // Modes
  | { type: 'set_follow_up_mode'; id?: string; mode: 'all' | 'one-at-a-time' }
  | { type: 'set_steering_mode'; id?: string; mode: 'all' | 'one-at-a-time' }
  // Compaction
  | { type: 'compact'; id?: string; customInstructions?: string }
  | { type: 'set_auto_compaction'; id?: string; enabled: boolean }
  // Session
  | { type: 'get_session_stats'; id?: string }
  | { type: 'set_session_name'; id?: string; name: string }
  | { type: 'export_html'; id?: string; outputPath?: string }
  | { type: 'switch_session'; id?: string; sessionPath: string }
  // Messages
  | { type: 'get_messages'; id?: string }
  // Commands
  | { type: 'get_commands'; id?: string }
  | { type: 'execute_command'; id?: string; name: string; args: string }

type PiRpcResponse = {
  type: 'response'
  id?: string
  command: string
  success: boolean
  data?: unknown
  error?: string
}

type PiExtensionUiResponse =
  | { id: string; value: string }
  | { id: string; confirmed: boolean }
  | { id: string; cancelled: true }

export type PiRpcEvent = Record<string, unknown>

type SpawnParams = {
  cwd: string
  /** Optional override for `pi` executable name/path */
  piCommand?: string
  /** If set, pi will persist the session to this exact file (via `--session <path>`). */
  sessionPath?: string
  /** Optional restore-only bound; the default startup behavior remains unchanged. */
  handshakeTimeoutMs?: number
}

type PiRpcTerminalCause = {
  kind: PiRpcProcessTerminationCause
  code?: number | null
  signal?: NodeJS.Signals | null
  error?: unknown
}

class PiRpcHandshakeTimedOut extends Error {}
class PiRpcHandshakeMissingState extends Error {}

export class PiRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<
    string,
    {
      resolve: (v: PiRpcResponse) => void
      reject: (e: unknown) => void
      accepts: (response: unknown) => boolean
    }
  >()
  private eventHandlers: Array<(ev: PiRpcEvent) => void> = []
  private readonly preludeLines: string[] = []
  private readonly startupDiagnosticCapture: PiStartupDiagnosticCapture
  private readonly stdoutReader: LfJsonlReader
  private stdoutEndHandled = false
  private startupComplete = false
  private terminalTriggered = false
  private terminalError: PiRpcProcessTerminatedError | undefined
  private terminalPromise: Promise<PiRpcProcessTerminatedError> | undefined
  private terminalCause: PiRpcTerminalCause | undefined
  private terminalCauseMayUpgrade = false
  private terminalCauseUpgraded = false
  private terminalCauseLocked = false
  private stdinFailurePromise: Promise<PiRpcProcessTerminatedError> | undefined
  private stdinErrorListener: ((error: Error) => void) | undefined
  private readonly terminalHandlers = new Set<(error: PiRpcProcessTerminatedError) => void>()
  private terminalPublished = false
  private stdoutQuarantined = false
  private teardownPromise: Promise<void> | undefined
  private stopPromise: Promise<void> | undefined
  private spawnErrorObserved = false
  private startupHandshakeState: unknown
  private startupHandshakeSucceeded = false

  private constructor(
    child: ChildProcessWithoutNullStreams,
    diagnosticOptions: { cwd: string; agentDir: string; env: Readonly<NodeJS.ProcessEnv> }
  ) {
    this.child = child
    this.startupDiagnosticCapture = new PiStartupDiagnosticCapture(diagnosticOptions)
    this.stdoutReader = new LfJsonlReader(record => this.handleStdoutRecord(record))

    // A write callback does not consume the Writable's `error` event. Own stdin's
    // error lifecycle before the first handshake write so EPIPE cannot escape as
    // an uncaught host-process exception.
    this.stdinErrorListener = error => {
      const failure = this.beginStdinFailure(error)
      // Requests observe this same promise below. The listener also has to make
      // the no-request case safe from an unhandled rejection.
      void failure.catch(() => undefined)
    }
    child.stdin.on('error', this.stdinErrorListener)
    child.stdin.once('close', () => {
      this.beginTerminal({ kind: 'stdin_closed' }, { provisional: true })
      this.detachStdinErrorListener()
    })

    child.stdout.on('data', (chunk: Buffer) => {
      // The reader checks its state between every record. If a record handler
      // synchronously terminalizes the process, later records from this same
      // chunk are discarded before they can cross the C1.3 ordering fence.
      if (this.stdoutQuarantined) return
      this.stdoutReader.push(chunk)
    })

    child.stdout.once('end', () => {
      this.handleStdoutEnd()
    })
    child.stdout.once('close', () => {
      // Normal Readable close follows end; clean EOF already promoted its one
      // optional final tail. A close without end is abnormal and discards it.
      if (this.stdoutEndHandled) return
      this.stdoutReader.discard()
      this.beginTerminal({ kind: 'stdout_eof' }, { provisional: true })
    })
    child.stdout.once('error', error => {
      this.stdoutReader.discard()
      this.beginTerminal({ kind: 'stdout_error', error }, { provisional: true })
    })

    child.stderr.on('data', chunk => {
      this.startupDiagnosticCapture.push(chunk)
    })

    child.on('exit', (code, signal) => {
      this.beginTerminal({ kind: 'exit', code, signal })
    })

    child.on('error', error => {
      if (typeof child.pid !== 'number') this.spawnErrorObserved = true
      this.beginTerminal({ kind: 'process_error', error })
    })
  }

  static async spawn(params: SpawnParams): Promise<PiRpcProcess> {
    if (
      params.handshakeTimeoutMs !== undefined &&
      (!Number.isFinite(params.handshakeTimeoutMs) || params.handshakeTimeoutMs <= 0)
    ) {
      throw new RangeError('handshakeTimeoutMs must be a finite positive number')
    }

    // On Windows, npm commonly creates pi.cmd / pi.bat launcher scripts.
    const cmd = getPiCommand(params.piCommand)

    // Speed/robustness for ACP:
    // - themes are irrelevant in rpc mode and can be noisy/slow to load.
    // Keep extensions + prompt templates enabled because ACP users may rely on them
    // (e.g. MCP extensions, prompt templates for workflows).
    const args = ['--mode', 'rpc', '--no-themes', PI_RPC_PROJECT_TRUST_POLICY.cliArgument]
    if (params.sessionPath) args.push('--session', params.sessionPath)

    const child = spawn(cmd, args, {
      cwd: params.cwd,
      stdio: 'pipe',
      env: process.env,
      shell: shouldUseShellForPiCommand(cmd)
    })
    const agentDir =
      process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? process.env.USERPROFILE ?? homedir(), '.pi', 'agent')
    const proc = new PiRpcProcess(child, {
      cwd: params.cwd,
      agentDir,
      env: process.env
    })

    // Ensure spawn failures (e.g. ENOENT when pi isn't installed) are surfaced as a
    // deterministic error instead of later EPIPE/internal-error noise.
    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          cleanup()
          resolve()
        }
        const onError = (err: any) => {
          cleanup()
          reject(err)
        }
        const cleanup = () => {
          child.off('spawn', onSpawn)
          child.off('error', onError)
        }

        child.once('spawn', onSpawn)
        child.once('error', onError)
      })
    } catch (e: any) {
      const code = typeof e?.code === 'string' ? e.code : undefined
      if (code === 'ENOENT') {
        throw new PiRpcSpawnError(
          `Could not start pi: executable not found (command: ${cmd}). Pi needs to be installed before it can run in ACP clients. Install it via \`npm install -g @earendil-works/pi-coding-agent\` or ensure \`pi\` is on your PATH. Then try again.`,
          { code, cause: e }
        )
      }

      if (code === 'EACCES') {
        throw new PiRpcSpawnError(`Could not start pi: permission denied (command: ${cmd}).`, { code, cause: e })
      }

      throw new PiRpcSpawnError(`Could not start pi (command: ${cmd}).`, { code, cause: e })
    }

    // Best-effort handshake.
    // Important: pi may emit a get_state response pointing at a sessionFile in a directory
    // that is created lazily. Create the parent dir up-front to avoid later parse errors
    // when we call commands like export_html.
    try {
      const state = (await withOptionalHandshakeTimeout(proc.getState(), params.handshakeTimeoutMs)) as any
      if (state === null || state === undefined) {
        throw new PiRpcHandshakeMissingState('Pi RPC startup handshake returned no state.')
      }
      proc.startupHandshakeState = state
      proc.startupHandshakeSucceeded = true
      const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null
      if (sessionFile) {
        const { mkdirSync } = await import('node:fs')
        const { dirname } = await import('node:path')
        mkdirSync(dirname(sessionFile), { recursive: true })
      }
    } catch (error) {
      if (error instanceof PiRpcHandshakeTimedOut) {
        let cause: unknown = error
        let candidate: PiRpcProcess | undefined
        try {
          await proc.stop()
        } catch (cleanupError) {
          cause = cleanupError
          candidate = proc
        }
        throw new PiRpcSpawnError('Pi RPC startup handshake timed out before get_state completed.', {
          code: PI_RPC_HANDSHAKE_TIMEOUT_CODE,
          cause,
          candidate
        })
      }

      const terminal = await proc.preferTerminalError(error)
      if (terminal) throw proc.toSpawnError(terminal)
      if (params.handshakeTimeoutMs !== undefined) {
        let cause: unknown = error
        let candidate: PiRpcProcess | undefined
        try {
          await proc.stop()
        } catch (cleanupError) {
          cause = cleanupError
          candidate = proc
        }
        throw new PiRpcSpawnError('Pi RPC startup handshake failed before get_state completed.', {
          code: PI_RPC_HANDSHAKE_FAILED_CODE,
          cause,
          candidate
        })
      }
      // A live Pi may reject get_state while still accepting later RPC requests.
    }

    if (!proc.terminalPromise && proc.hasExited()) {
      proc.beginTerminal({
        kind: 'exit',
        code: child.exitCode,
        signal: child.signalCode
      })
    }
    if (proc.terminalPromise) {
      const terminal = await proc.terminalPromise
      throw proc.toSpawnError(terminal)
    }

    proc.startupComplete = true
    proc.startupDiagnosticCapture.discard()
    return proc
  }

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    if (this.terminalTriggered) return () => undefined
    this.eventHandlers.push(handler)
    return () => {
      this.eventHandlers = this.eventHandlers.filter(h => h !== handler)
    }
  }

  /**
   * Subscribe to the single terminal transition. A late subscriber receives the
   * exact cached error on a microtask, so constructor-time subscriptions and
   * restoration races cannot miss the transition.
   */
  onTerminal(handler: (error: PiRpcProcessTerminatedError) => void): () => void {
    let active = true
    if (this.terminalPublished && this.terminalError) {
      const error = this.terminalError
      queueMicrotask(() => {
        if (!active) return
        try {
          handler(error)
        } catch {
          // A lifecycle observer must not destabilize transport cleanup.
        }
      })
    } else {
      this.terminalHandlers.add(handler)
    }

    return () => {
      active = false
      this.terminalHandlers.delete(handler)
    }
  }

  /** Synchronous conservative liveness check used before accepting fresh work. */
  isAlive(): boolean {
    if (this.terminalTriggered || this.stdinFailurePromise || this.stopPromise) return false

    if (this.hasExited()) {
      this.beginTerminal({
        kind: 'exit',
        code: this.child.exitCode,
        signal: this.child.signalCode
      })
      return false
    }

    if (this.child.stdin.destroyed || this.child.stdin.writableEnded) {
      this.beginTerminal({ kind: 'stdin_closed' }, { provisional: true })
      return false
    }

    if (this.child.stdout.destroyed || this.child.stdout.readableEnded) {
      if (this.child.stdout.readableEnded) this.handleStdoutEnd()
      else {
        this.stdoutReader.discard()
        this.beginTerminal({ kind: 'stdout_eof' }, { provisional: true })
      }
      return false
    }

    return true
  }

  /**
   * Gracefully closes stdin, then applies bounded TERM/KILL escalation to the
   * direct Pi child. Pi inherits the adapter process group so the outer ACP
   * harness remains the containment boundary for the whole tree.
   */
  stop(): Promise<void> {
    if (!this.stopPromise) {
      if (!this.terminalTriggered) this.beginTerminal({ kind: 'stopped' }, { provisional: true })
      const attempt = this.ensureChildStopped()
      this.stopPromise = attempt
      const clearAttempt = (): void => {
        if (this.stopPromise === attempt) this.stopPromise = undefined
      }
      void attempt.then(clearAttempt, clearAttempt)
    }
    return this.stopPromise
  }

  /** @deprecated Prefer awaiting stop(). */
  dispose(_signal: NodeJS.Signals | number = 'SIGTERM'): void {
    void this.stop().catch(() => undefined)
  }

  /**
   * Human-readable stdout lines emitted before RPC NDJSON begins (e.g. Context/Skills/Extensions info).
   * Themes are typically noisy/less useful for ACP, so callers can filter as needed.
   */
  consumePreludeLines(): string[] {
    const lines = this.preludeLines.splice(0, this.preludeLines.length)
    return lines
  }

  private handleStdoutRecord(line: string): boolean {
    // Observation order is authoritative: once a terminal trigger wins, even
    // bytes written earlier but delivered by the stream later are quarantined.
    if (this.stdoutQuarantined || this.terminalTriggered) return false
    if (!line.trim()) return true

    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      // Pi may emit a human-readable prelude on stdout before JSONL starts.
      // Capture it so the ACP adapter can surface it on session start.
      const cleaned = stripAnsi(line).trimEnd()
      if (cleaned) this.preludeLines.push(cleaned)
      return !this.terminalTriggered
    }

    if (msg?.type === 'response') {
      const id = typeof msg.id === 'string' ? msg.id : undefined
      if (id) {
        const pending = this.pending.get(id)
        if (pending?.accepts(msg)) {
          this.pending.delete(id)
          pending.resolve(msg as PiRpcResponse)
          return !this.terminalTriggered
        }
      }
      // Unknown, duplicate, or malformed responses are transport records,
      // never Pi events. Do not leak them into ACP session event handling.
      return !this.terminalTriggered
    }

    // Snapshot the subscribers for deterministic same-record delivery, but
    // re-check the synchronous terminal latch before every callback. A handler
    // may call stop(), which also quarantines later records in the same chunk.
    const handlers = [...this.eventHandlers]
    for (const handler of handlers) {
      if (this.terminalTriggered) break
      handler(msg as PiRpcEvent)
    }
    return !this.terminalTriggered
  }

  private handleStdoutEnd(): void {
    if (this.stdoutEndHandled) return
    this.stdoutEndHandled = true

    if (this.terminalTriggered || this.stdoutQuarantined) {
      this.stdoutReader.discard()
      return
    }

    // Clean end is the sole partial-tail promotion path. decoder.end() applies
    // normal U+FFFD replacement semantics before the record is synchronously
    // admitted; only then may stdout_eof claim the remaining pending work.
    this.stdoutReader.finish()
    if (!this.terminalTriggered) this.beginTerminal({ kind: 'stdout_eof' }, { provisional: true })
  }

  /** Exact successful get_state captured by spawn(); no caller can replace it. */
  getStartupHandshakeState(): unknown | undefined {
    return this.startupHandshakeSucceeded ? this.startupHandshakeState : undefined
  }

  supportsExecuteCommand(): boolean {
    const state = this.getStartupHandshakeState() as
      | { rpcCapabilities?: { executeCommand?: unknown } }
      | null
      | undefined
    return state?.rpcCapabilities?.executeCommand === 1
  }

  async prompt(message: string, images: unknown[] = []): Promise<void> {
    const res = await this.request({ type: 'prompt', message, images })
    if (!res.success) throw new Error(`pi prompt failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async abort(): Promise<void> {
    const res = await this.request({ type: 'abort' })
    if (!res.success) throw new Error(`pi abort failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async getState(): Promise<unknown> {
    const res = await this.request({ type: 'get_state' })
    if (!res.success) throw new Error(`pi get_state failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getAvailableModels(): Promise<unknown> {
    const res = await this.request({ type: 'get_available_models' })
    if (!res.success) throw new Error(`pi get_available_models failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setModel(provider: string, modelId: string): Promise<unknown> {
    const res = await this.request({ type: 'set_model', provider, modelId })
    if (!res.success) throw new Error(`pi set_model failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setThinkingLevel(level: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'): Promise<void> {
    const res = await this.request({ type: 'set_thinking_level', level })
    if (!res.success) throw new Error(`pi set_thinking_level failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async setFollowUpMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
    const res = await this.request({ type: 'set_follow_up_mode', mode })
    if (!res.success) throw new Error(`pi set_follow_up_mode failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async setSteeringMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
    const res = await this.request({ type: 'set_steering_mode', mode })
    if (!res.success) throw new Error(`pi set_steering_mode failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async compact(customInstructions?: string): Promise<unknown> {
    const res = await this.request({ type: 'compact', customInstructions })
    if (!res.success) throw new Error(`pi compact failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    const res = await this.request({ type: 'set_auto_compaction', enabled })
    if (!res.success) throw new Error(`pi set_auto_compaction failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async getSessionStats(): Promise<unknown> {
    const res = await this.request({ type: 'get_session_stats' })
    if (!res.success) throw new Error(`pi get_session_stats failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setSessionName(name: string): Promise<void> {
    const res = await this.request({ type: 'set_session_name', name })
    if (!res.success) throw new Error(`pi set_session_name failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async exportHtml(outputPath?: string): Promise<{ path: string }> {
    const res = await this.request({ type: 'export_html', outputPath })
    if (!res.success) throw new Error(`pi export_html failed: ${res.error ?? JSON.stringify(res.data)}`)
    const data: any = res.data
    return { path: String(data?.path ?? '') }
  }

  async switchSession(sessionPath: string): Promise<void> {
    const res = await this.request({ type: 'switch_session', sessionPath })
    if (!res.success) throw new Error(`pi switch_session failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async getMessages(): Promise<unknown> {
    const res = await this.request({ type: 'get_messages' })
    if (!res.success) throw new Error(`pi get_messages failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getCommands(): Promise<unknown> {
    const res = await this.request({ type: 'get_commands' })
    if (!res.success) throw new Error(`pi get_commands failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async executeCommand(requestId: string, name: string, args: string): Promise<PiRpcExecuteCommandResult> {
    if (!requestId || !name || typeof args !== 'string') {
      throw new PiRpcExecuteCommandProtocolError('Invalid execute_command request identity or arguments.')
    }
    const response = await this.request({ type: 'execute_command', name, args }, requestId, candidate => {
      try {
        validatePiRpcExecuteCommandResponse(candidate, requestId, name)
        return true
      } catch {
        return false
      }
    })
    return validatePiRpcExecuteCommandResponse(response, requestId, name)
  }

  async sendExtensionUiResponse(response: PiExtensionUiResponse): Promise<void> {
    await this.writeLine(`${JSON.stringify({ type: 'extension_ui_response', ...response })}\n`)
  }

  private request(
    cmd: PiRpcCommand,
    requestId?: string,
    accepts: (response: unknown) => boolean = () => true
  ): Promise<PiRpcResponse> {
    if (this.terminalTriggered) {
      return this.terminalPromise!.then(error => {
        throw error
      })
    }

    const id = requestId ?? crypto.randomUUID()
    if (this.pending.has(id)) {
      return Promise.reject(new PiRpcExecuteCommandProtocolError('Duplicate Pi RPC request identity.'))
    }
    const withId = { ...cmd, id }

    const line = `${JSON.stringify(withId)}\n`

    return new Promise<PiRpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, accepts })

      void this.writeLine(line).catch(error => {
        // The terminal publisher normally rejects every entry together. The
        // fallback covers a response racing this individual write failure.
        if (this.pending.delete(id)) reject(error)
      })
    })
  }

  private writeLine(line: string): Promise<void> {
    return (async () => {
      if (this.terminalTriggered) throw await this.terminalPromise!
      if (this.stdinFailurePromise) throw await this.stdinFailurePromise

      try {
        await new Promise<void>((resolve, reject) => {
          try {
            this.child.stdin.write(line, error => {
              if (error) {
                reject(error)
                return
              }

              resolve()
            })
          } catch (error: unknown) {
            reject(error)
          }
        })
      } catch (error) {
        // Every failed write poisons the channel, not only platform-specific
        // EPIPE spellings. A write may have been partially accepted, so it is
        // never safe to replay the operation automatically.
        throw await this.beginStdinFailure(error)
      }
    })()
  }

  private beginTerminal(cause: PiRpcTerminalCause, options: { provisional?: boolean } = {}): void {
    if (this.terminalTriggered) {
      if (this.terminalCauseMayUpgrade && !this.terminalCauseLocked && !options.provisional) {
        this.terminalCause = cause
        this.terminalCauseUpgraded = true
      }
      return
    }

    // Phase one is synchronous. Whichever observation reaches this method
    // first fences all writes and stdout callbacks and detaches the exact raw
    // requests that the terminal record owns. A response that removed its ID
    // before this point has already won; buffered bytes delivered later lose.
    this.terminalTriggered = true
    this.stdoutQuarantined = true
    this.stdoutReader.discard()
    this.eventHandlers = []
    const terminalPending = [...this.pending.values()]
    this.pending.clear()

    const duringStartup = !this.startupComplete
    this.terminalCause = cause
    this.terminalCauseMayUpgrade = options.provisional === true

    let resolveTerminal!: (error: PiRpcProcessTerminatedError) => void
    this.terminalPromise = new Promise(resolve => {
      resolveTerminal = resolve
    })
    void this.finalizeTerminal(cause, duringStartup, terminalPending).then(resolveTerminal)

    // Cleanup is intentionally independent from publication. Consumers learn
    // the causal error without waiting for graceful/TERM/KILL arbitration, while
    // stop() can separately require confirmed direct-child termination.
    void this.ensureChildStopped().catch(() => undefined)
  }

  private async finalizeTerminal(
    initialCause: PiRpcTerminalCause,
    duringStartup: boolean,
    terminalPending: Array<{ resolve: (v: PiRpcResponse) => void; reject: (e: unknown) => void }>
  ): Promise<PiRpcProcessTerminatedError> {
    if (duringStartup) {
      await this.waitForStderrDrain()
      await this.waitForProvisionalCauseUpgrade()
      // If a real child terminal event replaced the provisional transport
      // failure, give that authoritative event its own bounded stderr drain.
      if (this.terminalCauseMayUpgrade && this.terminalCauseUpgraded) {
        await this.waitForStderrDrain()
      }
    }

    this.terminalCauseLocked = true
    const resolvedCause = this.terminalCause ?? initialCause
    // Broken-pipe metadata is an internal arbitration trigger, not a useful Pi
    // startup diagnosis. Only publish it when a real child exit/error upgraded
    // the provisional cause; otherwise use the safe generic fallback.
    const diagnosticCause = this.terminalCauseMayUpgrade && !this.terminalCauseUpgraded ? {} : resolvedCause
    const diagnostic = duringStartup ? this.startupDiagnosticCapture.finalize(diagnosticCause) : undefined
    const error = new PiRpcProcessTerminatedError(
      diagnostic?.summary ??
        'Pi process terminated before the RPC operation completed. The operation was not replayed; start a new request to restore the session.',
      diagnostic,
      resolvedCause
    )
    this.terminalError = error
    this.publishTerminal(error)
    for (const pending of terminalPending) pending.reject(error)
    return error
  }

  private async preferTerminalError(error: unknown): Promise<PiRpcProcessTerminatedError | undefined> {
    if (!this.terminalPromise && this.hasExited()) {
      this.beginTerminal({
        kind: 'exit',
        code: this.child.exitCode,
        signal: this.child.signalCode
      })
    }

    if (!this.terminalPromise && (this.stdinFailurePromise || isBrokenPipeError(error))) {
      return await this.beginStdinFailure(error)
    }

    return this.terminalPromise ? await this.terminalPromise : this.terminalError
  }

  private toSpawnError(terminal: PiRpcProcessTerminatedError): PiRpcSpawnError {
    return new PiRpcSpawnError(terminal.diagnostic?.summary ?? terminal.message, {
      code: terminal.diagnostic?.code ?? terminal.code,
      cause: terminal,
      diagnostic: terminal.diagnostic,
      candidate: this.hasConfirmedTermination() ? undefined : this
    })
  }

  private beginStdinFailure(error: unknown): Promise<PiRpcProcessTerminatedError> {
    if (!this.stdinFailurePromise) {
      this.stdinFailurePromise = (async () => {
        if (!this.terminalTriggered) {
          this.beginTerminal(
            {
              kind: 'stdin_write_failure',
              code: this.child.exitCode,
              signal: this.child.signalCode,
              error
            },
            { provisional: true }
          )
        }

        return await this.terminalPromise!
      })()
    }

    return this.stdinFailurePromise
  }

  private detachStdinErrorListener(): void {
    if (!this.stdinErrorListener) return
    this.child.stdin.off('error', this.stdinErrorListener)
    this.stdinErrorListener = undefined
  }

  private hasExited(): boolean {
    return this.child.exitCode !== null || this.child.signalCode !== null
  }

  private ensureChildStopped(): Promise<void> {
    if (!this.teardownPromise) {
      const attempt = (async () => {
        if (this.hasConfirmedTermination()) return

        this.closeStdinGracefully()
        await this.waitForChildTermination(PI_STDIN_TERMINATION_TIMEOUT_MS)
        if (this.hasConfirmedTermination()) return

        this.killChild('SIGTERM')
        await this.waitForChildTermination(PI_STDIN_TERMINATION_TIMEOUT_MS)
        if (this.hasConfirmedTermination()) return

        this.killChild('SIGKILL')
        await this.waitForChildTermination(PI_STDIN_TERMINATION_TIMEOUT_MS)
        if (!this.hasConfirmedTermination()) throw new PiRpcProcessCleanupError()
      })()
      this.teardownPromise = attempt
      const clearAttempt = (): void => {
        if (this.teardownPromise === attempt) this.teardownPromise = undefined
      }
      void attempt.then(clearAttempt, clearAttempt)
    }
    return this.teardownPromise
  }

  private closeStdinGracefully(): void {
    if (this.child.stdin.destroyed || this.child.stdin.writableEnded) return
    try {
      this.child.stdin.end()
    } catch (error) {
      // The terminal transition has already been claimed. Preserve its cached
      // public error while still consuming a synchronous stream failure.
      const failure = this.beginStdinFailure(error)
      void failure.catch(() => undefined)
    }
  }

  private async waitForProvisionalCauseUpgrade(): Promise<void> {
    if (!this.terminalCauseMayUpgrade || this.terminalCauseUpgraded) return

    if (!this.hasExited()) {
      await new Promise<void>(resolve => {
        let settled = false
        const finish = (): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          this.child.off('exit', finish)
          this.child.off('error', finish)
          resolve()
        }
        const timer = setTimeout(finish, PI_STARTUP_STDERR_DRAIN_TIMEOUT_MS)
        timer.unref()
        this.child.once('exit', finish)
        this.child.once('error', finish)
      })
    }

    if (!this.terminalCauseUpgraded && this.hasExited()) {
      this.terminalCause = {
        kind: 'exit',
        code: this.child.exitCode,
        signal: this.child.signalCode
      }
      this.terminalCauseUpgraded = true
    }
  }

  private killChild(signal: NodeJS.Signals): void {
    try {
      this.child.kill(signal)
    } catch {
      // The bounded exit wait below arbitrates a concurrent exit or escalates.
    }
  }

  private hasConfirmedTermination(): boolean {
    return this.spawnErrorObserved || this.hasExited()
  }

  private async waitForChildTermination(timeoutMs: number): Promise<void> {
    if (this.hasConfirmedTermination()) return

    await new Promise<void>(resolve => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.child.off('exit', finish)
        this.child.off('error', finish)
        resolve()
      }
      const timer = setTimeout(finish, timeoutMs)
      timer.unref()
      this.child.once('exit', finish)
      this.child.once('error', finish)
    })
  }

  private async waitForStderrDrain(): Promise<void> {
    if (this.child.stderr.readableEnded || this.child.stderr.destroyed) return

    await new Promise<void>(resolve => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.child.stderr.off('end', finish)
        this.child.stderr.off('close', finish)
        this.child.stderr.off('error', finish)
        resolve()
      }
      const timer = setTimeout(finish, PI_STARTUP_STDERR_DRAIN_TIMEOUT_MS)
      timer.unref()
      this.child.stderr.once('end', finish)
      this.child.stderr.once('close', finish)
      this.child.stderr.once('error', finish)
    })
  }

  private publishTerminal(error: PiRpcProcessTerminatedError): void {
    if (this.terminalPublished) return
    this.terminalPublished = true
    const handlers = [...this.terminalHandlers]
    this.terminalHandlers.clear()
    for (const handler of handlers) {
      try {
        handler(error)
      } catch {
        // Lifecycle observers are isolated from transport finalization.
      }
    }
  }
}

function isBrokenPipeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = 'code' in error ? (error as { code?: unknown }).code : undefined
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ERR_INVALID_STATE'
}

async function withOptionalHandshakeTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined): Promise<T> {
  if (timeoutMs === undefined) return await promise

  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new PiRpcHandshakeTimedOut()), timeoutMs)
        timer.unref()
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
