import {
  RequestError,
  type Agent as ACPAgent,
  type AgentSideConnection,
  type AuthenticateRequest,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type PromptRequest,
  type PromptResponse,
  type SessionConfigOption,
  type SessionInfo,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type DeleteSessionRequest,
  type DeleteSessionResponse
} from '@agentclientprotocol/sdk'
import { getAuthMethods } from './auth.js'
import {
  PiAcpCommandBusyError,
  SessionCreateRollbackError,
  SessionManager,
  piRpcProcessRequestError,
  type PiAcpSession,
  type SessionCommandReservation,
  type SessionMutationReservation,
  type SessionExecuteCommandOutcome
} from './session.js'
import { SessionStore } from './session-store.js'
import {
  PI_RPC_PROCESS_TERMINATED_CODE,
  PiRpcProcess,
  PiRpcProcessTerminatedError,
  PiRpcSpawnError,
  piRpcSpawnErrorData
} from '../pi-rpc/process.js'
import { listPiSessions } from './pi-sessions.js'
import { normalizePiAssistantText, normalizePiMessageText } from './translate/pi-messages.js'
import { toolResultToText } from './translate/pi-tools.js'
import {
  bashCommand,
  bashExitCode,
  bashResultText,
  bashTerminalContent,
  bashTerminalExitMeta,
  bashTerminalInfoMeta,
  bashTerminalOutputMeta,
  isBashTool
} from './translate/bash.js'
import { promptToPiMessage } from './translate/prompt.js'
import { parseCommandArgs } from './slash-commands.js'
import { getAgentDir, getEnableSkillCommands, getQuietStartup } from './pi-settings.js'
import {
  FIXTURE_STATE_COMMAND_NAME,
  freezePiCommandCatalog,
  type FrozenPiCommandCatalog,
  type PiCommandCatalogOptions,
  type PiCommandCatalogState
} from './pi-commands.js'
import {
  findUnsupportedPiBuiltinCommand,
  isUnsupportedPiBuiltinCommand,
  unsupportedPiBuiltinPromptResponse
} from './pi-builtin-commands.js'
import { maybeAuthRequiredError } from './auth-required.js'
import { isAbsolute } from 'node:path'
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  readdirSync,
  statSync,
  unlinkSync
} from 'node:fs'
import type { AvailableCommand } from '@agentclientprotocol/sdk'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'

type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
type AdvertisedModel = {
  modelId: string
  name: string
  description?: string | null
}

const MODEL_CONFIG_ID = 'model'
const THOUGHT_LEVEL_CONFIG_ID = 'thought_level'
export const PROJECT_TRUST_WARNING =
  "pi-acp automatically trusts this project. Project resources and extensions may load or execute with this process's local permissions; ACP permissions are not a sandbox."
const SESSION_RECOVERY_UNAVAILABLE_CODE = 'PI_ACP_SESSION_RECOVERY_UNAVAILABLE'
const FIXTURE_STATE_PREVIEW_ENV = 'PI_ACP_EXPERIMENTAL_FIXTURE_STATE'
const FIXTURE_STATE_CATALOG_DISCOVERY_FAILED_CODE = 'PI_COMMAND_CATALOG_DISCOVERY_FAILED'
/** Distinct from the sealed 500ms terminal-update cut in session.ts. */
export const SESSION_RECOVERY_HANDSHAKE_TIMEOUT_MS = 2_000

type FixtureStateRejectionCode =
  | 'COMMAND_INVALID_REQUEST'
  | 'COMMAND_NOT_FOUND'
  | 'COMMAND_BUSY'
  | 'COMMAND_REQUEST_CONFLICT'
  | 'COMMAND_HANDLER_FAILED'

type FixtureStateInvocation = Readonly<{ args: string }>
type FixtureStateRefusalReason = 'disabled' | 'capability' | 'collision' | 'attachments'

function parseFixtureStateInvocation(message: string): FixtureStateInvocation | null {
  const invocation = `/${FIXTURE_STATE_COMMAND_NAME}`
  if (!message.startsWith(invocation)) return null
  const delimiter = message.charAt(invocation.length)
  if (delimiter === '') return Object.freeze({ args: '' })
  if (!/\s/u.test(delimiter)) return null
  return Object.freeze({ args: message.slice(invocation.length + 1) })
}

function promptHasAttachments(prompt: PromptRequest['prompt']): boolean {
  return prompt.some(block => block.type !== 'text')
}

function fixtureStateSummary(code: FixtureStateRejectionCode, reason?: FixtureStateRefusalReason): string {
  if (reason === 'disabled') return 'The experimental /fixture-state preview is disabled; nothing was sent to Pi.'
  if (reason === 'capability') return 'This Pi process does not support execute_command; nothing was sent to Pi.'
  if (reason === 'collision') return 'The /fixture-state command did not resolve to one exact extension command.'
  if (reason === 'attachments') return '/fixture-state accepts text arguments only; attachments were not sent to Pi.'

  switch (code) {
    case 'COMMAND_INVALID_REQUEST':
      return 'Pi rejected the /fixture-state command request as invalid.'
    case 'COMMAND_BUSY':
      return 'The Pi session is busy; /fixture-state was not queued or sent.'
    case 'COMMAND_REQUEST_CONFLICT':
      return 'Pi rejected a conflicting command request identity.'
    case 'COMMAND_HANDLER_FAILED':
      return 'The /fixture-state extension handler failed.'
    case 'COMMAND_NOT_FOUND':
      return 'The /fixture-state extension command is not available.'
  }
}

function fixtureStateRefusal(
  requestId: string,
  code: FixtureStateRejectionCode,
  reason?: FixtureStateRefusalReason
): PromptResponse {
  const summary = fixtureStateSummary(code, reason)
  return {
    stopReason: 'refusal',
    _meta: {
      piAcp: {
        executeCommand: {
          requestId,
          name: FIXTURE_STATE_COMMAND_NAME,
          disposition: 'rejected',
          code
        },
        diagnostic: {
          schemaVersion: 1,
          code,
          phase: 'execution',
          source: 'extension',
          command: FIXTURE_STATE_COMMAND_NAME,
          summary,
          truncated: false,
          redacted: false
        },
        routing: {
          promptForwardedToPi: false,
          sentToModel: false
        }
      }
    }
  }
}

function fixtureStateHandled(requestId: string): PromptResponse {
  return {
    stopReason: 'end_turn',
    _meta: {
      piAcp: {
        executeCommand: {
          requestId,
          name: FIXTURE_STATE_COMMAND_NAME,
          source: 'extension',
          disposition: 'handled'
        },
        routing: {
          promptForwardedToPi: false,
          sentToModel: false
        }
      }
    }
  }
}

function fixtureStateCancelled(requestId: string): PromptResponse {
  return {
    stopReason: 'cancelled',
    _meta: {
      piAcp: {
        executeCommand: {
          requestId,
          name: FIXTURE_STATE_COMMAND_NAME,
          disposition: 'cancelled'
        },
        routing: { promptForwardedToPi: false, sentToModel: false }
      }
    }
  }
}

function sessionRecoveryUnavailableError(): RequestError {
  return RequestError.internalError(
    { code: SESSION_RECOVERY_UNAVAILABLE_CODE },
    'The Pi session could not be recovered safely; load the session again or create a new session.'
  )
}

async function runSessionRpc<T>(session: PiAcpSession, operation: (proc: PiRpcProcess) => Promise<T>): Promise<T> {
  const runRpc = (
    session as PiAcpSession & {
      runRpc?: <R>(operation: (proc: PiRpcProcess) => Promise<R>) => Promise<R>
    }
  ).runRpc
  if (typeof runRpc === 'function') return (await runRpc.call(session, operation)) as T

  // Compatibility for narrow unit-test sessions. Production sessions always
  // provide runRpc(), which also waits for the fixed terminal update cut.
  try {
    return await operation(session.proc)
  } catch (error) {
    if (error instanceof PiRpcProcessTerminatedError) throw piRpcProcessRequestError(error)
    throw error
  }
}

async function runSessionMutation<T>(
  session: PiAcpSession,
  operationName: string,
  operation: () => Promise<T>
): Promise<T> {
  const reserve = (
    session as PiAcpSession & {
      reserveMutation?: (operation: string) => SessionMutationReservation
    }
  ).reserveMutation
  const release = (
    session as PiAcpSession & {
      releaseMutation?: (reservation: SessionMutationReservation) => void
    }
  ).releaseMutation

  // Compatibility for narrow unit-test sessions. Production sessions always
  // provide the synchronous shared mutation fence.
  if (typeof reserve !== 'function' || typeof release !== 'function') return await operation()

  let reservation: SessionMutationReservation
  try {
    reservation = reserve.call(session, operationName)
  } catch (error) {
    if (error instanceof PiAcpCommandBusyError) {
      throw RequestError.internalError({ code: error.code }, error.message)
    }
    throw error
  }

  try {
    return await operation()
  } finally {
    release.call(session, reservation)
  }
}

type SessionRecovery = {
  readonly identity: symbol
  readonly generation: number
  readonly promise: Promise<PiAcpSession>
  candidate: PiRpcProcess | null
  candidateSession: PiAcpSession | null
  cancelled: boolean
  blockedCleanup: boolean
  cleanupRetry: Promise<void> | null
  commandCatalogState: PiCommandCatalogState | null
}

type FailedNewSessionCleanupResult = 'complete' | 'superseded' | 'process_unconfirmed' | 'artifact_quarantined'

function builtinAvailableCommands(): AvailableCommand[] {
  return [
    {
      name: 'compact',
      description: 'Manually compact the session context',
      input: { hint: 'optional custom instructions' }
    },
    {
      name: 'autocompact',
      description: 'Toggle automatic context compaction',
      input: { hint: 'on|off|toggle' }
    },
    {
      name: 'export',
      description: 'Export session to an HTML file in the session cwd'
    },
    {
      name: 'session',
      description: 'Show session stats (messages, tokens, cost, session file)'
    },
    {
      name: 'name',
      description: 'Set session display name',
      input: { hint: '<name>' }
    },
    {
      name: 'steering',
      description: 'Get/set pi steering message delivery mode (how queued steering messages are delivered)',
      input: { hint: '(no args to show) all | one-at-a-time' }
    },
    {
      name: 'follow-up',
      description: 'Get/set pi follow-up message delivery mode (how queued follow-up messages are delivered)',
      input: { hint: '(no args to show) all | one-at-a-time' }
    },
    {
      name: 'changelog',
      description: 'Show pi changelog'
    }
  ]
}

function mergeCommands(a: AvailableCommand[], b: AvailableCommand[]): AvailableCommand[] {
  // Preserve order, de-dupe by name (first wins).
  const out: AvailableCommand[] = []
  const seen = new Set<string>()

  for (const c of [...a, ...b]) {
    if (isUnsupportedPiBuiltinCommand(c.name)) continue
    if (seen.has(c.name)) continue
    seen.add(c.name)
    out.push(c)
  }

  return out
}
import { fileURLToPath } from 'node:url'

const pkg = readNearestPackageJson(import.meta.url)

export class PiAcpAgent implements ACPAgent {
  private readonly conn: AgentSideConnection
  private readonly sessions = new SessionManager()
  private readonly store = new SessionStore()
  private readonly restoringSessions = new Map<string, SessionRecovery>()
  private readonly deletingSessionIds = new Set<string>()
  private readonly deleteAttempts = new Map<string, Promise<DeleteSessionResponse>>()
  private readonly pendingFailedNewSessionCleanups = new Set<PiAcpSession>()
  private readonly quarantinedSessionIds = new Set<string>()
  private readonly compatibilityCatalogDiscoveries = new WeakMap<object, Promise<FrozenPiCommandCatalog>>()
  private explicitSessionTail: Promise<void> = Promise.resolve()
  private disposePromise: Promise<void> | null = null
  private disposed = false
  private readonly fixtureStatePreviewEnabled: boolean

  async dispose(): Promise<void> {
    if (!this.disposePromise) {
      this.disposed = true
      const recoveries = [...this.restoringSessions.values()]
      const explicitSessionDrain = this.explicitSessionTail
      for (const recovery of recoveries) recovery.cancelled = true
      // Close manager admission synchronously before awaiting any recovery
      // cleanup, so an already-started session/new cannot publish after the
      // shutdown snapshot.
      const sessionsCleanupAttempt = this.sessions.disposeAll()
      const attempt = (async () => {
        await Promise.allSettled([explicitSessionDrain, ...recoveries.map(recovery => recovery.promise)])
        const sessionsCleanup = await Promise.allSettled([sessionsCleanupAttempt])
        const cleanupFailure = sessionsCleanup.find(result => result.status === 'rejected')
        if (cleanupFailure?.status === 'rejected') throw cleanupFailure.reason
        await this.retryFailedNewSessionCleanups()
      })()
      this.disposePromise = attempt
      void attempt.catch(() => {
        if (this.disposePromise === attempt) this.disposePromise = null
      })
    }
    await this.disposePromise
  }

  // Remember recent session cwd and use it as the default filter.
  private lastSessionCwd: string | null = null

  constructor(conn: AgentSideConnection, _config?: unknown) {
    this.conn = conn
    this.fixtureStatePreviewEnabled = process.env[FIXTURE_STATE_PREVIEW_ENV] === '1'
    void _config
  }

  private discoverCommandCatalog(
    session: PiAcpSession,
    options: PiCommandCatalogOptions
  ): Promise<FrozenPiCommandCatalog> {
    const discover = (
      session as PiAcpSession & {
        discoverCommandCatalogOnce?: (options: PiCommandCatalogOptions) => Promise<FrozenPiCommandCatalog>
      }
    ).discoverCommandCatalogOnce
    if (typeof discover === 'function') return discover.call(session, options)

    const existing = this.compatibilityCatalogDiscoveries.get(session as object)
    if (existing) return existing
    const discovery = runSessionRpc(session, proc => {
      const getCommands = (proc as PiRpcProcess & { getCommands?: () => Promise<unknown> }).getCommands
      // Narrow construction shim for downstream fake sessions that predate
      // C2.2 catalog RPC support. Real PiRpcProcess always has getCommands().
      if (typeof getCommands !== 'function') return Promise.resolve(undefined)
      return getCommands.call(proc)
    }).then(data => freezePiCommandCatalog(data, options))
    this.compatibilityCatalogDiscoveries.set(session as object, discovery)
    void discovery.catch(() => {
      if (this.compatibilityCatalogDiscoveries.get(session as object) === discovery) {
        this.compatibilityCatalogDiscoveries.delete(session as object)
      }
    })
    return discovery
  }

  private scheduleCommandCatalogPublication(session: PiAcpSession, enableSkillCommands: boolean): void {
    // Clients may ignore updates for an unknown sessionId, so publication is
    // intentionally scheduled after the session/new or session/load response.
    setTimeout(() => {
      void (async () => {
        const supports = (session as PiAcpSession & { supportsExecuteCommand?: () => boolean }).supportsExecuteCommand
        const options = {
          enableSkillCommands,
          reserveFixtureStateName: this.fixtureStatePreviewEnabled,
          enableFixtureStateCommand:
            this.fixtureStatePreviewEnabled && typeof supports === 'function' && supports.call(session)
        }
        let catalog: FrozenPiCommandCatalog
        try {
          catalog = await this.discoverCommandCatalog(session, options)
        } catch {
          // Preserve C2.2's builtins-only publication fallback without
          // freezing a failed discovery into the logical session snapshot.
          catalog = freezePiCommandCatalog(undefined, options)
        }
        await this.publishCommandCatalog(session, catalog)
      })().catch(() => undefined)
    }, 0)
  }

  private publishCommandCatalog(session: PiAcpSession, catalog: FrozenPiCommandCatalog): Promise<void> {
    const state = (session as PiAcpSession & { commandCatalogState?: PiCommandCatalogState }).commandCatalogState
    if (!state) {
      return this.conn.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: mergeCommands([...catalog.commands], builtinAvailableCommands())
        }
      })
    }
    if (state.publishedSnapshot === catalog) return Promise.resolve()

    const current = state.publication
    if (current) {
      if (state.publicationSnapshot === catalog) return current
      return current.catch(() => undefined).then(() => this.publishCommandCatalog(session, catalog))
    }

    const publication = this.conn
      .sessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: mergeCommands([...catalog.commands], builtinAvailableCommands())
        }
      })
      .then(() => {
        state.publishedSnapshot = catalog
      })
    state.publicationSnapshot = catalog
    state.publication = publication
    const clear = (): void => {
      if (state.publication !== publication) return
      state.publication = null
      state.publicationSnapshot = null
    }
    void publication.then(clear, clear)
    return publication
  }

  private commandReservationOutcome(
    session: PiAcpSession,
    reservation: SessionCommandReservation
  ): SessionExecuteCommandOutcome | null {
    const checkpoint = (
      session as PiAcpSession & {
        commandReservationOutcome?: (reservation: SessionCommandReservation) => SessionExecuteCommandOutcome | null
      }
    ).commandReservationOutcome
    return typeof checkpoint === 'function' ? checkpoint.call(session, reservation) : null
  }

  private async executeFixtureStatePreview(
    session: PiAcpSession,
    invocation: FixtureStateInvocation,
    hasAttachments: boolean
  ): Promise<PromptResponse | null> {
    const reserve = (
      session as PiAcpSession & {
        reserveCommand?: (name: string) => SessionCommandReservation
      }
    ).reserveCommand
    let reservation: SessionCommandReservation
    try {
      reservation =
        typeof reserve === 'function'
          ? reserve.call(session, FIXTURE_STATE_COMMAND_NAME)
          : Object.freeze({ requestId: crypto.randomUUID(), name: FIXTURE_STATE_COMMAND_NAME })
    } catch (error) {
      if (error instanceof PiAcpCommandBusyError) {
        return fixtureStateRefusal(crypto.randomUUID(), 'COMMAND_BUSY')
      }
      throw error
    }

    const release = (
      session as PiAcpSession & {
        releaseCommand?: (reservation: SessionCommandReservation) => void
      }
    ).releaseCommand
    try {
      const supports = (session as PiAcpSession & { supportsExecuteCommand?: () => boolean }).supportsExecuteCommand
      const sessionCwd = (session as PiAcpSession & { cwd?: unknown }).cwd
      const options = {
        enableSkillCommands: typeof sessionCwd === 'string' ? getEnableSkillCommands(sessionCwd) : true,
        reserveFixtureStateName: this.fixtureStatePreviewEnabled,
        enableFixtureStateCommand:
          this.fixtureStatePreviewEnabled && typeof supports === 'function' && supports.call(session)
      }

      let catalog: FrozenPiCommandCatalog
      try {
        catalog = await this.discoverCommandCatalog(session, options)
      } catch (error) {
        const interrupted = this.commandReservationOutcome(session, reservation)
        if (interrupted?.kind === 'cancelled') return fixtureStateCancelled(interrupted.requestId)
        if (
          error instanceof RequestError &&
          (error.data as { code?: unknown } | undefined)?.code === PI_RPC_PROCESS_TERMINATED_CODE
        ) {
          throw error
        }
        throw RequestError.internalError(
          { code: FIXTURE_STATE_CATALOG_DISCOVERY_FAILED_CODE },
          'Pi command catalog discovery failed; /fixture-state was not sent.'
        )
      }
      const afterDiscovery = this.commandReservationOutcome(session, reservation)
      if (afterDiscovery?.kind === 'cancelled') return fixtureStateCancelled(afterDiscovery.requestId)

      if (!this.fixtureStatePreviewEnabled && catalog.fixtureStateExtensionCount === 0) return null
      if (hasAttachments) {
        return fixtureStateRefusal(reservation.requestId, 'COMMAND_INVALID_REQUEST', 'attachments')
      }
      if (!this.fixtureStatePreviewEnabled) {
        return fixtureStateRefusal(reservation.requestId, 'COMMAND_NOT_FOUND', 'disabled')
      }
      if (!catalog.hasFixtureStateExtension) {
        return fixtureStateRefusal(reservation.requestId, 'COMMAND_NOT_FOUND', 'collision')
      }
      if (typeof supports !== 'function' || !supports.call(session)) {
        return fixtureStateRefusal(reservation.requestId, 'COMMAND_NOT_FOUND', 'capability')
      }

      const fixtureWasExposed = catalog.commands.some(command => command.name === FIXTURE_STATE_COMMAND_NAME)
      if (!fixtureWasExposed) {
        return fixtureStateRefusal(reservation.requestId, 'COMMAND_NOT_FOUND', 'collision')
      }

      try {
        await this.publishCommandCatalog(session, catalog)
      } catch (error) {
        const interrupted = this.commandReservationOutcome(session, reservation)
        if (interrupted?.kind === 'cancelled') return fixtureStateCancelled(interrupted.requestId)
        throw error
      }
      const afterPublication = this.commandReservationOutcome(session, reservation)
      if (afterPublication?.kind === 'cancelled') return fixtureStateCancelled(afterPublication.requestId)

      const executeReserved = (
        session as PiAcpSession & {
          executeReservedCommand?: (
            reservation: SessionCommandReservation,
            args: string
          ) => Promise<SessionExecuteCommandOutcome>
        }
      ).executeReservedCommand
      const outcome =
        typeof executeReserved === 'function'
          ? await executeReserved.call(session, reservation, invocation.args)
          : await session.executeCommand(FIXTURE_STATE_COMMAND_NAME, invocation.args)

      if (outcome.kind === 'cancelled') return fixtureStateCancelled(outcome.requestId)
      if (outcome.response.success) return fixtureStateHandled(outcome.requestId)
      return fixtureStateRefusal(outcome.requestId, outcome.response.data.code)
    } finally {
      if (typeof release === 'function') release.call(session, reservation)
    }
  }

  private runExplicitSessionTransaction<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void
    const slot = new Promise<void>(resolve => {
      release = resolve
    })
    const previous = this.explicitSessionTail
    this.explicitSessionTail = previous.catch(() => undefined).then(() => slot)

    return (async () => {
      await previous.catch(() => undefined)
      try {
        return await operation()
      } finally {
        release()
      }
    })()
  }

  private async cleanupFailedNewSession(session: PiAcpSession): Promise<FailedNewSessionCleanupResult> {
    const sessionId = session.sessionId
    try {
      const closed = await this.sessions.close(sessionId, session)
      if (closed === false) {
        const current = (
          this.sessions as SessionManager & { maybeGet?: (id: string) => PiAcpSession | undefined }
        ).maybeGet?.(sessionId)
        // A different live generation owns this ID: never touch its mapping.
        // If shutdown already proved the original child stopped and removed
        // it, exact durable cleanup may still finish below.
        if (current && current !== session) return 'superseded'
        if (current || this.sessionIsAlive(session)) return 'process_unconfirmed'
      }
    } catch {
      // Preserve the primary startup/auth error, but keep the durable file and
      // mapping while child cleanup is unconfirmed.
      return 'process_unconfirmed'
    }

    return this.cleanupFailedNewSessionArtifacts(session)
  }

  private cleanupFailedNewSessionArtifacts(session: PiAcpSession): FailedNewSessionCleanupResult {
    const sessionId = session.sessionId
    const exactMapping = session.sessionFile ? { cwd: session.cwd, sessionFile: session.sessionFile } : null

    // Only the immutable identity captured before publication is safe to
    // delete. If the exact header/file cannot be proven, retain both the cache
    // mapping and generation tombstone for an explicit cleanup retry.
    if (!exactMapping) return 'artifact_quarantined'
    let currentMapping: ReturnType<SessionStore['get']>
    try {
      currentMapping = this.store.get(sessionId)
    } catch {
      return 'artifact_quarantined'
    }
    if (
      currentMapping &&
      (currentMapping.cwd !== exactMapping.cwd || currentMapping.sessionFile !== exactMapping.sessionFile)
    ) {
      return 'artifact_quarantined'
    }
    if (existsSync(exactMapping.sessionFile)) {
      if (!this.validDurableMapping(sessionId, exactMapping)) return 'artifact_quarantined'
      try {
        unlinkSync(exactMapping.sessionFile)
      } catch {
        return 'artifact_quarantined'
      }
    }
    if (currentMapping) {
      try {
        this.store.delete(sessionId)
      } catch {
        return 'artifact_quarantined'
      }
    }
    ;(this.sessions as SessionManager & { forget?: (id: string) => void }).forget?.(sessionId)
    return 'complete'
  }

  private async retryFailedNewSessionCleanups(): Promise<Set<string>> {
    const processed = new Set<string>()
    for (const session of [...this.pendingFailedNewSessionCleanups]) {
      const result = await this.cleanupFailedNewSession(session)
      if (result === 'process_unconfirmed') throw sessionRecoveryUnavailableError()
      this.pendingFailedNewSessionCleanups.delete(session)
      if (result === 'artifact_quarantined') this.quarantinedSessionIds.add(session.sessionId)
      processed.add(session.sessionId)
    }
    return processed
  }

  private retireDeletedSessionCleanupState(sessionId: string): void {
    this.quarantinedSessionIds.delete(sessionId)
    for (const session of [...this.pendingFailedNewSessionCleanups]) {
      if (session.sessionId === sessionId && !this.sessionIsAlive(session)) {
        this.pendingFailedNewSessionCleanups.delete(session)
      }
    }
  }

  private async cleanupFailedLoadSession(session: PiAcpSession): Promise<void> {
    try {
      await this.sessions.close(session.sessionId, session)
    } catch {
      // SessionManager retains an unconfirmed exact child as the admission
      // blocker. Loading never deletes the durable transcript or mapping.
    }
  }

  private findStoredSession(sessionId: string): { cwd: string; sessionFile: string } | null {
    const stored = this.store.get(sessionId)
    if (stored?.cwd && stored?.sessionFile) {
      return { cwd: stored.cwd, sessionFile: stored.sessionFile }
    }

    const discovered = listPiSessions().filter(session => session.sessionId === sessionId)
    if (discovered.length > 1) throw sessionRecoveryUnavailableError()
    const piSession = discovered.length === 1 ? discovered[0] : null
    if (!piSession) return null

    try {
      this.store.upsert({
        sessionId,
        cwd: piSession.cwd,
        sessionFile: piSession.sessionFile
      })
    } catch {
      // Discovery remains usable for this recovery attempt even if the cache
      // refresh cannot be persisted.
    }

    return {
      cwd: piSession.cwd,
      sessionFile: piSession.sessionFile
    }
  }

  private async restoreSession(
    sessionId: string,
    opts?: { cwd?: string; mcpServers?: LoadSessionRequest['mcpServers'] }
  ): Promise<PiAcpSession> {
    if (this.disposed) throw sessionRecoveryUnavailableError()
    if (this.deletingSessionIds.has(sessionId)) throw sessionRecoveryUnavailableError()

    const inFlight = this.restoringSessions.get(sessionId)
    if (inFlight) {
      if (inFlight.blockedCleanup) return this.retryBlockedRecovery(sessionId, inFlight, opts)
      return inFlight.promise
    }
    if (this.quarantinedSessionIds.has(sessionId)) throw sessionRecoveryUnavailableError()

    const snapshot = this.sessionSnapshot(sessionId)
    if (
      snapshot &&
      this.sessionIsAlive(snapshot.session) &&
      !this.pendingFailedNewSessionCleanups.has(snapshot.session)
    ) {
      return snapshot.session
    }

    const stored = this.findStoredSession(sessionId)
    const generation = snapshot?.generation ?? this.currentSessionGeneration(sessionId)
    if (!stored && !snapshot) {
      if (generation > 0) throw sessionRecoveryUnavailableError()
      throw RequestError.invalidParams(`Unknown sessionId: ${sessionId}`)
    }
    let resolveRecovery!: (session: PiAcpSession) => void
    let rejectRecovery!: (error: unknown) => void
    const promise = new Promise<PiAcpSession>((resolve, reject) => {
      resolveRecovery = resolve
      rejectRecovery = reject
    })
    const recovery: SessionRecovery = {
      identity: Symbol(`session-recovery:${sessionId}:${generation}`),
      generation,
      promise,
      candidate: null,
      candidateSession: null,
      cancelled: false,
      blockedCleanup: false,
      cleanupRetry: null,
      commandCatalogState: snapshot?.session.commandCatalogState ?? null
    }

    // This synchronous publication is the active(g) -> recovering(g, identity,
    // promise) CAS. Every peer observes and awaits this exact promise.
    this.restoringSessions.set(sessionId, recovery)
    void this.runSessionRecovery(sessionId, stored, recovery, opts)
      .then(resolveRecovery, rejectRecovery)
      .finally(() => {
        if (!recovery.blockedCleanup && this.restoringSessions.get(sessionId) === recovery) {
          this.restoringSessions.delete(sessionId)
        }
      })

    return promise
  }

  private async retryBlockedRecovery(
    sessionId: string,
    recovery: SessionRecovery,
    opts?: { cwd?: string; mcpServers?: LoadSessionRequest['mcpServers'] }
  ): Promise<PiAcpSession> {
    if (this.disposed || recovery.cancelled) throw sessionRecoveryUnavailableError()
    if (this.restoringSessions.get(sessionId) !== recovery) return this.restoreSession(sessionId, opts)

    if (!recovery.cleanupRetry) {
      const retry = (async () => {
        const candidate = recovery.candidate
        if (recovery.candidateSession) await recovery.candidateSession.dispose()
        else if (candidate) await candidate.stop()
        else throw sessionRecoveryUnavailableError()
        if (candidate) this.releaseRecoveryCandidate(candidate)
        recovery.candidateSession = null
        recovery.candidate = null
        recovery.blockedCleanup = false
      })()
      recovery.cleanupRetry = retry
      void retry
        .finally(() => {
          if (recovery.cleanupRetry === retry) recovery.cleanupRetry = null
        })
        .catch(() => undefined)
    }

    try {
      await recovery.cleanupRetry
    } catch {
      // Reuse the original stable public failure while retaining the candidate
      // handle for another bounded cleanup attempt.
      return recovery.promise
    }
    if (this.disposed || recovery.cancelled) throw sessionRecoveryUnavailableError()
    if (this.restoringSessions.get(sessionId) !== recovery) return this.restoreSession(sessionId, opts)
    this.restoringSessions.delete(sessionId)
    return this.restoreSession(sessionId, opts)
  }

  private async runSessionRecovery(
    sessionId: string,
    stored: { cwd: string; sessionFile: string } | null,
    recovery: SessionRecovery,
    opts?: { cwd?: string; mcpServers?: LoadSessionRequest['mcpServers'] }
  ): Promise<PiAcpSession> {
    const isDeadGenerationRecovery = recovery.generation > 0
    let candidateSession: PiAcpSession | null = null
    let releaseSpawnLease: (() => void) | null = null

    try {
      // The recovery identity is already synchronously published, so peers
      // coalesce while the leader proves any globally retained failed-create
      // process. Cleanup can remove this same ID's mapping/tombstone; rebuild
      // all recovery inputs afterward and never spawn from the stale capture.
      await this.retryFailedNewSessionCleanups()
      if (this.quarantinedSessionIds.has(sessionId)) throw sessionRecoveryUnavailableError()

      if (this.disposed || recovery.cancelled) throw sessionRecoveryUnavailableError()
      const currentSnapshot = this.sessionSnapshot(sessionId)
      if (currentSnapshot) {
        if (currentSnapshot.generation !== recovery.generation) {
          if (this.sessionIsAlive(currentSnapshot.session)) return currentSnapshot.session
          throw sessionRecoveryUnavailableError()
        }
        if (this.sessionIsAlive(currentSnapshot.session)) return currentSnapshot.session
        const closed = await this.sessions.close(sessionId, currentSnapshot.session)
        if (!closed) {
          const winner = this.sessions.maybeGet(sessionId)
          if (winner && this.sessionIsAlive(winner)) return winner
          throw sessionRecoveryUnavailableError()
        }
      }

      if (this.disposed || recovery.cancelled) throw sessionRecoveryUnavailableError()
      const refreshedStored = this.findStoredSession(sessionId)
      if (
        this.currentSessionGeneration(sessionId) !== recovery.generation ||
        !refreshedStored ||
        !this.validDurableMapping(sessionId, refreshedStored)
      ) {
        throw sessionRecoveryUnavailableError()
      }
      stored = refreshedStored

      try {
        const acquire = (
          this.sessions as SessionManager & {
            acquireSpawnLease?: () => Promise<() => void>
          }
        ).acquireSpawnLease
        releaseSpawnLease = typeof acquire === 'function' ? await acquire.call(this.sessions) : () => undefined
      } catch {
        throw sessionRecoveryUnavailableError()
      }

      const cwd = opts?.cwd ?? stored.cwd
      recovery.candidate = await PiRpcProcess.spawn({
        cwd,
        sessionPath: stored.sessionFile,
        piCommand: process.env.PI_ACP_PI_COMMAND,
        handshakeTimeoutMs: SESSION_RECOVERY_HANDSHAKE_TIMEOUT_MS
      })
      this.trackRecoveryCandidate(recovery.candidate)

      if (this.disposed || recovery.cancelled) throw sessionRecoveryUnavailableError()

      // Timeout-mode spawn requires and retains one successful get_state. Use
      // that exact response so recovery has one 2s handshake budget rather
      // than starting a second independently bounded identity probe.
      const state = recovery.candidate.getStartupHandshakeState() as any
      if (
        state?.sessionId !== sessionId ||
        state?.sessionFile !== stored.sessionFile ||
        !recovery.candidate.isAlive()
      ) {
        throw sessionRecoveryUnavailableError()
      }

      candidateSession = this.createDetachedSession(sessionId, {
        cwd,
        mcpServers: opts?.mcpServers ?? [],
        conn: this.conn,
        proc: recovery.candidate,
        initialState: state,
        ...(recovery.commandCatalogState ? { commandCatalogState: recovery.commandCatalogState } : {})
      })
      recovery.candidateSession = candidateSession
      this.trackRecoveryCandidate(recovery.candidate, candidateSession)

      if (this.disposed || recovery.cancelled || !this.sessionIsAlive(candidateSession)) {
        throw sessionRecoveryUnavailableError()
      }

      if (this.restoringSessions.get(sessionId) !== recovery) {
        throw sessionRecoveryUnavailableError()
      }

      if (!this.publishReplacementSession(sessionId, recovery.generation, candidateSession)) {
        try {
          await candidateSession.dispose()
        } catch {
          recovery.blockedCleanup = true
          this.retainRecoveryCandidate(recovery.candidate, candidateSession)
          throw sessionRecoveryUnavailableError()
        }
        this.releaseRecoveryCandidate(recovery.candidate)
        candidateSession = null
        recovery.candidateSession = null
        recovery.candidate = null
        const winner = this.sessions.maybeGet(sessionId)
        if (winner && this.sessionIsAlive(winner)) return winner
        throw sessionRecoveryUnavailableError()
      }

      this.releaseRecoveryCandidate(recovery.candidate)
      recovery.candidate = null
      recovery.candidateSession = null
      const publishedSession = candidateSession
      candidateSession = null
      this.lastSessionCwd = cwd
      try {
        // Refresh only after winning the generation CAS. A losing candidate
        // must never overwrite a concurrent winner's newer durable mapping,
        // and a redundant refresh failure must not contradict live g+1.
        this.store.upsert({ sessionId, cwd, sessionFile: stored.sessionFile })
      } catch {
        // The mapping was already validated before spawn and remains usable.
      }
      return publishedSession
    } catch (error) {
      if (error instanceof PiRpcSpawnError && error.candidate) {
        recovery.candidate = error.candidate
        this.retainRecoveryCandidate(error.candidate)
        // spawn() exposes a candidate only after its own bounded cleanup
        // attempt failed. Do not issue a second stop in this transaction.
        recovery.blockedCleanup = true
      }

      // A failed cleanup attempt is proof of nothing; retain the exact
      // candidate and do not immediately issue a second stop in the same
      // recovery transaction. The next request/dispose/delete owns the retry.
      if (!recovery.blockedCleanup && !this.disposed && !recovery.cancelled) {
        if (candidateSession) {
          const cleanupSession = candidateSession
          try {
            await cleanupSession.dispose()
            if (recovery.candidate) this.releaseRecoveryCandidate(recovery.candidate)
            candidateSession = null
            recovery.candidateSession = null
            recovery.candidate = null
            recovery.blockedCleanup = false
          } catch {
            // Retain the exact losing candidate and recovery promise. Future
            // operations must observe this blocked slot, never spawn around an
            // unconfirmed cleanup.
            recovery.blockedCleanup = true
            if (recovery.candidate) this.retainRecoveryCandidate(recovery.candidate, cleanupSession)
          }
        } else if (recovery.candidate) {
          const cleanupCandidate = recovery.candidate
          try {
            await cleanupCandidate.stop()
            this.releaseRecoveryCandidate(cleanupCandidate)
            recovery.candidate = null
            recovery.blockedCleanup = false
          } catch {
            recovery.blockedCleanup = true
            this.retainRecoveryCandidate(cleanupCandidate)
          }
        }
      }

      if (recovery.blockedCleanup) throw sessionRecoveryUnavailableError()
      if (!isDeadGenerationRecovery && error instanceof PiRpcSpawnError) {
        const data = piRpcSpawnErrorData(error)
        if (error.diagnostic) throw new RequestError(-32603, error.message, data)
        throw RequestError.internalError(data, error.message)
      }
      if (!isDeadGenerationRecovery && error instanceof RequestError) throw error
      throw sessionRecoveryUnavailableError()
    } finally {
      releaseSpawnLease?.()
    }
  }

  private sessionSnapshot(sessionId: string): { generation: number; session: PiAcpSession } | undefined {
    const snapshot = (
      this.sessions as SessionManager & {
        snapshot?: (id: string) => { generation: number; session: PiAcpSession } | undefined
      }
    ).snapshot
    if (typeof snapshot === 'function') return snapshot.call(this.sessions, sessionId)

    const session = this.sessions.maybeGet(sessionId)
    return session ? { generation: 0, session } : undefined
  }

  private trackRecoveryCandidate(candidate: PiRpcProcess, session?: PiAcpSession): void {
    ;(
      this.sessions as SessionManager & {
        trackUnpublishedCandidate?: (candidate: PiRpcProcess, session?: PiAcpSession) => void
      }
    ).trackUnpublishedCandidate?.(candidate, session)
  }

  private retainRecoveryCandidate(candidate: PiRpcProcess, session?: PiAcpSession): void {
    ;(
      this.sessions as SessionManager & {
        retainUnconfirmedCandidate?: (candidate: PiRpcProcess, session?: PiAcpSession) => void
      }
    ).retainUnconfirmedCandidate?.(candidate, session)
  }

  private releaseRecoveryCandidate(candidate: PiRpcProcess): void {
    ;(
      this.sessions as SessionManager & {
        releaseCandidate?: (candidate: PiRpcProcess) => void
      }
    ).releaseCandidate?.(candidate)
  }

  private currentSessionGeneration(sessionId: string): number {
    const current = (this.sessions as SessionManager & { currentGeneration?: (id: string) => number }).currentGeneration
    return typeof current === 'function' ? current.call(this.sessions, sessionId) : 0
  }

  private createDetachedSession(
    sessionId: string,
    params: Parameters<SessionManager['createDetached']>[1]
  ): PiAcpSession {
    const createDetached = (
      this.sessions as SessionManager & {
        createDetached?: SessionManager['createDetached']
      }
    ).createDetached
    if (typeof createDetached === 'function') return createDetached.call(this.sessions, sessionId, params)
    return this.sessions.getOrCreate(sessionId, params)
  }

  private publishReplacementSession(sessionId: string, generation: number, session: PiAcpSession): boolean {
    const publish = (
      this.sessions as SessionManager & {
        publishReplacement?: SessionManager['publishReplacement']
      }
    ).publishReplacement
    return typeof publish === 'function' ? publish.call(this.sessions, sessionId, generation, session) : true
  }

  private validDurableMapping(sessionId: string, stored: { cwd: string; sessionFile: string }): boolean {
    if (!isAbsolute(stored.cwd) || !isAbsolute(stored.sessionFile)) return false

    let fd: number | null = null
    try {
      const stat = statSync(stored.sessionFile)
      if (!stat.isFile() || stat.size <= 0) return false

      fd = openSync(stored.sessionFile, 'r')
      const buffer = Buffer.alloc(Math.min(stat.size, 64 * 1024))
      const bytesRead = readSync(fd, buffer, 0, buffer.length, 0)
      const head = buffer.subarray(0, bytesRead).toString('utf8')
      const newline = head.indexOf('\n')
      if (newline < 0 && stat.size > buffer.length) return false
      const firstLine = (newline < 0 ? head : head.slice(0, newline)).trim()
      const header = JSON.parse(firstLine) as any
      return (
        header?.type === 'session' &&
        typeof header?.version === 'number' &&
        Number.isFinite(header.version) &&
        header?.id === sessionId &&
        typeof header?.cwd === 'string' &&
        isAbsolute(header.cwd)
      )
    } catch {
      return false
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {
          // ignore
        }
      }
    }
  }

  private sessionIsAlive(session: PiAcpSession): boolean {
    const sessionCheck = (session as PiAcpSession & { isAlive?: () => boolean }).isAlive
    if (typeof sessionCheck === 'function') return sessionCheck.call(session)

    // Compatibility for narrowly mocked sessions in unit tests. Production
    // PiAcpSession instances always expose isAlive().
    const procCheck = (session.proc as PiRpcProcess & { isAlive?: () => boolean }).isAlive
    return typeof procCheck === 'function' ? procCheck.call(session.proc) : true
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    // We currently only support ACP protocol version 1.
    const supportedVersion = 1
    const requested = params.protocolVersion

    return {
      protocolVersion: requested === supportedVersion ? requested : supportedVersion,
      agentInfo: {
        name: pkg.name ?? 'pi-acp',
        title: 'pi ACP adapter',
        version: pkg.version ?? '0.0.0'
      },
      // Zed currently uses ClientCapabilities._meta["terminal-auth"] to decide whether to show
      // the "Authenticate" banner/button. If not supported, we still return the method for the registry.
      authMethods: getAuthMethods({
        supportsTerminalAuthMeta: (params as any)?.clientCapabilities?._meta?.['terminal-auth'] === true
      }),
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: false, sse: false },
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: process.env.PI_ACP_ENABLE_EMBEDDED_CONTEXT === 'true'
        },
        sessionCapabilities: {
          // **UNSTABLE** ACP capability used by Zed's codex-acp adapter.
          // Enables a native session picker in clients that support it.
          list: {},
          delete: {}
        }
      }
    }
  }

  newSession(params: NewSessionRequest) {
    return this.runExplicitSessionTransaction(() => this.newSessionOwned(params))
  }

  private async newSessionOwned(params: NewSessionRequest) {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`)
    }
    if (this.disposed) throw sessionRecoveryUnavailableError()

    // A previously unreturned child must have both process teardown and exact
    // artifact cleanup proven before another explicit create may spawn.
    await this.retryFailedNewSessionCleanups()

    this.lastSessionCwd = params.cwd

    const enableSkillCommands = getEnableSkillCommands(params.cwd)

    // Pi doesn't support mcpServers, but we accept and store.
    let session: PiAcpSession
    try {
      session = await this.sessions.create({
        cwd: params.cwd,
        mcpServers: params.mcpServers,
        conn: this.conn,
        piCommand: process.env.PI_ACP_PI_COMMAND
      })
    } catch (error) {
      if (!(error instanceof SessionCreateRollbackError)) throw error

      // SessionManager already made the transaction's one process-cleanup
      // attempt. A failed proof becomes the exact pending admission barrier;
      // a successful proof permits artifact-only cleanup without another stop.
      const cleanup =
        error.cleanupStatus === 'process_stopped'
          ? this.cleanupFailedNewSessionArtifacts(error.session)
          : 'process_unconfirmed'
      if (!this.deletingSessionIds.has(error.session.sessionId)) {
        if (cleanup === 'process_unconfirmed') this.pendingFailedNewSessionCleanups.add(error.session)
        else this.pendingFailedNewSessionCleanups.delete(error.session)
        if (cleanup === 'artifact_quarantined') this.quarantinedSessionIds.add(error.session.sessionId)
      }
      throw error.originalError
    }

    try {
      // Reuse the authoritative pre-publication state captured by SessionManager
      // and fetch models in parallel. Narrow test doubles without initialState
      // retain the legacy getState fallback.
      let state: any = null
      let availableModels: any = null
      let stateErr: unknown = null
      let availableModelsErr: unknown = null

      const initialState = (session as PiAcpSession & { initialState?: unknown }).initialState
      await Promise.all([
        initialState != null
          ? Promise.resolve().then(() => {
              state = initialState as any
            })
          : session.proc
              .getState()
              .then(s => {
                state = s as any
              })
              .catch(err => {
                stateErr = err
                state = null
              }),
        session.proc
          .getAvailableModels()
          .then(m => {
            availableModels = m as any
          })
          .catch(err => {
            availableModelsErr = err
            availableModels = null
          })
      ])

      const terminalProbeError = [stateErr, availableModelsErr].find(
        error => error instanceof PiRpcProcessTerminatedError
      ) as PiRpcProcessTerminatedError | undefined
      if (terminalProbeError) {
        throw piRpcProcessRequestError(terminalProbeError)
      }

      const availableModelsAuthErr = maybeAuthRequiredError(availableModelsErr)

      if (availableModelsAuthErr) {
        throw availableModelsAuthErr
      }

      if (availableModelsErr) {
        throw RequestError.internalError({}, String((availableModelsErr as Error)?.message ?? availableModelsErr))
      }

      // If pi has no models available after spawning, it's effectively unauthenticated.
      const rawModelsCount = Array.isArray(availableModels?.models) ? availableModels.models.length : 0

      if (rawModelsCount === 0) {
        throw RequestError.authRequired(
          { authMethods: getAuthMethods() },
          'Configure an API key or log in with an OAuth provider.'
        )
      }

      if (stateErr && maybeAuthRequiredError(stateErr)) {
        throw RequestError.authRequired(
          { authMethods: getAuthMethods() },
          'Configure an API key or log in with an OAuth provider.'
        )
      }

      const configuration = await runSessionRpc(session, proc =>
        getSessionConfiguration(proc, {
          state,
          availableModels
        })
      )
      const { configOptions, models, modes } = configuration

      const quietStartup = getQuietStartup(params.cwd)
      const updateNotice = buildUpdateNotice()

      // quietStartup suppresses discovery details, but never the forced-trust disclosure.
      const preludeText = quietStartup
        ? [PROJECT_TRUST_WARNING, updateNotice].filter(Boolean).join('\n\n') + '\n'
        : buildStartupInfo({
            cwd: params.cwd,
            updateNotice
          })

      if (preludeText) session.setStartupInfo(preludeText)

      try {
        // Preserve the healthy current session until the candidate is fully
        // configured. Commit the one-child policy only at the response boundary.
        await (this.sessions as any).closeAllExcept?.(session.sessionId)
      } catch {
        // This candidate was never returned to the client. Remove its mapping
        // and file only after SessionManager proves exact child cleanup; on
        // failure it retains the registered session as the global barrier.
        throw sessionRecoveryUnavailableError()
      }

      const maybeGet = (this.sessions as SessionManager & { maybeGet?: (id: string) => PiAcpSession | undefined })
        .maybeGet
      const exactSessionStillPublished =
        typeof maybeGet !== 'function' || maybeGet.call(this.sessions, session.sessionId) === session
      if (this.disposed || !this.sessionIsAlive(session) || !exactSessionStillPublished) {
        throw sessionRecoveryUnavailableError()
      }

      const response = {
        sessionId: session.sessionId,
        configOptions,
        models,
        modes,
        _meta: {
          piAcp: {
            startupInfo: preludeText || null
          }
        }
      }

      // Try to send it immediately after session/new returns; if the client ignores it,
      // it will still be emitted as the first chunk of the first prompt.
      if (preludeText) setTimeout(() => session.sendStartupInfoIfPending(), 0)

      this.scheduleCommandCatalogPublication(session, enableSkillCommands)

      return response
    } catch (error) {
      // Once create() publishes a child, every failure before the response is
      // transactional. Cleanup is exact-session CAS and never touches a newer
      // replacement that may have won concurrently.
      const cleanup = await this.cleanupFailedNewSession(session)
      if (!this.deletingSessionIds.has(session.sessionId)) {
        if (cleanup === 'process_unconfirmed') this.pendingFailedNewSessionCleanups.add(session)
        else this.pendingFailedNewSessionCleanups.delete(session)
        if (cleanup === 'artifact_quarantined') this.quarantinedSessionIds.add(session.sessionId)
      }
      throw error
    }
  }

  async authenticate(_params: AuthenticateRequest) {
    // Terminal Auth is handled out-of-band by re-launching the binary with `--terminal-login`.
    // If the client calls `authenticate` anyway, we can no-op successfully.
    return
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = await this.restoreSession(params.sessionId)

    const { message, images } = promptToPiMessage(params.prompt)
    const unsupportedPiBuiltin = findUnsupportedPiBuiltinCommand(message)
    if (unsupportedPiBuiltin) return unsupportedPiBuiltinPromptResponse(unsupportedPiBuiltin)

    // Built-in ACP slash command handling (headless-friendly subset).
    if (images.length === 0 && message.trimStart().startsWith('/')) {
      const trimmed = message.trim()
      const space = trimmed.indexOf(' ')
      const cmd = space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)
      const argsString = space === -1 ? '' : trimmed.slice(space + 1)
      const args = parseCommandArgs(argsString)

      if (cmd === 'compact') {
        const customInstructions = args.join(' ').trim() || undefined
        const res = await runSessionMutation(session, 'compact', () =>
          runSessionRpc(session, proc => proc.compact(customInstructions))
        )

        const r: any = res && typeof res === 'object' ? (res as any) : null
        const tokensBefore = typeof r?.tokensBefore === 'number' ? r.tokensBefore : null
        const summary = typeof r?.summary === 'string' ? r.summary : null

        const headerLines = [
          `Compaction completed.${customInstructions ? ' (custom instructions applied)' : ''}`,
          tokensBefore !== null ? `Tokens before: ${tokensBefore}` : null
        ].filter(Boolean)

        const text = headerLines.join('\n') + (summary ? `\n\n${summary}` : '')

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'session') {
        const stats = (await runSessionRpc(session, proc => proc.getSessionStats())) as any

        const lines: string[] = []
        if (stats?.sessionId) lines.push(`Session: ${stats.sessionId}`)
        if (stats?.sessionFile) lines.push(`Session file: ${stats.sessionFile}`)
        if (typeof stats?.totalMessages === 'number') lines.push(`Messages: ${stats.totalMessages}`)

        if (typeof stats?.cost === 'number') lines.push(`Cost: ${stats.cost}`)

        const t = stats?.tokens
        if (t && typeof t === 'object') {
          const parts: string[] = []
          if (typeof t.input === 'number') parts.push(`in ${t.input}`)
          if (typeof t.output === 'number') parts.push(`out ${t.output}`)
          if (typeof t.cacheRead === 'number') parts.push(`cache read ${t.cacheRead}`)
          if (typeof t.cacheWrite === 'number') parts.push(`cache write ${t.cacheWrite}`)
          if (typeof t.total === 'number') parts.push(`total ${t.total}`)
          if (parts.length) lines.push(`Tokens: ${parts.join(', ')}`)
        }

        // Fallback if stats shape changes.
        const text = lines.length ? lines.join('\n') : `Session stats:\n${JSON.stringify(stats, null, 2)}`

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'name') {
        const name = args.join(' ').trim()
        if (!name) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Usage: /name <name>' }
            }
          })
          return { stopReason: 'end_turn' }
        }

        try {
          await runSessionMutation(session, 'set_session_name', () =>
            runSessionRpc(session, proc => proc.setSessionName(name))
          )
        } catch (e: any) {
          if (e instanceof RequestError) throw e
          const msg = String(e?.message ?? e)
          const hint = /set_session_name/i.test(msg)
            ? ' This requires a newer pi version that supports `set_session_name` in RPC mode.'
            : ''

          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Failed to set session name: ${msg}${hint}` }
            }
          })
          return { stopReason: 'end_turn' }
        }

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'session_info_update',
            title: name,
            updatedAt: new Date().toISOString()
          }
        })

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Session name set: ${name}` }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'steering') {
        const modeRaw = String(args[0] ?? '').toLowerCase()

        // If no arg, just report current.
        if (!modeRaw) {
          const state = (await runSessionRpc(session, proc => proc.getState())) as any
          const current = String(state?.steeringMode ?? '')
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: `Steering mode: ${current || 'unknown'}`
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        if (modeRaw !== 'all' && modeRaw !== 'one-at-a-time') {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Usage: /steering all | /steering one-at-a-time'
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        await runSessionMutation(session, 'set_steering_mode', () =>
          runSessionRpc(session, proc => proc.setSteeringMode(modeRaw as 'all' | 'one-at-a-time'))
        )

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Steering mode set to: ${modeRaw}` }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'follow-up') {
        const modeRaw = String(args[0] ?? '').toLowerCase()

        // If no arg, just report current.
        if (!modeRaw) {
          const state = (await runSessionRpc(session, proc => proc.getState())) as any
          const current = String(state?.followUpMode ?? '')
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: `Follow-up mode: ${current || 'unknown'}`
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        if (modeRaw !== 'all' && modeRaw !== 'one-at-a-time') {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Usage: /follow-up all | /follow-up one-at-a-time'
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        await runSessionMutation(session, 'set_follow_up_mode', () =>
          runSessionRpc(session, proc => proc.setFollowUpMode(modeRaw as 'all' | 'one-at-a-time'))
        )

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Follow-up mode set to: ${modeRaw}` }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'changelog') {
        // Read pi's installed CHANGELOG.md. Adapter-side, no model call.
        const findChangelog = (): string | null => {
          // 1) Locate the installed pi package by resolving the `pi` executable.
          // On Node installs, `pi` typically resolves to .../@earendil-works/pi-coding-agent/dist/cli.js
          try {
            const whichCmd = process.platform === 'win32' ? 'where' : 'which'
            const which = spawnSync(whichCmd, ['pi'], { encoding: 'utf-8' })
            const piPath = String(which.stdout ?? '')
              .split(/\r?\n/)[0]
              ?.trim()

            if (piPath) {
              const resolved = realpathSync(piPath)
              const pkgRoot = dirname(dirname(resolved))
              const p = join(pkgRoot, 'CHANGELOG.md')
              if (existsSync(p)) return p
            }
          } catch {
            // ignore
          }

          // 2) Fallback: ask npm where global modules live.
          try {
            const npmRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf-8' })
            const root = String(npmRoot.stdout ?? '').trim()
            if (root) {
              const p = join(root, '@earendil-works', 'pi-coding-agent', 'CHANGELOG.md')
              if (existsSync(p)) return p
            }
          } catch {
            // ignore
          }

          return null
        }

        const changelogPath = findChangelog()
        if (!changelogPath) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: "Changelog not found (couldn't locate pi installation)." }
            }
          })
          return { stopReason: 'end_turn' }
        }

        let text = ''
        try {
          text = readFileSync(changelogPath, 'utf-8')
        } catch (e: any) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Failed to read changelog: ${String(e?.message ?? e)}` }
            }
          })
          return { stopReason: 'end_turn' }
        }

        // Keep it reasonably sized in chat.
        const maxChars = 20_000
        if (text.length > maxChars) text = text.slice(0, maxChars) + '\n\n...(truncated)...'

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'export') {
        // For now we always export into the session cwd and do not accept a user-provided path.
        // IMPORTANT: pi's export_html reads the session JSONL file. If it doesn't exist yet
        // (no messages) or is empty, pi throws and RPC mode emits an uncorrelated parse error
        // (no id), which would otherwise hang our request. So we guard here.
        const state = (await runSessionRpc(session, proc => proc.getState())) as any
        const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null
        const messageCount = typeof state?.messageCount === 'number' ? state.messageCount : 0

        if (!sessionFile || messageCount === 0 || !existsSync(sessionFile)) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Nothing to export yet (no session messages). Send a prompt first.'
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        try {
          const raw = readFileSync(sessionFile, 'utf-8')
          if (raw.trim().length === 0) {
            await this.conn.sessionUpdate({
              sessionId: session.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text: 'Nothing to export yet (empty session file). Send a prompt first.'
                }
              }
            })
            return { stopReason: 'end_turn' }
          }
        } catch {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: "Couldn't read session file for export. Try sending a prompt first."
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        const safeSessionId = session.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
        const outputPath = join(session.cwd, `pi-session-${safeSessionId}.html`)

        let resultPath = ''
        try {
          const result = await runSessionMutation(session, 'export_html', () =>
            runSessionRpc(session, proc => proc.exportHtml(outputPath))
          )
          resultPath = result.path
        } catch (e: any) {
          if (e instanceof RequestError) throw e
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: `Export failed: ${String(e?.message ?? e)}`
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        if (!resultPath) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Export failed: no output path returned by pi.'
              }
            }
          })
          return { stopReason: 'end_turn' }
        }

        const uri = `file://${resultPath}`

        // Emit a short prefix + a resource link. Many clients concatenate chunks into a single
        // assistant message, so this avoids the "link + duplicate plain text" look.
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: 'Session exported: '
            }
          }
        })

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'resource_link',
              name: `pi-session-${safeSessionId}.html`,
              uri,
              mimeType: 'text/html',
              title: 'Session exported'
            }
          }
        })

        return { stopReason: 'end_turn' }
      }

      if (cmd === 'autocompact') {
        const mode = (args[0] ?? 'toggle').toLowerCase()
        const enabled = await runSessionMutation(session, 'set_auto_compaction', async () => {
          let next: boolean | null = null
          if (mode === 'on' || mode === 'true' || mode === 'enable' || mode === 'enabled') next = true
          else if (mode === 'off' || mode === 'false' || mode === 'disable' || mode === 'disabled') next = false

          if (next === null) {
            // The read and write form one mutation transaction; another
            // command cannot interleave between the toggle snapshot and set.
            const state = (await runSessionRpc(session, proc => proc.getState())) as any
            const current = Boolean(state?.autoCompactionEnabled)
            next = !current
          }

          await runSessionRpc(session, proc => proc.setAutoCompaction(next))
          return next
        })

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: `Auto-compaction ${enabled ? 'enabled' : 'disabled'}.`
            }
          }
        })

        return { stopReason: 'end_turn' }
      }
    }

    const fixtureStateInvocation = parseFixtureStateInvocation(message)
    if (fixtureStateInvocation) {
      const preview = await this.executeFixtureStatePreview(
        session,
        fixtureStateInvocation,
        promptHasAttachments(params.prompt)
      )
      if (preview) return preview
    }

    const stopReason = await session.prompt(message, images)
    return { stopReason }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.maybeGet(params.sessionId)
    if (!session) return
    await session.cancel()
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    // ACP: filter by cwd if provided.
    // Zed currently sends `{}` (no cwd), so we default to the last session cwd to
    // emulate pi's `/resume` picker (project-scoped).
    const all = listPiSessions()

    const effectiveCwd = (params as any).cwd ?? this.lastSessionCwd
    const filtered = effectiveCwd ? all.filter(s => s.cwd === effectiveCwd) : all

    // Cursor-based pagination (opaque cursor). For MVP, we use a simple numeric offset.
    // If cursor is invalid, treat as 0.
    const offset = params.cursor ? Number.parseInt(params.cursor, 10) : 0
    const start = Number.isFinite(offset) && offset > 0 ? offset : 0

    const PAGE_SIZE = 50
    const page = filtered.slice(start, start + PAGE_SIZE)

    const sessions: SessionInfo[] = page.map(s => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title,
      updatedAt: s.updatedAt
    }))

    const nextCursor = start + PAGE_SIZE < filtered.length ? String(start + PAGE_SIZE) : null

    return { sessions, nextCursor, _meta: {} }
  }

  loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    return this.runExplicitSessionTransaction(() => this.loadSessionOwned(params))
  }

  private async loadSessionOwned(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(`cwd must be an absolute path: ${params.cwd}`)
    }
    if (this.disposed) throw sessionRecoveryUnavailableError()

    // If the client is re-loading a session that is already active, tear down the existing
    // pi subprocess so we can start fresh and re-advertise commands reliably.
    // (Some clients may call session/load when restoring from history.)
    try {
      await this.sessions.close(params.sessionId)
    } catch {
      throw sessionRecoveryUnavailableError()
    }

    this.lastSessionCwd = params.cwd

    const stored = this.findStoredSession(params.sessionId)
    if (!stored) {
      throw RequestError.invalidParams(`Unknown sessionId: ${params.sessionId}`)
    }

    const enableSkillCommands = getEnableSkillCommands(params.cwd)
    const session = await this.restoreSession(params.sessionId, {
      cwd: params.cwd,
      mcpServers: params.mcpServers
    })
    try {
      // Policy: within a single ACP connection (one Zed window), keep only one live pi subprocess.
      // (Tests sometimes stub out `this.sessions`, so guard the call.)
      try {
        await (this.sessions as any).closeAllExcept?.(session.sessionId)
      } catch {
        throw sessionRecoveryUnavailableError()
      }

      // (Optional) ensure mapping stays fresh.
      try {
        this.store.upsert({
          sessionId: params.sessionId,
          cwd: params.cwd,
          sessionFile: stored.sessionFile
        })
      } catch {
        // The exact durable mapping used for this recovery was already
        // validated. A cache refresh failure must not strand the live session.
      }

      // Replay full conversation history.
      const data = (await runSessionRpc(session, proc => proc.getMessages())) as any
      const messages = Array.isArray(data?.messages) ? data.messages : []

      for (const m of messages) {
        const role = String(m?.role ?? '')

        if (role === 'user') {
          const text = normalizePiMessageText(m?.content)
          if (text) {
            await this.conn.sessionUpdate({
              sessionId: session.sessionId,
              update: {
                sessionUpdate: 'user_message_chunk',
                content: { type: 'text', text }
              }
            })
          }
        }

        if (role === 'assistant') {
          const text = normalizePiAssistantText(m?.content)
          if (text) {
            await this.conn.sessionUpdate({
              sessionId: session.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text }
              }
            })
          }
        }

        if (role === 'toolResult') {
          const toolName = String((m as any)?.toolName ?? 'tool')
          const toolCallId = String((m as any)?.toolCallId ?? crypto.randomUUID())
          const isError = Boolean((m as any)?.isError)
          const isBash = isBashTool(toolName)

          if (isBash) {
            const text = bashResultText(m)
            await this.conn.sessionUpdate({
              sessionId: session.sessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId,
                title: bashCommand(m) ?? toolName,
                kind: 'execute',
                status: 'completed',
                content: bashTerminalContent(toolCallId),
                _meta: bashTerminalInfoMeta(toolCallId, params.cwd)
              }
            })

            await this.conn.sessionUpdate({
              sessionId: session.sessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId,
                status: isError ? 'failed' : 'completed',
                _meta: {
                  ...(text ? bashTerminalOutputMeta(toolCallId, text) : {}),
                  ...bashTerminalExitMeta(toolCallId, bashExitCode(m, isError))
                }
              }
            })
            continue
          }

          // Create a synthetic ACP tool call to render historic tool usage.
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId,
              title: toolName,
              kind: toolName === 'read' ? 'read' : toolName === 'write' || toolName === 'edit' ? 'edit' : 'other',
              status: 'completed',
              rawInput: null,
              rawOutput: m
            }
          })

          const text = toolResultToText(m)
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId,
              status: isError ? 'failed' : 'completed',
              content: text ? [{ type: 'content', content: { type: 'text', text } }] : null,
              rawOutput: m
            }
          })
        }
      }

      const { configOptions, models, modes } = await runSessionRpc(session, proc => getSessionConfiguration(proc))

      const preludeText = `${PROJECT_TRUST_WARNING}\n`
      session.setStartupInfo(preludeText)

      const response = {
        configOptions,
        models,
        modes,
        _meta: {
          piAcp: {
            startupInfo: preludeText
          }
        }
      }

      const maybeGet = (this.sessions as SessionManager & { maybeGet?: (id: string) => PiAcpSession | undefined })
        .maybeGet
      const exactSessionStillPublished =
        typeof maybeGet !== 'function' || maybeGet.call(this.sessions, session.sessionId) === session
      if (this.disposed || !this.sessionIsAlive(session) || !exactSessionStillPublished) {
        throw sessionRecoveryUnavailableError()
      }

      // Mirror session/new. Transparent child recovery does not create a new
      // ACP session, so it does not re-arm this pending disclosure.
      setTimeout(() => session.sendStartupInfoIfPending(), 0)

      this.scheduleCommandCatalogPublication(session, enableSkillCommands)

      return response
    } catch (error) {
      await this.cleanupFailedLoadSession(session)
      throw error
    }
  }

  deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse> {
    const existing = this.deleteAttempts.get(params.sessionId)
    if (existing) return existing

    this.deletingSessionIds.add(params.sessionId)
    const attempt = this.deleteSessionOwned(params)
    this.deleteAttempts.set(params.sessionId, attempt)
    void attempt.then(
      () => {
        if (this.deleteAttempts.get(params.sessionId) === attempt) this.deleteAttempts.delete(params.sessionId)
        this.deletingSessionIds.delete(params.sessionId)
      },
      () => {
        if (this.deleteAttempts.get(params.sessionId) === attempt) this.deleteAttempts.delete(params.sessionId)
        // Keep admission closed after unconfirmed cleanup. A later delete call
        // retries the exact retained handles; prompt/recovery cannot race it.
      }
    )
    return attempt
  }

  private async deleteSessionOwned(params: DeleteSessionRequest): Promise<DeleteSessionResponse> {
    const stored = this.store.get(params.sessionId)
    const discovered = listPiSessions().filter(session => session.sessionId === params.sessionId)
    if (discovered.length > 1) throw sessionRecoveryUnavailableError()
    const piSession = discovered.length === 1 ? discovered[0] : null
    const registered = this.sessions.maybeGet(params.sessionId)
    const recovery = this.restoringSessions.get(params.sessionId)

    // Per ACP session/delete semantics, deleting a session that does not
    // exist (or is already gone) should succeed idempotently.
    // https://agentclientprotocol.com/protocol/v2/session-delete#semantics
    if (!stored && !piSession && !registered && !recovery) {
      ;(this.sessions as SessionManager & { forget?: (id: string) => void }).forget?.(params.sessionId)
      this.retireDeletedSessionCleanupState(params.sessionId)
      return {}
    }

    // Unique Pi discovery is exact header evidence and takes precedence over
    // a potentially stale/corrupt cache entry.
    const sessionFile = piSession?.sessionFile ?? stored?.sessionFile

    // Ensure the process has released its session file before unlinking it.
    if (recovery) {
      recovery.cancelled = true
      await Promise.allSettled([recovery.promise])
      try {
        if (recovery.candidateSession) {
          const candidate = recovery.candidate
          await recovery.candidateSession.dispose()
          if (candidate) this.releaseRecoveryCandidate(candidate)
          recovery.candidateSession = null
          recovery.candidate = null
          recovery.blockedCleanup = false
        } else if (recovery.candidate) {
          await recovery.candidate.stop()
          this.releaseRecoveryCandidate(recovery.candidate)
          recovery.candidate = null
          recovery.blockedCleanup = false
        }
      } catch (error) {
        recovery.blockedCleanup = true
        if (recovery.candidate) {
          this.retainRecoveryCandidate(recovery.candidate, recovery.candidateSession ?? undefined)
        }
        throw error
      }
      if (this.restoringSessions.get(params.sessionId) === recovery) {
        this.restoringSessions.delete(params.sessionId)
      }
    }
    await this.sessions.close(params.sessionId)

    if (
      sessionFile &&
      this.validDurableMapping(params.sessionId, {
        cwd: stored?.cwd ?? piSession?.cwd ?? process.cwd(),
        sessionFile
      })
    ) {
      try {
        if (existsSync(sessionFile)) unlinkSync(sessionFile)
      } catch (error) {
        throw RequestError.internalError(
          { code: 'PI_ACP_SESSION_DELETE_FAILED' },
          `Could not delete the Pi session file: ${String((error as Error)?.message ?? error)}`
        )
      }
    }

    this.store.delete(params.sessionId)
    ;(this.sessions as SessionManager & { forget?: (id: string) => void }).forget?.(params.sessionId)
    this.retireDeletedSessionCleanupState(params.sessionId)

    return {}
  }

  async unstable_setSessionModel(params: { sessionId: string; modelId: string }): Promise<void> {
    const session = await this.restoreSession(params.sessionId)
    await runSessionMutation(session, 'set_model', async () => {
      await runSessionRpc(session, proc => setSessionModel(proc, params.modelId))
      await runSessionRpc(session, proc => emitConfigOptionsUpdate(this.conn, session.sessionId, proc))
    })
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = await this.restoreSession(params.sessionId)

    const mode = String(params.modeId)
    if (!isThinkingLevel(mode)) {
      throw RequestError.invalidParams(`Unknown modeId: ${mode}`)
    }

    await runSessionMutation(session, 'set_thinking_level', async () => {
      await runSessionRpc(session, proc => proc.setThinkingLevel(mode))

      // Let the client know the current mode changed (keeps the dropdown in sync).
      void this.conn.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: 'current_mode_update',
          currentModeId: mode
        }
      })

      await runSessionRpc(session, proc => emitConfigOptionsUpdate(this.conn, session.sessionId, proc))
    })

    return {}
  }

  async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    const session = await this.restoreSession(params.sessionId)
    const configId = String(params.configId)

    if (typeof params.value !== 'string') {
      throw RequestError.invalidParams(`Expected string value for config option: ${configId}`)
    }

    let mutationName: 'set_model' | 'set_thinking_level'
    if (configId === MODEL_CONFIG_ID) {
      mutationName = 'set_model'
    } else if (configId === THOUGHT_LEVEL_CONFIG_ID) {
      if (!isThinkingLevel(params.value)) {
        throw RequestError.invalidParams(`Unknown thinking level: ${params.value}`)
      }
      mutationName = 'set_thinking_level'
    } else {
      throw RequestError.invalidParams(`Unknown config option: ${configId}`)
    }

    const configOptions = await runSessionMutation(session, mutationName, async () => {
      if (configId === MODEL_CONFIG_ID) {
        await runSessionRpc(session, proc => setSessionModel(proc, params.value))
      } else {
        const thinkingLevel = params.value as ThinkingLevel
        await runSessionRpc(session, proc => proc.setThinkingLevel(thinkingLevel))

        void this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'current_mode_update',
            currentModeId: params.value
          }
        })
      }

      return await runSessionRpc(session, proc => emitConfigOptionsUpdate(this.conn, session.sessionId, proc))
    })
    return { configOptions }
  }
}

function isThinkingLevel(x: string): x is ThinkingLevel {
  return x === 'off' || x === 'minimal' || x === 'low' || x === 'medium' || x === 'high' || x === 'xhigh'
}

async function getThinkingState(
  proc: PiRpcProcess,
  pre?: { state?: any | null }
): Promise<{
  availableModes: Array<{
    id: string
    name: string
    description?: string | null
  }>
  currentModeId: string
}> {
  // Ask pi for current thinking level.
  let current: ThinkingLevel = 'medium'

  const state =
    pre?.state ??
    (await (async () => {
      try {
        return (await proc.getState()) as any
      } catch (error) {
        if (error instanceof PiRpcProcessTerminatedError) throw error
        return null
      }
    })())

  const tl = typeof state?.thinkingLevel === 'string' ? state.thinkingLevel : null
  if (tl && isThinkingLevel(tl)) current = tl

  const available: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']

  return {
    currentModeId: current,
    availableModes: available.map(id => ({
      id,
      name: `Thinking: ${id}`,
      description: null
    }))
  }
}

async function getSessionConfiguration(
  proc: PiRpcProcess,
  pre?: { state?: any | null; availableModels?: any | null }
): Promise<{
  configOptions: SessionConfigOption[]
  models: {
    availableModels: AdvertisedModel[]
    currentModelId: string
  } | null
  modes: {
    availableModes: Array<{
      id: string
      name: string
      description?: string | null
    }>
    currentModeId: string
  }
}> {
  const [models, modes] = await Promise.all([getModelState(proc, pre), getThinkingState(proc, { state: pre?.state })])

  return {
    configOptions: buildConfigOptions({ models, modes }),
    models,
    modes
  }
}

function buildConfigOptions(state: {
  models: {
    availableModels: AdvertisedModel[]
    currentModelId: string
  } | null
  modes: {
    availableModes: Array<{
      id: string
      name: string
      description?: string | null
    }>
    currentModeId: string
  }
}): SessionConfigOption[] {
  const configOptions: SessionConfigOption[] = [
    {
      type: 'select',
      id: THOUGHT_LEVEL_CONFIG_ID,
      category: 'thought_level',
      name: 'Thinking',
      description: 'Set the reasoning effort for this session',
      currentValue: state.modes.currentModeId,
      options: state.modes.availableModes.map(mode => ({
        value: mode.id,
        name: mode.name,
        description: mode.description ?? null
      }))
    }
  ]

  if (state.models?.availableModels.length) {
    configOptions.unshift({
      type: 'select',
      id: MODEL_CONFIG_ID,
      category: 'model',
      name: 'Model',
      description: 'Select the model for this session',
      currentValue: state.models.currentModelId,
      options: state.models.availableModels.map(model => ({
        value: model.modelId,
        name: model.name,
        description: model.description ?? null
      }))
    })
  }

  return configOptions
}

async function getModelState(
  proc: PiRpcProcess,
  pre?: { state?: any | null; availableModels?: any | null }
): Promise<{
  availableModels: AdvertisedModel[]
  currentModelId: string
} | null> {
  // Ask pi for available models.
  let availableModels: AdvertisedModel[] = []

  const data =
    pre?.availableModels ??
    (await (async () => {
      try {
        return (await proc.getAvailableModels()) as any
      } catch (error) {
        if (error instanceof PiRpcProcessTerminatedError) throw error
        return null
      }
    })())

  const models: any[] = Array.isArray(data?.models) ? data.models : []
  availableModels = models
    .map(m => {
      const provider = String(m?.provider ?? '').trim()
      const id = String(m?.id ?? '').trim()
      if (!provider || !id) return null

      const name = String(m?.name ?? id)
      return {
        modelId: `${provider}/${id}`,
        name: `${provider}/${name}`,
        description: null
      } satisfies AdvertisedModel
    })
    .filter(Boolean) as AdvertisedModel[]

  // Ask pi what model is currently active.
  let currentModelId: string | null = null

  const state =
    pre?.state ??
    (await (async () => {
      try {
        return (await proc.getState()) as any
      } catch (error) {
        if (error instanceof PiRpcProcessTerminatedError) throw error
        return null
      }
    })())

  const model = state?.model
  if (model && typeof model === 'object') {
    const provider = String((model as any).provider ?? '').trim()
    const id = String((model as any).id ?? '').trim()
    if (provider && id) currentModelId = `${provider}/${id}`
  }

  if (!availableModels.length && !currentModelId) return null

  // Fallback if current model is unknown: use first in list.
  if (!currentModelId) currentModelId = availableModels[0]?.modelId ?? 'default'

  return {
    availableModels,
    currentModelId: currentModelId ?? availableModels[0]?.modelId ?? 'default'
  }
}

async function emitConfigOptionsUpdate(
  conn: AgentSideConnection,
  sessionId: string,
  proc: PiRpcProcess
): Promise<SessionConfigOption[]> {
  const { configOptions } = await getSessionConfiguration(proc)

  await conn.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: 'config_option_update',
      configOptions
    }
  })

  return configOptions
}

async function setSessionModel(proc: PiRpcProcess, requestedModelId: string): Promise<void> {
  // Accept either:
  //  - "provider/model" (preferred, matches how we advertise)
  //  - "model" (fallback, resolve via available models)
  let provider: string | null = null
  let modelId: string | null = null

  if (requestedModelId.includes('/')) {
    const [candidateProvider, ...rest] = requestedModelId.split('/')
    provider = candidateProvider
    modelId = rest.join('/')
  } else {
    modelId = requestedModelId
  }

  if (!provider) {
    const data = (await proc.getAvailableModels()) as any
    const models: any[] = Array.isArray(data?.models) ? data.models : []
    const found = models.find(m => String(m?.id) === modelId)
    if (found) {
      provider = String(found.provider)
      modelId = String(found.id)
    }
  }

  if (!provider || !modelId) {
    throw RequestError.invalidParams(`Unknown modelId: ${requestedModelId}`)
  }

  await proc.setModel(provider, modelId)
}

function isSemver(v: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(v)
}

function compareSemver(a: string, b: string): number {
  // Very small comparator for x.y.z (ignores pre-release/build beyond making them "not greater" unless base differs)
  const pa = a
    .split(/[.-]/)
    .slice(0, 3)
    .map(n => Number(n))
  const pb = b
    .split(/[.-]/)
    .slice(0, 3)
    .map(n => Number(n))
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da > db) return 1
    if (da < db) return -1
  }
  return 0
}

function buildUpdateNotice(): string | null {
  // Best-effort update check against npm registry.
  // Important: keep it fast to not slow down session/new.
  try {
    const piVersion = spawnSync('pi', ['--version'], { encoding: 'utf-8' })
    const installed = (String(piVersion.stdout ?? '').trim() || String(piVersion.stderr ?? '').trim()).replace(
      /^v/i,
      ''
    )

    if (!installed || !isSemver(installed)) return null

    const latestRes = spawnSync('npm', ['view', '@earendil-works/pi-coding-agent', 'version'], {
      encoding: 'utf-8',
      timeout: 800
    })
    const latest = String(latestRes.stdout ?? '')
      .trim()
      .replace(/^v/i, '')

    if (!latest || !isSemver(latest)) return null
    if (compareSemver(latest, installed) <= 0) return null

    return `New version available: v${latest} (installed v${installed}). Run: \`npm i -g @earendil-works/pi-coding-agent\``
  } catch {
    return null
  }
}

function buildStartupInfo(opts: { cwd: string; updateNotice: string | null }): string {
  const md: string[] = []

  // pi version header
  try {
    const piVersion = spawnSync('pi', ['--version'], { encoding: 'utf-8' })
    const installed = (String(piVersion.stdout ?? '').trim() || String(piVersion.stderr ?? '').trim()).replace(
      /^v/i,
      ''
    )
    if (installed) {
      md.push(`pi v${installed}`)
      md.push('---')
      md.push('')
    }
  } catch {
    // ignore
  }

  md.push(PROJECT_TRUST_WARNING)
  md.push('')

  const addSection = (title: string, items: string[]) => {
    const cleaned = items.map(s => s.trim()).filter(Boolean)
    if (!cleaned.length) return

    md.push(`## ${title}`)
    for (const item of cleaned) md.push(`- ${item}`)
    md.push('')
  }

  // Context
  const contextItems: string[] = []
  const contextPath = join(opts.cwd, 'AGENTS.md')
  if (existsSync(contextPath)) contextItems.push(contextPath)
  addSection('Context', contextItems)

  // Skills
  const skillsItems: string[] = []

  const pushSkillFromRoot = (root: string) => {
    try {
      // Direct .md files in root
      for (const e of readdirSync(root)) {
        const p = join(root, e)
        try {
          const st = statSync(p)
          if (st.isFile() && e.toLowerCase().endsWith('.md')) {
            skillsItems.push(p)
          }
        } catch {
          // ignore
        }
      }

      // Recursive SKILL.md under subdirectories
      const stack: string[] = [root]
      while (stack.length) {
        const dir = stack.pop()!
        let entries: string[] = []
        try {
          entries = readdirSync(dir)
        } catch {
          continue
        }

        for (const name of entries) {
          // Skip obvious noise
          if (name === 'node_modules' || name === '.git') continue
          const p = join(dir, name)
          let st
          try {
            st = statSync(p)
          } catch {
            continue
          }
          if (st.isDirectory()) {
            stack.push(p)
          } else if (st.isFile() && name === 'SKILL.md') {
            skillsItems.push(p)
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // Global skills
  // Use getAgentDir() so this respects PI_CODING_AGENT_DIR overrides.
  const globalSkillsDir = join(getAgentDir(), 'skills')
  pushSkillFromRoot(globalSkillsDir)

  // Also support ~/.agents/skills (pi skill discovery)
  const legacyAgentsSkillsDir = join(process.env.HOME ?? '', '.agents', 'skills')
  pushSkillFromRoot(legacyAgentsSkillsDir)

  // Project skills (.pi/skills)
  const projectSkillsDir = join(opts.cwd, '.pi', 'skills')
  pushSkillFromRoot(projectSkillsDir)

  addSection('Skills', skillsItems)

  // Extensions
  const extItems: string[] = []
  const extDir = join(process.env.HOME ?? '', '.pi', 'agent', 'extensions')
  try {
    const exts = readdirSync(extDir).filter(f => f.endsWith('.ts') || f.endsWith('.js'))
    for (const f of exts) extItems.push(join(extDir, f))
  } catch {
    // ignore
  }

  // Also show npm packages from pi settings (global + project)
  const settingsPaths = [join(getAgentDir(), 'settings.json'), join(opts.cwd, '.pi', 'settings.json')]
  for (const settingsPath of settingsPaths) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as any
      const pkgs: string[] = Array.isArray(settings?.packages) ? settings.packages : []
      for (const pkg of pkgs) {
        const s = String(pkg)
        if (s.startsWith('npm:')) {
          extItems.push(`${s}\n  - index.ts`)
        } else {
          extItems.push(s)
        }
      }
    } catch {
      // ignore
    }
  }

  addSection('Extensions', extItems)

  if (opts.updateNotice) {
    md.push('---')
    md.push(opts.updateNotice)
    md.push('')
  }

  // Do NOT include themes (per request).
  return md.join('\n').trim() + '\n'
}

function readNearestPackageJson(metaUrl: string): {
  name?: string
  version?: string
} {
  try {
    let dir = dirname(fileURLToPath(metaUrl))

    // Walk upwards a few levels to find the nearest package.json
    for (let i = 0; i < 6; i++) {
      const p = join(dir, 'package.json')
      if (existsSync(p)) {
        const json = JSON.parse(readFileSync(p, 'utf-8')) as any
        return { name: json?.name, version: json?.version }
      }
      dir = dirname(dir)
    }
  } catch {
    // ignore
  }
  return { name: 'pi-acp', version: '0.0.0' }
}
