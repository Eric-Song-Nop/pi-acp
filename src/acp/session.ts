import type {
  AgentSideConnection,
  ContentBlock,
  McpServer,
  PermissionOption,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolKind
} from '@agentclientprotocol/sdk'
import { RequestError } from '@agentclientprotocol/sdk'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import { formatPiRuntimeExtensionError } from '../pi-rpc/diagnostics.js'
import {
  PI_RPC_PROCESS_TERMINATED_CODE,
  PiRpcProcess,
  PiRpcProcessTerminatedError,
  PiRpcSpawnError,
  piRpcSpawnErrorData,
  type PiRpcEvent
} from '../pi-rpc/process.js'
import { maybeAuthRequiredError } from './auth-required.js'
import { SessionStore } from './session-store.js'
import {
  bashCommand,
  bashExitCode,
  bashOutputDelta,
  bashResultText,
  bashTerminalContent,
  bashTerminalExitMeta,
  bashTerminalInfoMeta,
  bashTerminalOutputMeta,
  isBashTool
} from './translate/bash.js'
import { toolResultToText } from './translate/pi-tools.js'

type SessionCreateParams = {
  cwd: string
  mcpServers: McpServer[]
  conn: AgentSideConnection
  /** @deprecated Retained as an inert construction shim for downstream tests. */
  fileCommands?: unknown[]
  piCommand?: string
}

export type StopReason = 'end_turn' | 'cancelled'

type TurnClaim = { kind: 'settled'; reason: StopReason } | { kind: 'failed'; error: RequestError }

type PromptTurn = {
  readonly id: number
  readonly message: string
  readonly images: unknown[]
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
  cancelRequested: boolean
  claim: TurnClaim | null
  completed: boolean
  completionBarrier: Promise<void> | null
  completionBatch: PromptTurn[] | null
  requiresAgentStart: boolean
  agentStarted: boolean
}

type PermissionResponse = Awaited<ReturnType<AgentSideConnection['requestPermission']>>

const CONFIRM_PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
  { optionId: 'no', name: 'No', kind: 'reject_once' }
]
const EXTENSION_UI_RAW_INPUT_KEYS = ['title', 'message', 'options', 'placeholder', 'prefill'] as const
const CHOICE_OPTION_PREFIX = 'choice-'

/** Terminal failures cannot wait forever for a client notification sink. */
export const TERMINAL_UPDATE_FLUSH_TIMEOUT_MS = 500

export function piRpcProcessRequestError(error: PiRpcProcessTerminatedError): RequestError {
  const data =
    (error as PiRpcProcessTerminatedError & { data?: unknown }).data ??
    Object.freeze({ code: PI_RPC_PROCESS_TERMINATED_CODE })
  return new RequestError(-32603, error.message, data)
}

function promptRequestError(error: unknown): RequestError {
  if (error instanceof RequestError) return error

  const authError = maybeAuthRequiredError(error)
  if (authError) return authError

  return RequestError.internalError(
    { code: 'PI_PROMPT_FAILED' },
    'Pi did not accept the prompt command; the prompt was not replayed.'
  )
}

function findUniqueLineNumber(text: string, needle: string): number | undefined {
  if (!needle) return undefined

  const first = text.indexOf(needle)
  if (first < 0) return undefined

  const second = text.indexOf(needle, first + needle.length)
  if (second >= 0) return undefined

  let line = 1
  for (let i = 0; i < first; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1
  }
  return line
}

function getToolPath(args: unknown): string | undefined {
  const record = args as { path?: unknown; file_path?: unknown } | null | undefined
  if (typeof record?.path === 'string') return record.path
  if (typeof record?.file_path === 'string') return record.file_path
  return undefined
}

// Match pi's current edit schema: { path, edits: [{ oldText, newText }] }, with
// legacy top-level oldText/newText still accepted. Pi also normalizes stringified edits.
// https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/tools/edit.ts
function getParsedEdits(args: unknown): Array<{ oldText: string; newText: string }> {
  const record = args as { oldText?: unknown; newText?: unknown; edits?: unknown } | null | undefined
  const parsed: Array<{ oldText: string; newText: string }> = []

  if (typeof record?.oldText === 'string' && typeof record?.newText === 'string') {
    parsed.push({ oldText: record.oldText, newText: record.newText })
  }

  let edits = record?.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits) as unknown
    } catch {
      edits = undefined
    }
  }

  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const item = edit as { oldText?: unknown; newText?: unknown } | null | undefined
      if (typeof item?.oldText === 'string' && typeof item?.newText === 'string') {
        parsed.push({ oldText: item.oldText, newText: item.newText })
      }
    }
  }

  return parsed
}

function getEditOldTexts(args: unknown): string[] {
  const record = args as { oldText?: unknown; edits?: unknown } | null | undefined
  const oldTexts = getParsedEdits(args).map(edit => edit.oldText)

  if (typeof record?.oldText === 'string' && !oldTexts.includes(record.oldText)) oldTexts.push(record.oldText)

  let edits = record?.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits) as unknown
    } catch {
      edits = undefined
    }
  }

  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const oldText = (edit as { oldText?: unknown } | null | undefined)?.oldText
      if (typeof oldText === 'string' && !oldTexts.includes(oldText)) oldTexts.push(oldText)
    }
  }

  return oldTexts
}

function toToolCallLocations(args: unknown, cwd: string, line?: number): ToolCallLocation[] | undefined {
  const path = getToolPath(args)
  if (!path) return undefined

  const resolvedPath = isAbsolute(path) ? path : resolvePath(cwd, path)
  return [{ path: resolvedPath, ...(typeof line === 'number' ? { line } : {}) }]
}

export type SessionCreateRollbackStatus = 'process_stopped' | 'process_unconfirmed'

/**
 * Internal handoff for a create that published its immutable identity but
 * failed before the durable mapping committed. The agent owns exact artifact
 * cleanup; callers must only observe `originalError`.
 */
export class SessionCreateRollbackError extends Error {
  readonly #session: PiAcpSession
  readonly #originalError: unknown
  readonly #cleanupStatus: SessionCreateRollbackStatus

  constructor(session: PiAcpSession, originalError: unknown, cleanupStatus: SessionCreateRollbackStatus) {
    super('Session creation rollback requires agent cleanup.')
    Object.defineProperty(this, 'name', { value: 'SessionCreateRollbackError', configurable: true })
    this.#session = session
    this.#originalError = originalError
    this.#cleanupStatus = cleanupStatus
  }

  get session(): PiAcpSession {
    return this.#session
  }

  get originalError(): unknown {
    return this.#originalError
  }

  get cleanupStatus(): SessionCreateRollbackStatus {
    return this.#cleanupStatus
  }
}

export class SessionManager {
  private sessions = new Map<string, { generation: number; session: PiAcpSession }>()
  private generations = new Map<string, number>()
  private failedSpawnCandidates = new Set<PiRpcProcess>()
  private failedCandidateSessions = new Map<PiRpcProcess, PiAcpSession>()
  private unpublishedCandidates = new Set<PiRpcProcess>()
  private provenStoppedCandidates = new WeakSet<PiRpcProcess>()
  private createTransactions = new Set<Promise<void>>()
  private acceptingCreates = true
  private spawnLeaseTail: Promise<void> = Promise.resolve()
  private readonly store = new SessionStore()

  /** Dispose all sessions and their underlying pi subprocesses. */
  async disposeAll(): Promise<void> {
    this.acceptingCreates = false
    const spawnDrain = this.spawnLeaseTail

    // Stop any process already materialized inside create(). This unblocks an
    // authoritative get_state that is pending while shutdown starts.
    const registeredProcesses = new Set([...this.sessions.values()].map(entry => entry.session.proc))
    const initiallyUnpublished = new Set(
      [...this.unpublishedCandidates].filter(candidate => !registeredProcesses.has(candidate))
    )
    const initialStops = [...initiallyUnpublished].map(async candidate => {
      try {
        await this.stopOwnedCandidate(candidate)
        this.provenStoppedCandidates.add(candidate)
        this.unpublishedCandidates.delete(candidate)
        this.failedSpawnCandidates.delete(candidate)
      } catch (error) {
        this.failedSpawnCandidates.add(candidate)
        throw error
      }
    })

    await Promise.allSettled([...this.createTransactions])
    await spawnDrain.catch(() => undefined)
    const initialStopResults = await Promise.allSettled(initialStops)

    // A create whose spawn completed after the shutdown snapshot transfers its
    // unpublished process here. Stop it exactly once in this dispose attempt.
    const registeredAtCleanup = new Set([...this.sessions.values()].map(entry => entry.session.proc))
    const lateCandidates = new Set(
      [...this.unpublishedCandidates, ...this.failedSpawnCandidates].filter(
        candidate => !initiallyUnpublished.has(candidate) && !registeredAtCleanup.has(candidate)
      )
    )
    const results = await Promise.allSettled([
      ...[...this.sessions.keys()].map(id => this.close(id)),
      ...[...lateCandidates].map(async candidate => {
        await this.stopOwnedCandidate(candidate)
        this.provenStoppedCandidates.add(candidate)
        this.unpublishedCandidates.delete(candidate)
        this.failedSpawnCandidates.delete(candidate)
      })
    ])
    results.push(...initialStopResults)
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }

  /** Get a registered session if it exists (no throw). */
  maybeGet(sessionId: string): PiAcpSession | undefined {
    return this.sessions.get(sessionId)?.session
  }

  snapshot(sessionId: string): { generation: number; session: PiAcpSession } | undefined {
    const entry = this.sessions.get(sessionId)
    return entry ? { generation: entry.generation, session: entry.session } : undefined
  }

  currentGeneration(sessionId: string): number {
    return this.generations.get(sessionId) ?? 0
  }

  /** Forget a fully deleted session's recovery tombstone. */
  forget(sessionId: string): void {
    if (this.sessions.has(sessionId)) return
    this.generations.delete(sessionId)
  }

  /**
   * Dispose a session's underlying pi process and remove it from the manager.
   * Used when clients explicitly reload a session and we want a fresh pi subprocess.
   */
  close(sessionId: string, expected?: PiAcpSession): Promise<boolean> {
    // Enqueue the teardown synchronously on the same ownership lease used by
    // child spawning. A future spawn therefore cannot begin while stop proof
    // is pending, even before a failed stop is retained for retry.
    return (async () => {
      const releaseOwnershipLease = await this.acquireOwnershipLease()
      try {
        return await this.closeOwned(sessionId, expected)
      } finally {
        releaseOwnershipLease()
      }
    })()
  }

  /** Close while the caller already owns the child-ownership transaction lease. */
  private async closeOwned(sessionId: string, expected?: PiAcpSession): Promise<boolean> {
    const entry = this.sessions.get(sessionId)
    if (!entry || (expected && entry.session !== expected)) return false

    // Keep the old generation registered until teardown is proven. If cleanup
    // fails, later recovery attempts must see and retry/block on this same
    // generation instead of publishing a second live child.
    try {
      await entry.session.dispose()
    } catch (error) {
      this.retainUnconfirmedCandidate(entry.session.proc, entry.session)
      throw error
    }
    this.releaseCandidate(entry.session.proc)
    if (this.sessions.get(sessionId) === entry) this.sessions.delete(sessionId)
    return true
  }

  /** Close all sessions except the one with `keepSessionId`. */
  async closeAllExcept(keepSessionId: string): Promise<void> {
    const results = await Promise.allSettled(
      [...this.sessions.keys()].filter(id => id !== keepSessionId).map(id => this.close(id))
    )
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }

  /** Close every registered session without closing future create admission. */
  async closeAll(): Promise<void> {
    const results = await Promise.allSettled([...this.sessions.keys()].map(id => this.close(id)))
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }

  /** Prove retained unpublished-candidate cleanup before any new spawn. */
  async prepareSpawn(): Promise<void> {
    if (!this.acceptingCreates) {
      throw RequestError.internalError({ code: 'PI_ACP_AGENT_DISPOSED' }, 'The ACP agent is shutting down.')
    }
    await this.cleanupFailedSpawnCandidates()
    if (!this.acceptingCreates) {
      throw RequestError.internalError({ code: 'PI_ACP_AGENT_DISPOSED' }, 'The ACP agent is shutting down.')
    }
  }

  /** Serialize every child-spawn ownership transaction across create/recovery. */
  async acquireSpawnLease(): Promise<() => void> {
    const release = await this.acquireOwnershipLease()
    try {
      await this.prepareSpawn()
      return release
    } catch (error) {
      release()
      throw error
    }
  }

  /** Raw lease used by teardown; unlike spawn admission it never retries blockers. */
  private async acquireOwnershipLease(): Promise<() => void> {
    let release!: () => void
    const lease = new Promise<void>(resolve => {
      release = resolve
    })
    const previous = this.spawnLeaseTail
    this.spawnLeaseTail = previous.catch(() => undefined).then(() => lease)
    await previous.catch(() => undefined)
    return release
  }

  trackUnpublishedCandidate(candidate: PiRpcProcess, session?: PiAcpSession): void {
    this.unpublishedCandidates.add(candidate)
    if (session) this.failedCandidateSessions.set(candidate, session)
  }

  retainUnconfirmedCandidate(candidate: PiRpcProcess, session?: PiAcpSession): void {
    this.unpublishedCandidates.add(candidate)
    this.failedSpawnCandidates.add(candidate)
    if (session) this.failedCandidateSessions.set(candidate, session)
  }

  releaseCandidate(candidate: PiRpcProcess): void {
    this.unpublishedCandidates.delete(candidate)
    this.failedSpawnCandidates.delete(candidate)
    this.failedCandidateSessions.delete(candidate)
  }

  private async stopOwnedCandidate(candidate: PiRpcProcess): Promise<void> {
    const session = this.failedCandidateSessions.get(candidate)
    if (session) await session.dispose()
    else await candidate.stop()
    if (session) {
      for (const [sessionId, entry] of this.sessions) {
        if (entry.session === session) this.sessions.delete(sessionId)
      }
    }
    this.failedCandidateSessions.delete(candidate)
  }

  private async cleanupFailedSpawnCandidates(): Promise<void> {
    if (!this.failedSpawnCandidates.size) return
    const cleanup = await Promise.allSettled(
      [...this.failedSpawnCandidates].map(async candidate => {
        await this.stopOwnedCandidate(candidate)
        this.provenStoppedCandidates.add(candidate)
        this.unpublishedCandidates.delete(candidate)
        this.failedSpawnCandidates.delete(candidate)
      })
    )
    const failure = cleanup.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') {
      throw RequestError.internalError(
        { code: 'PI_RPC_PROCESS_CLEANUP_UNCONFIRMED' },
        'A previous Pi process could not be confirmed stopped.'
      )
    }
  }

  private publish(sessionId: string, session: PiAcpSession): PiAcpSession {
    if (this.sessions.has(sessionId)) {
      throw RequestError.internalError(
        { code: 'PI_RPC_SESSION_ID_COLLISION' },
        `Pi returned an already registered session ID: ${sessionId}`
      )
    }
    const generation = this.currentGeneration(sessionId) + 1
    this.generations.set(sessionId, generation)
    this.sessions.set(sessionId, { generation, session })
    return session
  }

  publishReplacement(sessionId: string, expectedGeneration: number, session: PiAcpSession): boolean {
    if (this.sessions.has(sessionId) || this.currentGeneration(sessionId) !== expectedGeneration) return false
    const generation = expectedGeneration + 1
    this.generations.set(sessionId, generation)
    this.sessions.set(sessionId, { generation, session })
    return true
  }

  createDetached(sessionId: string, params: SessionCreateParams & { proc: PiRpcProcess }): PiAcpSession {
    return new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc: params.proc,
      conn: params.conn
    })
  }

  create(params: SessionCreateParams): Promise<PiAcpSession> {
    if (!this.acceptingCreates) {
      return Promise.reject(
        RequestError.internalError({ code: 'PI_ACP_AGENT_DISPOSED' }, 'The ACP agent is shutting down.')
      )
    }

    let finishTransaction!: () => void
    const transaction = new Promise<void>(resolve => {
      finishTransaction = resolve
    })
    this.createTransactions.add(transaction)

    const operation = (async () => {
      const releaseSpawnLease = await this.acquireSpawnLease()
      try {
        return await this.createOwned(params)
      } finally {
        releaseSpawnLease()
      }
    })()
    void operation
      .finally(() => {
        this.createTransactions.delete(transaction)
        finishTransaction()
      })
      .catch(() => undefined)
    return operation
  }

  private async createOwned(params: SessionCreateParams): Promise<PiAcpSession> {
    if (!this.acceptingCreates) {
      throw RequestError.internalError({ code: 'PI_ACP_AGENT_DISPOSED' }, 'The ACP agent is shutting down.')
    }

    // Let pi manage session persistence in its default location (~/.pi/agent/sessions/...)
    // so sessions are visible to the regular `pi` CLI.
    let proc: PiRpcProcess | null = null
    let publishedSession: PiAcpSession | null = null
    try {
      proc = await PiRpcProcess.spawn({
        cwd: params.cwd,
        piCommand: params.piCommand
      })
      this.unpublishedCandidates.add(proc)
    } catch (e) {
      if (e instanceof PiRpcSpawnError) {
        if (e.candidate) this.failedSpawnCandidates.add(e.candidate)
        const data = piRpcSpawnErrorData(e)
        if (e.diagnostic) throw new RequestError(-32603, e.message, data)
        throw RequestError.internalError(data, e.message)
      }
      throw e
    }

    try {
      if (!this.acceptingCreates) {
        throw RequestError.internalError({ code: 'PI_ACP_AGENT_DISPOSED' }, 'The ACP agent is shutting down.')
      }

      const state = (await proc.getState()) as any
      const sessionId = typeof state?.sessionId === 'string' ? state.sessionId.trim() : ''
      const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile.trim() : ''
      if (!sessionId || !sessionFile || !isAbsolute(sessionFile)) {
        throw RequestError.internalError(
          { code: 'PI_RPC_SESSION_IDENTITY_UNAVAILABLE' },
          'Pi did not return an authoritative session ID and file.'
        )
      }
      if (!this.acceptingCreates) {
        throw RequestError.internalError({ code: 'PI_ACP_AGENT_DISPOSED' }, 'The ACP agent is shutting down.')
      }
      if (this.sessions.has(sessionId) || this.currentGeneration(sessionId) > 0 || this.store.get(sessionId)) {
        throw RequestError.internalError(
          { code: 'PI_RPC_SESSION_ID_COLLISION' },
          `Pi returned an already registered session ID: ${sessionId}`
        )
      }

      const session = new PiAcpSession({
        sessionId,
        initialState: state,
        sessionFile,
        cwd: params.cwd,
        mcpServers: params.mcpServers,
        proc,
        conn: params.conn
      })
      this.failedCandidateSessions.set(proc, session)

      publishedSession = this.publish(sessionId, session)
      // No await may separate private publication from the durable commit.
      // This keeps the identity unavailable to another JS transaction until
      // either both records exist or rollback ownership has been captured.
      this.store.upsert({
        sessionId,
        cwd: params.cwd,
        sessionFile
      })
      this.failedCandidateSessions.delete(proc)
      this.unpublishedCandidates.delete(proc)
      proc = null
      return publishedSession
    } catch (error) {
      let rollbackStatus: SessionCreateRollbackStatus = 'process_unconfirmed'
      if (proc && !this.provenStoppedCandidates.has(proc)) {
        this.failedSpawnCandidates.add(proc)
        // During shutdown, disposeAll owns the one cleanup attempt. For an
        // ordinary pre-publication failure, clean up immediately but retain
        // the exact handle when proof fails.
        if (this.acceptingCreates) {
          try {
            await this.stopOwnedCandidate(proc)
            this.provenStoppedCandidates.add(proc)
            this.unpublishedCandidates.delete(proc)
            this.failedSpawnCandidates.delete(proc)
            rollbackStatus = 'process_stopped'
          } catch {
            // retained for the next create/dispose attempt
          }
        }
      }
      const originalError = error instanceof PiRpcProcessTerminatedError ? piRpcProcessRequestError(error) : error
      if (publishedSession) {
        // The manager deliberately retains the generation tombstone. Only the
        // agent can prove and remove the exact durable artifact/mapping.
        throw new SessionCreateRollbackError(publishedSession, originalError, rollbackStatus)
      }
      throw originalError
    }
  }

  get(sessionId: string): PiAcpSession {
    const entry = this.sessions.get(sessionId)
    if (!entry) throw RequestError.invalidParams(`Unknown sessionId: ${sessionId}`)
    return entry.session
  }

  /**
   * Used by session/load: create a session object bound to an existing sessionId/proc
   * if it isn't already registered.
   */
  getOrCreate(sessionId: string, params: SessionCreateParams & { proc: PiRpcProcess }): PiAcpSession {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing.session
    return this.publish(sessionId, this.createDetached(sessionId, params))
  }
}

export class PiAcpSession {
  readonly sessionId: string
  readonly sessionFile: string | null
  readonly initialState: unknown | null
  readonly cwd: string
  readonly mcpServers: McpServer[]

  private startupInfo: string | null = null
  private startupInfoSent = false

  readonly proc: PiRpcProcess
  private readonly conn: AgentSideConnection
  private readonly runtimeExtensionDiagnosticOptions: {
    cwd: string
    agentDir: string
    env: Readonly<NodeJS.ProcessEnv>
  }

  // Current in-flight turn (if any). Additional prompts are queued.
  private nextTurnId = 1
  private pendingTurn: PromptTurn | null = null
  private readonly turnQueue: PromptTurn[] = []
  private terminalError: RequestError | null = null
  private readonly unsubscribeEvent: () => void
  private readonly unsubscribeTerminal: () => void
  private disposePromise: Promise<void> | null = null
  private disposalStarted = false
  private terminalBarrier: Promise<void> | null = null
  private readonly completionBarriers = new Set<Promise<void>>()
  // Track tool call statuses and ensure they are monotonic (pending -> in_progress -> completed).
  // Some pi events can arrive out of order (e.g. late toolcall_* deltas after execution starts),
  // and clients may hide progress if we ever downgrade back to `pending`.
  private currentToolCalls = new Map<string, 'pending' | 'in_progress'>()

  // pi can emit multiple `turn_end` and `agent_end` events for a single user prompt
  // when retry, compaction, or queued continuations run. The session-level prompt
  // completes only when `agent_settled` is emitted.
  private inAgentLoop = false

  // For ACP diff support: capture file contents before edit/write mutations,
  // then emit ToolCallContent {type:"diff"}. Compatible structured edit/write
  // events may need to be implemented in pi in the future.
  private fileSnapshots = new Map<string, { path: string; oldText: string | null }>()
  private fileMutationToolCallIds = new Set<string>()
  private bashToolCallIds = new Set<string>()
  private bashOutputSnapshots = new Map<string, string>()

  // Ensure `session/update` notifications are sent in order and can be awaited
  // before completing a `session/prompt` request.
  private lastEmit: Promise<void> = Promise.resolve()

  constructor(opts: {
    sessionId: string
    sessionFile?: string | null
    initialState?: unknown
    cwd: string
    mcpServers: McpServer[]
    proc: PiRpcProcess
    conn: AgentSideConnection
    /** @deprecated Retained as an inert construction shim for downstream tests. */
    fileCommands?: unknown[]
  }) {
    this.sessionId = opts.sessionId
    this.sessionFile = opts.sessionFile ?? null
    this.initialState = opts.initialState ?? null
    this.cwd = opts.cwd
    this.mcpServers = opts.mcpServers
    this.proc = opts.proc
    this.conn = opts.conn
    const env = { ...process.env }
    const agentDir = env.PI_CODING_AGENT_DIR ?? join(env.HOME ?? env.USERPROFILE ?? homedir(), '.pi', 'agent')
    this.runtimeExtensionDiagnosticOptions = { cwd: this.cwd, agentDir, env }

    this.unsubscribeEvent = this.proc.onEvent(ev => this.handlePiEvent(ev))
    const onTerminal = (
      this.proc as PiRpcProcess & {
        onTerminal?: (handler: (error: PiRpcProcessTerminatedError) => void) => () => void
      }
    ).onTerminal
    this.unsubscribeTerminal =
      typeof onTerminal === 'function' ? onTerminal.call(this.proc, error => this.handleTerminal(error)) : () => {}
  }

  isAlive(): boolean {
    const check = (this.proc as PiRpcProcess & { isAlive?: () => boolean }).isAlive
    return !this.disposalStarted && !this.terminalError && (typeof check !== 'function' || check.call(this.proc))
  }

  async runRpc<T>(operation: (proc: PiRpcProcess) => Promise<T>): Promise<T> {
    try {
      return await operation(this.proc)
    } catch (error) {
      if (!(error instanceof PiRpcProcessTerminatedError)) throw error
      this.handleTerminal(error)
      if (this.terminalBarrier) await this.terminalBarrier
      throw this.terminalError ?? piRpcProcessRequestError(error)
    }
  }

  async dispose(): Promise<void> {
    // A session is permanently ineligible for new RPC work once teardown
    // begins, even if process stop proof fails and dispose() remains retryable.
    // Its event subscriptions are removed during this attempt, so reporting it
    // as healthy afterward would reuse an unusable half-disposed session.
    this.disposalStarted = true
    if (!this.disposePromise) {
      const attempt = (async () => {
        let stopError: unknown
        try {
          const stop = (this.proc as PiRpcProcess & { stop?: () => Promise<void> }).stop
          if (typeof stop === 'function') await stop.call(this.proc)
          else this.proc.dispose?.()
        } catch (error) {
          stopError = error
        } finally {
          // A terminal transition supersedes any unbounded normal stable-tail
          // flush with its fixed-cut barrier. Do not snapshot-await a stale
          // notification promise that the terminal barrier has quarantined.
          if (this.terminalBarrier) await this.terminalBarrier
          else await this.awaitCompletionBarriers()
          this.unsubscribeEvent()
          this.unsubscribeTerminal()
        }
        if (stopError) throw stopError
      })()
      this.disposePromise = attempt
      void attempt.catch(() => {
        if (this.disposePromise === attempt) this.disposePromise = null
      })
    }
    await this.disposePromise
  }

  setStartupInfo(text: string) {
    this.startupInfo = text
    this.startupInfoSent = false
  }

  /**
   * Best-effort attempt to send startup info outside of a prompt turn.
   * Some clients (e.g. Zed) may only render agent messages once the UI is ready;
   * callers can invoke this shortly after session/new returns.
   */
  sendStartupInfoIfPending(): void {
    if (this.startupInfoSent || !this.startupInfo) return
    this.startupInfoSent = true

    this.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: this.startupInfo }
    })
  }

  async prompt(message: string, images: unknown[] = []): Promise<StopReason> {
    if (this.terminalError) throw this.terminalError

    const turnPromise = new Promise<StopReason>((resolve, reject) => {
      const queued: PromptTurn = {
        id: this.nextTurnId,
        message,
        images,
        resolve,
        reject,
        cancelRequested: false,
        claim: null,
        completed: false,
        completionBarrier: null,
        completionBatch: null,
        requiresAgentStart: false,
        agentStarted: false
      }
      this.nextTurnId += 1

      // If a turn is already running, enqueue.
      if (this.pendingTurn) {
        this.turnQueue.push(queued)

        // Best-effort: notify client that a prompt was queued.
        // This doesn't work in Zed yet, needs to be revisited
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `Queued message (position ${this.turnQueue.length}).`
          }
        })

        // Also publish queue depth via session info metadata.
        // This also not visible in the client
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
        })

        return
      }

      // No turn is running; start immediately.
      this.startTurn(queued)
    })

    return turnPromise
  }

  async cancel(): Promise<void> {
    const active = this.pendingTurn

    // An idle cancel, or one that lost the completion claim, must not write an
    // abort command to pi.
    if (!active || active.claim) return

    // Record cancellation before any asynchronous abort result or terminal
    // callback can race it.
    active.cancelRequested = true

    if (this.turnQueue.length) {
      const queued = this.turnQueue.splice(0, this.turnQueue.length)
      for (const t of queued) {
        if (this.claimTurn(t, { kind: 'settled', reason: 'cancelled' })) this.settleClaimedTurn(t)
      }

      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Cleared queued prompts.' }
      })
      this.emit({
        sessionUpdate: 'session_info_update',
        _meta: { piAcp: { queueDepth: 0, running: true } }
      })
    }

    // Abort the currently running turn. Completion still comes from
    // `agent_settled` or the process terminal lifecycle.
    await this.runRpc(proc => proc.abort())
  }

  wasCancelRequested(): boolean {
    return this.pendingTurn?.cancelRequested ?? false
  }

  private emit(update: SessionUpdate): void {
    // Once terminal is latched, its final idle update is the fixed cut. Late pi
    // events or reentrant notification producers cannot extend that cut.
    if (this.terminalError) return
    this.enqueueEmit(update)
  }

  private enqueueEmit(update: SessionUpdate): void {
    // Serialize update delivery.
    this.lastEmit = this.lastEmit
      .then(() =>
        this.conn.sessionUpdate({
          sessionId: this.sessionId,
          update
        })
      )
      .catch(() => {
        // Ignore notification errors (client may have gone away). We still want
        // prompt completion.
      })
  }

  private enqueueTerminalIdle(): Promise<void> {
    this.enqueueEmit({
      sessionUpdate: 'session_info_update',
      _meta: { piAcp: { queueDepth: 0, running: false } }
    })
    return this.lastEmit
  }

  private async flushEmits(): Promise<void> {
    let tail: Promise<void>
    do {
      tail = this.lastEmit
      await tail
    } while (tail !== this.lastEmit)
  }

  private async flushTerminalCut(cut: Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        cut,
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, TERMINAL_UPDATE_FLUSH_TIMEOUT_MS)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private trackCompletionBarrier(barrier: Promise<void>): void {
    this.completionBarriers.add(barrier)
    void barrier
      .finally(() => {
        this.completionBarriers.delete(barrier)
      })
      .catch(() => undefined)
  }

  private async awaitCompletionBarriers(): Promise<void> {
    while (this.completionBarriers.size) {
      await Promise.allSettled([...this.completionBarriers])
    }
  }

  private emitBashToolCall(params: {
    sessionUpdate: 'tool_call' | 'tool_call_update'
    toolCallId: string
    toolName: string
    args: unknown
    status: 'pending' | 'in_progress'
    locations?: ToolCallLocation[]
    includeTerminal: boolean
  }): void {
    this.bashToolCallIds.add(params.toolCallId)
    this.emit({
      sessionUpdate: params.sessionUpdate,
      toolCallId: params.toolCallId,
      title: bashCommand(params.args) ?? params.toolName,
      kind: 'execute',
      status: params.status,
      locations: params.locations,
      ...(params.includeTerminal ? { content: bashTerminalContent(params.toolCallId) } : {}),
      ...(params.includeTerminal ? { _meta: bashTerminalInfoMeta(params.toolCallId, this.cwd) } : {})
    })
  }

  private emitBashOutputUpdate(params: {
    toolCallId: string
    status: 'in_progress' | 'completed' | 'failed'
    result: unknown
    isError?: boolean
  }): void {
    const text = bashResultText(params.result)
    const previous = this.bashOutputSnapshots.get(params.toolCallId) ?? ''
    const delta = bashOutputDelta(previous, text)
    this.bashOutputSnapshots.set(params.toolCallId, text)

    this.emit({
      sessionUpdate: 'tool_call_update',
      toolCallId: params.toolCallId,
      status: params.status,
      _meta: {
        ...(delta ? bashTerminalOutputMeta(params.toolCallId, delta) : {}),
        ...(params.status === 'completed' || params.status === 'failed'
          ? bashTerminalExitMeta(params.toolCallId, bashExitCode(params.result, Boolean(params.isError)))
          : {})
      }
    })
  }

  private cleanupToolCall(toolCallId: string): void {
    this.currentToolCalls.delete(toolCallId)
    this.fileSnapshots.delete(toolCallId)
    this.fileMutationToolCallIds.delete(toolCallId)
    this.bashToolCallIds.delete(toolCallId)
    this.bashOutputSnapshots.delete(toolCallId)
  }

  private startTurn(t: PromptTurn, requiresAgentStart = false): void {
    if (this.terminalError) {
      if (this.claimTurn(t, { kind: 'failed', error: this.terminalError })) this.settleClaimedTurn(t)
      return
    }

    this.inAgentLoop = false
    t.requiresAgentStart = requiresAgentStart
    t.agentStarted = false

    this.pendingTurn = t

    // Publish queue depth (0 because we're starting the turn now).
    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
    })

    // Kick off pi, but completion is determined by pi events, not the RPC response.
    // The prompt RPC only acknowledges acceptance; retry, compaction, or queued
    // continuations may emit multiple `agent_end` events before `agent_settled`.
    this.proc.prompt(t.message, t.images).catch(error => {
      // A process-terminal rejection must use the terminal path so the active
      // and queued turns share one causal RequestError instance.
      if (error instanceof PiRpcProcessTerminatedError) {
        this.handleTerminal(error)
        return
      }

      this.handlePromptFailure(t, promptRequestError(error))
    })
  }

  private claimTurn(turn: PromptTurn, claim: TurnClaim): boolean {
    if (turn.claim) return false
    turn.claim = claim
    return true
  }

  private settleClaimedTurn(turn: PromptTurn): void {
    const claim = turn.claim
    if (!claim || turn.completed) return
    turn.completed = true
    if (claim.kind === 'failed') turn.reject(claim.error)
    else turn.resolve(claim.reason)
  }

  private handlePromptFailure(turn: PromptTurn, error: RequestError): void {
    if (this.pendingTurn !== turn || turn.claim) return

    const failed: PromptTurn[] = []
    const activeClaim: TurnClaim = turn.cancelRequested
      ? { kind: 'settled', reason: 'cancelled' }
      : { kind: 'failed', error }
    if (this.claimTurn(turn, activeClaim)) failed.push(turn)

    for (const queued of this.turnQueue.splice(0, this.turnQueue.length)) {
      if (this.claimTurn(queued, { kind: 'failed', error })) failed.push(queued)
    }

    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: { piAcp: { queueDepth: 0, running: false } }
    })

    const barrier = this.flushEmits().finally(() => {
      for (const claimed of failed) this.settleClaimedTurn(claimed)
      if (this.pendingTurn === turn) this.pendingTurn = null
      this.inAgentLoop = false

      // Prompts that arrive after the failure claim belong to a new immutable
      // turn generation. They were not part of the frozen failure batch and
      // must be handed off rather than stranded behind the claimed turn.
      if (this.terminalError || this.pendingTurn) return
      const next = this.turnQueue.shift()
      if (next) {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `Starting queued message. (${this.turnQueue.length} remaining)` }
        })
        this.startTurn(next, true)
      }
    })
    turn.completionBarrier = barrier
    turn.completionBatch = failed
    this.trackCompletionBarrier(barrier)
  }

  private handleTerminal(error: PiRpcProcessTerminatedError): void {
    if (this.terminalError) return

    const requestError = piRpcProcessRequestError(error)
    this.terminalError = requestError

    const terminalTurns: PromptTurn[] = []
    const active = this.pendingTurn
    if (active) {
      if (!active.claim) {
        const claim: TurnClaim = active.cancelRequested
          ? { kind: 'settled', reason: 'cancelled' }
          : { kind: 'failed', error: requestError }
        this.claimTurn(active, claim)
      }
      if (active.claim) terminalTurns.push(active)
    }

    for (const claimed of active?.completionBatch ?? []) {
      if (claimed.claim && !terminalTurns.includes(claimed)) terminalTurns.push(claimed)
    }

    for (const queued of this.turnQueue.splice(0, this.turnQueue.length)) {
      if (this.claimTurn(queued, { kind: 'failed', error: requestError })) terminalTurns.push(queued)
    }

    // This is deliberately a fixed cut, not the normal stable-tail flush: a
    // broken client notification sink cannot keep ACP requests pending forever.
    const terminalCut = this.enqueueTerminalIdle()
    const supersededActiveBarrier = active?.completionBarrier ?? null
    this.terminalBarrier = this.flushTerminalCut(terminalCut).finally(() => {
      for (const claimed of terminalTurns) this.settleClaimedTurn(claimed)
      if (active && terminalTurns.includes(active) && this.pendingTurn === active) this.pendingTurn = null
      if (supersededActiveBarrier) {
        this.completionBarriers.delete(supersededActiveBarrier)
        if (active?.completionBarrier === supersededActiveBarrier) active.completionBarrier = null
        if (active) active.completionBatch = null
      }
      this.inAgentLoop = false
    })
    this.trackCompletionBarrier(this.terminalBarrier)
  }

  private handlePiEvent(ev: PiRpcEvent) {
    const type = String((ev as any).type ?? '')

    switch (type) {
      case 'message_update': {
        const ame = (ev as any).assistantMessageEvent

        // Stream assistant text.
        if (ame?.type === 'text_delta' && typeof ame.delta === 'string') {
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          break
        }

        if (ame?.type === 'thinking_delta' && typeof ame.delta === 'string') {
          this.emit({
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          break
        }

        // Surface tool calls ASAP so clients (e.g. Zed) can show a tool-in-use/loading UI
        // while the model is still streaming tool call args.
        if (ame?.type === 'toolcall_start' || ame?.type === 'toolcall_delta' || ame?.type === 'toolcall_end') {
          const toolCall =
            // pi sometimes includes the tool call directly on the event
            (ame as any)?.toolCall ??
            // ...and always includes it in the partial assistant message at contentIndex
            (ame as any)?.partial?.content?.[(ame as any)?.contentIndex ?? 0]

          const toolCallId = String((toolCall as any)?.id ?? '')
          const toolName = String((toolCall as any)?.name ?? 'tool')

          if (toolCallId) {
            const rawInput =
              (toolCall as any)?.arguments && typeof (toolCall as any).arguments === 'object'
                ? (toolCall as any).arguments
                : (() => {
                    const s = String((toolCall as any)?.partialArgs ?? '')
                    if (!s) return undefined
                    try {
                      return JSON.parse(s)
                    } catch {
                      return { partialArgs: s }
                    }
                  })()

            const locations = toToolCallLocations(rawInput, this.cwd)
            const existingStatus = this.currentToolCalls.get(toolCallId)
            // IMPORTANT: never downgrade status (e.g. if we already marked in_progress via tool_execution_start).
            const status = existingStatus ?? 'pending'

            if (isBashTool(toolName)) {
              if (!existingStatus) this.currentToolCalls.set(toolCallId, 'pending')
              this.emitBashToolCall({
                sessionUpdate: existingStatus ? 'tool_call_update' : 'tool_call',
                toolCallId,
                toolName,
                args: rawInput,
                status,
                locations,
                includeTerminal: !existingStatus
              })
            } else if (!existingStatus) {
              this.currentToolCalls.set(toolCallId, 'pending')
              this.emit({
                sessionUpdate: 'tool_call',
                toolCallId,
                title: toolName,
                kind: toToolKind(toolName),
                status,
                locations,
                rawInput
              })
            } else {
              // Best-effort: keep rawInput updated while args are streaming.
              // Keep the existing status (pending or in_progress).
              this.emit({
                sessionUpdate: 'tool_call_update',
                toolCallId,
                status,
                locations,
                rawInput
              })
            }
          }

          break
        }

        // Ignore other delta/event types for now.
        break
      }

      case 'tool_execution_start': {
        const toolCallId = String((ev as any).toolCallId ?? crypto.randomUUID())
        const toolName = String((ev as any).toolName ?? 'tool')
        const args = (ev as any).args
        let line: number | undefined

        if (isBashTool(toolName)) {
          const locations = toToolCallLocations(args, this.cwd)
          const existingStatus = this.currentToolCalls.get(toolCallId)
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emitBashToolCall({
            sessionUpdate: existingStatus ? 'tool_call_update' : 'tool_call',
            toolCallId,
            toolName,
            args,
            status: 'in_progress',
            locations,
            includeTerminal: !existingStatus
          })
          break
        }

        // Capture pre-mutation file contents so we can emit a structured ACP diff.
        const isFileMutation = toolName === 'edit' || toolName === 'write'
        let snapshotOldText: string | null | undefined
        if (isFileMutation) {
          this.fileMutationToolCallIds.add(toolCallId)
          const p = getToolPath(args)
          if (p) {
            try {
              const abs = isAbsolute(p) ? p : resolvePath(this.cwd, p)
              snapshotOldText = readFileSync(abs, 'utf8')
              this.fileSnapshots.set(toolCallId, { path: p, oldText: snapshotOldText })

              if (toolName === 'edit') {
                for (const needle of getEditOldTexts(args)) {
                  line = findUniqueLineNumber(snapshotOldText, needle)
                  if (typeof line === 'number') break
                }
              }
            } catch {
              snapshotOldText = null
              this.fileSnapshots.set(toolCallId, { path: p, oldText: null })
            }
          }
        }

        const locations = toToolCallLocations(args, this.cwd, line)

        // If we already surfaced the tool call while the model streamed it, just transition.
        if (!this.currentToolCalls.has(toolCallId)) {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call',
            toolCallId,
            title: toolName,
            kind: toToolKind(toolName),
            status: 'in_progress',
            locations,
            rawInput: args
          })
        } else {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'in_progress',
            locations,
            rawInput: args
          })
        }

        break
      }

      case 'tool_execution_update': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const partial = (ev as any).partialResult
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({ toolCallId, status: 'in_progress', result: partial })
          break
        }

        const text = this.fileMutationToolCallIds.has(toolCallId) ? '' : toolResultToText(partial)

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'in_progress',
          content: text
            ? ([{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[])
            : undefined,
          ...(this.fileMutationToolCallIds.has(toolCallId) ? {} : { rawOutput: partial })
        })
        break
      }

      case 'tool_execution_end': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const result = (ev as any).result
        const isError = Boolean((ev as any).isError)
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({
            toolCallId,
            status: isError ? 'failed' : 'completed',
            result,
            isError
          })
          this.cleanupToolCall(toolCallId)
          break
        }

        const text = toolResultToText(result)

        const snapshot = this.fileSnapshots.get(toolCallId)
        let content: ToolCallContent[] | undefined
        let hasStructuredDiff = false

        if (!isError && snapshot) {
          try {
            const abs = isAbsolute(snapshot.path) ? snapshot.path : resolvePath(this.cwd, snapshot.path)
            const newText = readFileSync(abs, 'utf8')
            if (snapshot.oldText === null || newText !== snapshot.oldText) {
              hasStructuredDiff = true
              content = [
                {
                  type: 'diff',
                  path: snapshot.path,
                  oldText: snapshot.oldText,
                  newText
                }
              ]
            }
          } catch {
            // ignore; fall back to text only
          }
        }

        if (!content && !hasStructuredDiff && text) {
          content = [{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[]
        }

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: isError ? 'failed' : 'completed',
          content,
          ...(hasStructuredDiff ? {} : { rawOutput: result })
        })

        this.cleanupToolCall(toolCallId)
        break
      }

      case 'extension_ui_request': {
        void this.handleExtensionUiRequest(ev).catch(() => {
          const id = stringProp(ev, 'id')
          if (!id) {
            return
          }

          void this.proc.sendExtensionUiResponse({ id, cancelled: true }).catch(() => {})
        })
        break
      }

      case 'extension_error': {
        const diagnostic = formatPiRuntimeExtensionError(ev, this.runtimeExtensionDiagnosticOptions)
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: diagnostic.summary } satisfies ContentBlock,
          _meta: { piAcp: { notify: { level: 'error' }, diagnostic } }
        })
        break
      }

      case 'auto_retry_start': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: formatAutoRetryMessage(ev) } satisfies ContentBlock
        })
        break
      }

      case 'auto_retry_end': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Retry finished, resuming.' } satisfies ContentBlock
        })
        break
      }

      case 'auto_compaction_start': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Context nearing limit, running automatic compaction...'
          } satisfies ContentBlock
        })
        break
      }

      case 'auto_compaction_end': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Automatic compaction finished; context was summarized to continue the session.'
          } satisfies ContentBlock
        })
        break
      }

      case 'agent_start': {
        this.inAgentLoop = true
        if (this.pendingTurn) this.pendingTurn.agentStarted = true
        break
      }

      case 'turn_end': {
        // pi uses `turn_end` for sub-steps (e.g. tool_use) and will often start another turn.
        // Do NOT resolve the ACP `session/prompt` here; wait for `agent_settled`.
        break
      }

      case 'agent_end': {
        // One low-level run ended. Pi may still retry, compact, or process a queued
        // continuation, so keep the ACP turn open until `agent_settled`.
        this.inAgentLoop = false
        break
      }

      case 'agent_settled': {
        const active = this.pendingTurn
        if (!active) break
        if (active.requiresAgentStart && !active.agentStarted) break

        // Claim before awaiting notifications. A later terminal callback can
        // fail the queue, but cannot rewrite this authoritative completion.
        const reason: StopReason = active.cancelRequested ? 'cancelled' : 'end_turn'
        if (!this.claimTurn(active, { kind: 'settled', reason })) break

        // Ensure all updates derived from pi events are delivered before we resolve
        // the ACP `session/prompt` request.
        const barrier = this.flushEmits().finally(() => {
          this.settleClaimedTurn(active)
          if (this.pendingTurn !== active) return
          this.pendingTurn = null
          this.inAgentLoop = false

          // A terminal observed after this turn claimed completion still owns
          // the queue. It must never start a successor on the dead generation.
          if (this.terminalError) return

          // Start next queued prompt, if any.
          const next = this.turnQueue.shift()
          if (next) {
            this.emit({
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Starting queued message. (${this.turnQueue.length} remaining)` }
            })
            this.startTurn(next, true)
          } else {
            this.emit({
              sessionUpdate: 'session_info_update',
              _meta: { piAcp: { queueDepth: 0, running: false } }
            })
          }
        })
        active.completionBarrier = barrier
        active.completionBatch = [active]
        this.trackCompletionBarrier(barrier)
        break
      }

      default:
        break
    }
  }

  private async handleExtensionUiRequest(ev: PiRpcEvent): Promise<void> {
    const id = stringProp(ev, 'id')
    const method = stringProp(ev, 'method')
    if (!id) {
      return
    }

    if (method === 'select') {
      await this.handleExtensionSelect(ev, id)
      return
    }

    if (method === 'confirm') {
      await this.handleExtensionConfirm(ev, id)
      return
    }

    if (method === 'input' || method === 'editor') {
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `Pi ${method} UI request is not supported in ACP yet; cancelling it.`
        } satisfies ContentBlock
      })
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    if (method === 'notify') {
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: stringProp(ev, 'message') ?? 'Pi notification' } satisfies ContentBlock,
        _meta: { piAcp: { notify: { level: stringProp(ev, 'notifyType') ?? 'info' } } }
      })
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    await this.proc.sendExtensionUiResponse({ id, cancelled: true })
  }

  private async handleExtensionSelect(ev: PiRpcEvent, id: string): Promise<void> {
    const rawOptions = ev.options
    const options = Array.isArray(rawOptions) ? rawOptions.map(option => String(option)) : []
    if (!options.length) {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    const permissionOptions: PermissionOption[] = options.map((name, index) => ({
      optionId: `${CHOICE_OPTION_PREFIX}${index}`,
      name,
      kind: 'allow_once'
    }))

    const selected = await this.requestExtensionPermission(id, ev, permissionOptions)
    if (selected === null) {
      return
    }

    const selectedOptionId = selected.outcome.outcome === 'selected' ? selected.outcome.optionId : null
    const index = selectedOptionId === null ? null : optionIndex(selectedOptionId)
    const value = index === null ? null : (options.at(index) ?? null)
    await this.proc.sendExtensionUiResponse(value === null ? { id, cancelled: true } : { id, value })
  }

  private async handleExtensionConfirm(ev: PiRpcEvent, id: string): Promise<void> {
    const selected = await this.requestExtensionPermission(id, ev, CONFIRM_PERMISSION_OPTIONS)
    if (selected === null) {
      return
    }

    if (selected.outcome.outcome === 'cancelled') {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    await this.proc.sendExtensionUiResponse({ id, confirmed: selected.outcome.optionId === 'yes' })
  }

  private async requestExtensionPermission(
    id: string,
    ev: PiRpcEvent,
    options: PermissionOption[]
  ): Promise<PermissionResponse | null> {
    try {
      return await this.conn.requestPermission({
        sessionId: this.sessionId,
        toolCall: extensionUiToolCall(id, ev),
        options
      })
    } catch {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return null
    }
  }
}

function extensionUiToolCall(id: string, ev: PiRpcEvent) {
  const method = stringProp(ev, 'method') ?? 'ui'
  const title = stringProp(ev, 'title') ?? `Pi ${method}`
  const rawInput: Record<string, unknown> = { method }

  for (const key of EXTENSION_UI_RAW_INPUT_KEYS) {
    if (Object.hasOwn(ev, key)) rawInput[key] = ev[key]
  }

  return {
    toolCallId: `pi-ui-${id}`,
    title,
    kind: 'other' as const,
    status: 'pending' as const,
    rawInput
  }
}

function stringProp(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' ? value : null
}

function optionIndex(optionId: string): number | null {
  if (!optionId.startsWith(CHOICE_OPTION_PREFIX)) {
    return null
  }

  const rawIndex = optionId.slice(CHOICE_OPTION_PREFIX.length)
  if (!rawIndex) {
    return null
  }

  const index = Number(rawIndex)
  return Number.isSafeInteger(index) && index >= 0 && String(index) === rawIndex ? index : null
}

function formatAutoRetryMessage(ev: PiRpcEvent): string {
  const attempt = Number((ev as any).attempt)
  const maxAttempts = Number((ev as any).maxAttempts)
  const delayMs = Number((ev as any).delayMs)

  if (!Number.isFinite(attempt) || !Number.isFinite(maxAttempts) || !Number.isFinite(delayMs)) {
    return 'Retrying...'
  }

  let delaySeconds = Math.round(delayMs / 1000)
  if (delayMs > 0 && delaySeconds === 0) delaySeconds = 1

  return `Retrying (attempt ${attempt}/${maxAttempts}, waiting ${delaySeconds}s)...`
}

function toToolKind(toolName: string): ToolKind {
  switch (toolName) {
    case 'read':
      return 'read'
    case 'write':
    case 'edit':
      return 'edit'
    case 'bash':
      return 'execute'
    default:
      return 'other'
  }
}
