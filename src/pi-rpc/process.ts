import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as readline from 'node:readline'
import { getPiCommand, shouldUseShellForPiCommand } from './command.js'
import {
  PI_STARTUP_STDERR_DRAIN_TIMEOUT_MS,
  PiStartupDiagnosticCapture,
  type PiStartupDiagnostic
} from './diagnostics.js'

export class PiRpcSpawnError extends Error {
  /** Stable spawn/diagnostic code, e.g. ENOENT or PI_EXTENSION_LOAD_FAILED. */
  code?: string
  readonly diagnostic?: Readonly<PiStartupDiagnostic>

  constructor(message: string, opts?: { code?: string; cause?: unknown; diagnostic?: Readonly<PiStartupDiagnostic> }) {
    super(message)
    this.name = 'PiRpcSpawnError'
    this.code = opts?.code
    this.diagnostic = opts?.diagnostic
    ;(this as any).cause = opts?.cause
  }
}

export class PiRpcProcessTerminatedError extends Error {
  constructor(
    message: string,
    readonly diagnostic?: Readonly<PiStartupDiagnostic>
  ) {
    super(message)
    this.name = 'PiRpcProcessTerminatedError'
  }
}

export function piRpcSpawnErrorData(error: PiRpcSpawnError): Record<string, unknown> {
  return {
    ...(error.code ? { code: error.code } : {}),
    ...(error.diagnostic ? { piAcp: { diagnostic: error.diagnostic } } : {})
  }
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
}

type PiRpcTerminalCause = {
  code?: number | null
  signal?: NodeJS.Signals | null
  error?: unknown
}

export class PiRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<string, { resolve: (v: PiRpcResponse) => void; reject: (e: unknown) => void }>()
  private eventHandlers: Array<(ev: PiRpcEvent) => void> = []
  private readonly preludeLines: string[] = []
  private readonly startupDiagnosticCapture: PiStartupDiagnosticCapture
  private startupComplete = false
  private terminalError: PiRpcProcessTerminatedError | undefined
  private terminalPromise: Promise<PiRpcProcessTerminatedError> | undefined
  private terminalCause: PiRpcTerminalCause | undefined
  private terminalCauseMayUpgrade = false
  private terminalCauseUpgraded = false
  private terminalCauseLocked = false
  private stdinFailurePromise: Promise<PiRpcProcessTerminatedError> | undefined
  private stdinErrorListener: ((error: Error) => void) | undefined

  private constructor(
    child: ChildProcessWithoutNullStreams,
    diagnosticOptions: { cwd: string; agentDir: string; env: Readonly<NodeJS.ProcessEnv> }
  ) {
    this.child = child
    this.startupDiagnosticCapture = new PiStartupDiagnosticCapture(diagnosticOptions)

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
      this.detachStdinErrorListener()
    })

    const rl = readline.createInterface({ input: child.stdout })
    rl.on('line', line => {
      if (!line.trim()) return
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        // pi may emit a human-readable prelude on stdout before NDJSON starts.
        // Capture it so the ACP adapter can surface it on session start.
        const cleaned = stripAnsi(String(line)).trimEnd()
        if (cleaned) this.preludeLines.push(cleaned)
        return
      }

      if (msg?.type === 'response') {
        const id = typeof msg.id === 'string' ? msg.id : undefined
        if (id) {
          const pending = this.pending.get(id)
          if (pending) {
            this.pending.delete(id)
            pending.resolve(msg as PiRpcResponse)
            return
          }
        }
      }

      for (const h of this.eventHandlers) h(msg as PiRpcEvent)
    })

    child.stderr.on('data', chunk => {
      this.startupDiagnosticCapture.push(chunk)
    })

    child.on('exit', (code, signal) => {
      this.beginTerminal({ code, signal })
    })

    child.on('error', error => {
      this.beginTerminal({ error })
    })
  }

  static async spawn(params: SpawnParams): Promise<PiRpcProcess> {
    // On Windows, npm commonly creates pi.cmd / pi.bat launcher scripts.
    const cmd = getPiCommand(params.piCommand)

    // Speed/robustness for ACP:
    // - themes are irrelevant in rpc mode and can be noisy/slow to load.
    // Keep extensions + prompt templates enabled because ACP users may rely on them
    // (e.g. MCP extensions, prompt templates for workflows).
    const args = ['--mode', 'rpc', '--no-themes']
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
      const state = (await proc.getState()) as any
      const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null
      if (sessionFile) {
        const { mkdirSync } = await import('node:fs')
        const { dirname } = await import('node:path')
        mkdirSync(dirname(sessionFile), { recursive: true })
      }
    } catch (error) {
      const terminal = await proc.preferTerminalError(error)
      if (terminal?.diagnostic) {
        throw new PiRpcSpawnError(terminal.diagnostic.summary, {
          code: terminal.diagnostic.code,
          cause: terminal,
          diagnostic: terminal.diagnostic
        })
      }
      // A live Pi may reject get_state while still accepting later RPC requests.
    }

    if (!proc.terminalPromise && proc.hasExited()) {
      proc.beginTerminal({
        code: child.exitCode,
        signal: child.signalCode
      })
    }
    if (proc.terminalPromise) {
      const terminal = await proc.terminalPromise
      if (terminal.diagnostic) {
        throw new PiRpcSpawnError(terminal.diagnostic.summary, {
          code: terminal.diagnostic.code,
          cause: terminal,
          diagnostic: terminal.diagnostic
        })
      }
    }

    proc.startupComplete = true
    proc.startupDiagnosticCapture.discard()
    return proc
  }

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.eventHandlers.push(handler)
    return () => {
      this.eventHandlers = this.eventHandlers.filter(h => h !== handler)
    }
  }

  dispose(signal: NodeJS.Signals | number = 'SIGTERM'): void {
    if (this.child.killed) return
    try {
      this.child.kill(signal as any)
    } catch {
      // ignore
    }
  }

  /**
   * Human-readable stdout lines emitted before RPC NDJSON begins (e.g. Context/Skills/Extensions info).
   * Themes are typically noisy/less useful for ACP, so callers can filter as needed.
   */
  consumePreludeLines(): string[] {
    const lines = this.preludeLines.splice(0, this.preludeLines.length)
    return lines
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

  async sendExtensionUiResponse(response: PiExtensionUiResponse): Promise<void> {
    await this.writeLine(`${JSON.stringify({ type: 'extension_ui_response', ...response })}\n`)
  }

  private request(cmd: PiRpcCommand): Promise<PiRpcResponse> {
    const id = crypto.randomUUID()
    const withId = { ...cmd, id }

    const line = `${JSON.stringify(withId)}\n`

    return new Promise<PiRpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })

      void this.writeLine(line).catch(error => {
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  private writeLine(line: string): Promise<void> {
    return (async () => {
      if (this.terminalPromise) throw await this.terminalPromise
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
        throw (await this.preferTerminalError(error)) ?? error
      }
    })()
  }

  private beginTerminal(
    cause: PiRpcTerminalCause,
    options: { provisional?: boolean; teardownLiveChild?: boolean } = {}
  ): void {
    if (this.terminalPromise) {
      if (this.terminalCauseMayUpgrade && !this.terminalCauseLocked && !options.provisional) {
        this.terminalCause = cause
        this.terminalCauseUpgraded = true
      }
      return
    }

    const duringStartup = !this.startupComplete
    this.terminalCause = cause
    this.terminalCauseMayUpgrade = options.provisional === true
    this.terminalPromise = (async () => {
      if (duringStartup) {
        await this.waitForStderrDrain()
        await this.waitForProvisionalCauseUpgrade()
        // If a real child terminal event replaced the provisional transport
        // failure, give that authoritative event its own bounded stderr drain.
        // The first window may have expired before the exit and must not count
        // against the drain promised for the upgraded cause.
        if (this.terminalCauseMayUpgrade && this.terminalCauseUpgraded) {
          await this.waitForStderrDrain()
        }
      }

      this.terminalCauseLocked = true
      const resolvedCause = this.terminalCause ?? cause
      // Broken-pipe metadata is an internal arbitration trigger, not a useful Pi
      // startup diagnosis. Only publish it when a real child exit/error upgraded
      // the provisional cause; otherwise use the safe generic fallback.
      const publicCause = this.terminalCauseMayUpgrade && !this.terminalCauseUpgraded ? {} : resolvedCause
      const diagnostic = duringStartup ? this.startupDiagnosticCapture.finalize(publicCause) : undefined
      const error = new PiRpcProcessTerminatedError(
        diagnostic?.summary ??
          `pi process exited (code=${String(publicCause.code ?? null)}, signal=${String(publicCause.signal ?? null)})`,
        diagnostic
      )
      this.terminalError = error
      if (options.teardownLiveChild) await this.terminateLiveChild()
      for (const [, pending] of this.pending) pending.reject(error)
      this.pending.clear()
      return error
    })()
  }

  private async preferTerminalError(error: unknown): Promise<PiRpcProcessTerminatedError | undefined> {
    if (!this.terminalPromise && this.hasExited()) {
      this.beginTerminal({
        code: this.child.exitCode,
        signal: this.child.signalCode
      })
    }

    if (!this.terminalPromise && (this.stdinFailurePromise || isBrokenPipeError(error))) {
      return await this.beginStdinFailure(error)
    }

    return this.terminalPromise ? await this.terminalPromise : this.terminalError
  }

  private beginStdinFailure(error: unknown): Promise<PiRpcProcessTerminatedError> {
    if (!this.stdinFailurePromise) {
      this.stdinFailurePromise = (async () => {
        if (!this.terminalPromise) await this.waitForTerminalSignal()

        if (!this.terminalPromise) {
          this.beginTerminal(
            {
              code: this.child.exitCode,
              signal: this.child.signalCode,
              error
            },
            { provisional: true, teardownLiveChild: true }
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

  private async waitForTerminalSignal(): Promise<void> {
    if (this.terminalPromise || this.hasExited()) return

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

    if (!this.terminalPromise && this.hasExited()) {
      this.beginTerminal({
        code: this.child.exitCode,
        signal: this.child.signalCode
      })
    }
  }

  private async terminateLiveChild(): Promise<void> {
    if (this.hasExited()) return

    this.killChild('SIGTERM')
    await this.waitForChildExit(PI_STDIN_TERMINATION_TIMEOUT_MS)
    if (this.hasExited()) return

    this.killChild('SIGKILL')
    await this.waitForChildExit(PI_STDIN_TERMINATION_TIMEOUT_MS)
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

  private async waitForChildExit(timeoutMs: number): Promise<void> {
    if (this.hasExited()) return

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
}

function isBrokenPipeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = 'code' in error ? (error as { code?: unknown }).code : undefined
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ERR_INVALID_STATE'
}
