import type {
  AgentSideConnection,
  ContentBlock,
  McpServer,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolKind
} from '@agentclientprotocol/sdk'
import { RequestError } from '@agentclientprotocol/sdk'
import { maybeAuthRequiredError } from './auth-required.js'
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { PiRpcProcess, PiRpcSpawnError, type PiRpcEvent, type PiRpcExtensionUiResponse } from '../pi-rpc/process.js'
import { SessionStore } from './session-store.js'
import { toolResultToText } from './translate/pi-tools.js'
import { expandSlashCommand, type FileSlashCommand } from './slash-commands.js'
import {
  extensionCommandNamesFromPiCommands,
  piCommandsRawFromGetCommands,
  type PiRpcCommandInfo
} from './pi-commands.js'

type SessionCreateParams = {
  cwd: string
  mcpServers: McpServer[]
  conn: AgentSideConnection
  fileCommands?: import('./slash-commands.js').FileSlashCommand[]
  supportsAskUserQuestion?: boolean
  piCommand?: string
}

export type StopReason = 'end_turn' | 'cancelled' | 'error'

type PendingTurn = {
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
  knownExtensionCommand: boolean
}

type QueuedTurn = {
  message: string
  images: unknown[]
  knownExtensionCommand: boolean
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

type ExtensionUiDialogMethod = 'select' | 'confirm' | 'input' | 'editor'

const extensionUiDialogMethods = new Set<string>(['select', 'confirm', 'input', 'editor'])

type RequestPermissionOutcome =
  | { outcome: 'cancelled' }
  | { outcome: 'selected'; optionId: string; _meta?: Record<string, unknown> | null }
  | { outcome?: unknown; optionId?: unknown; _meta?: unknown }

type RequestPermissionOptionKind = 'allow_once' | 'reject_once'

type RequestPermissionFn = (params: {
  sessionId: string
  toolCall: {
    toolCallId: string
    title: string
    status: 'pending'
    kind: 'other'
    rawInput?: Record<string, unknown>
  }
  options: Array<{
    optionId: string
    name: string
    kind: RequestPermissionOptionKind
  }>
  _meta?: Record<string, unknown>
}) => Promise<{ outcome?: RequestPermissionOutcome; _meta?: Record<string, unknown> | null }>

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

function toToolCallLocations(args: unknown, cwd: string, line?: number): ToolCallLocation[] | undefined {
  const path =
    typeof (args as { path?: unknown } | null | undefined)?.path === 'string'
      ? (args as { path: string }).path
      : undefined
  if (!path) return undefined

  const resolvedPath = isAbsolute(path) ? path : resolvePath(cwd, path)
  return [{ path: resolvedPath, ...(typeof line === 'number' ? { line } : {}) }]
}

function extractLeadingSlashCommandName(text: string): string | null {
  if (!text.startsWith('/')) return null

  const spaceIndex = text.search(/\s/)
  const name = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex)
  return name.trim() || null
}

function customMessageToDisplayText(message: unknown): string | null {
  const msg = message as {
    role?: unknown
    display?: unknown
    customType?: unknown
    content?: unknown
  }
  if (msg?.role !== 'custom' || msg.display !== true) return null

  const customType = typeof msg.customType === 'string' && msg.customType ? msg.customType : 'custom'
  const content = msg.content

  if (typeof content === 'string') return `[${customType}] ${content}`

  if (Array.isArray(content)) {
    const text = content
      .map(block => {
        const b = block as { type?: unknown; text?: unknown }
        return b.type === 'text' && typeof b.text === 'string' ? b.text : ''
      })
      .filter(Boolean)
      .join('\n')

    if (text) return `[${customType}] ${text}`
  }

  return null
}

function selectedPermissionOptionId(outcome: RequestPermissionOutcome): string | null {
  return outcome.outcome === 'selected' && typeof outcome.optionId === 'string' ? outcome.optionId : null
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function nestedRecord(value: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  return recordFromUnknown(value?.[key])
}

function askUserQuestionMetaFrom(value: unknown): Record<string, unknown> | null {
  return nestedRecord(nestedRecord(recordFromUnknown(value), 'claudeCode'), 'askUserQuestion')
}

function askUserQuestionPayloadFromResponse(response: unknown): Record<string, unknown> | null {
  const responseRecord = recordFromUnknown(response)
  const outcomeRecord = recordFromUnknown(responseRecord?.outcome)

  return askUserQuestionMetaFrom(outcomeRecord?._meta) ?? askUserQuestionMetaFrom(responseRecord?._meta)
}

function normalizeAnswerValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const answer = value.trim()
    return answer ? answer : null
  }

  if (Array.isArray(value) && value.every(entry => typeof entry === 'string')) {
    const answer = value
      .map(entry => entry.trim())
      .filter(Boolean)
      .join(', ')
    return answer ? answer : null
  }

  return null
}

function askUserQuestionAnswer(response: unknown, question: string, header: string): string | null {
  const payload = askUserQuestionPayloadFromResponse(response)
  if (!payload) return null

  const answers = recordFromUnknown(payload.answers)
  if (answers) {
    return (
      normalizeAnswerValue(answers[question]) ??
      normalizeAnswerValue(answers[header]) ??
      normalizeAnswerValue(answers['0'])
    )
  }

  return normalizeAnswerValue(payload.answer)
}

export class SessionManager {
  private sessions = new Map<string, PiAcpSession>()
  private readonly store = new SessionStore()

  /** Dispose all sessions and their underlying pi subprocesses. */
  disposeAll(): void {
    for (const [id] of this.sessions) this.close(id)
  }

  /** Get a registered session if it exists (no throw). */
  maybeGet(sessionId: string): PiAcpSession | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * Dispose a session's underlying pi process and remove it from the manager.
   * Used when clients explicitly reload a session and we want a fresh pi subprocess.
   */
  close(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    try {
      s.proc.dispose?.()
    } catch {
      // ignore
    }
    this.sessions.delete(sessionId)
  }

  /** Close all sessions except the one with `keepSessionId`. */
  closeAllExcept(keepSessionId: string): void {
    for (const [id] of this.sessions) {
      if (id === keepSessionId) continue
      this.close(id)
    }
  }

  async create(params: SessionCreateParams): Promise<PiAcpSession> {
    // Let pi manage session persistence in its default location (~/.pi/agent/sessions/...)
    // so sessions are visible to the regular `pi` CLI.
    let proc: PiRpcProcess
    try {
      proc = await PiRpcProcess.spawn({
        cwd: params.cwd,
        piCommand: params.piCommand
      })
    } catch (e) {
      if (e instanceof PiRpcSpawnError) {
        throw RequestError.internalError({ code: e.code }, e.message)
      }
      throw e
    }

    let state: any = null
    try {
      state = (await proc.getState()) as any
    } catch {
      state = null
    }

    const sessionId = typeof state?.sessionId === 'string' ? state.sessionId : crypto.randomUUID()
    const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null

    if (sessionFile) {
      this.store.upsert({ sessionId, cwd: params.cwd, sessionFile })
    }

    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc,
      conn: params.conn,
      store: this.store,
      fileCommands: params.fileCommands ?? [],
      supportsAskUserQuestion: params.supportsAskUserQuestion === true
    })

    this.sessions.set(sessionId, session)
    return session
  }

  get(sessionId: string): PiAcpSession {
    const s = this.sessions.get(sessionId)
    if (!s) throw RequestError.invalidParams(`Unknown sessionId: ${sessionId}`)
    return s
  }

  /**
   * Used by session/load: create a session object bound to an existing sessionId/proc
   * if it isn't already registered.
   */
  getOrCreate(sessionId: string, params: SessionCreateParams & { proc: PiRpcProcess }): PiAcpSession {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing

    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc: params.proc,
      conn: params.conn,
      store: this.store,
      fileCommands: params.fileCommands ?? [],
      supportsAskUserQuestion: params.supportsAskUserQuestion === true
    })

    this.sessions.set(sessionId, session)
    return session
  }
}

export class PiAcpSession {
  readonly sessionId: string
  readonly cwd: string
  readonly mcpServers: McpServer[]

  private startupInfo: string | null = null
  private startupInfoSentOutOfTurn = false
  private startupInfoSentInPrompt = false

  readonly proc: PiRpcProcess
  private readonly conn: AgentSideConnection
  private readonly store?: SessionStore
  private readonly fileCommands: FileSlashCommand[]
  private readonly supportsAskUserQuestion: boolean
  private extensionCommandNames = new Set<string>()
  private piCommandsLoaded = false
  private readonly extensionStatuses = new Map<string, string>()
  private readonly extensionWidgets = new Map<string, { lines: string[]; placement?: string }>()
  private readonly pendingExtensionUiRequests = new Set<string>()

  // Used to map abort semantics to ACP stopReason.
  // Applies to the currently running turn.
  private cancelRequested = false

  // Current in-flight turn (if any). Additional prompts are queued.
  private pendingTurn: PendingTurn | null = null
  private readonly turnQueue: QueuedTurn[] = []
  // Track tool call statuses and ensure they are monotonic (pending -> in_progress -> completed).
  // Some pi events can arrive out of order (e.g. late toolcall_* deltas after execution starts),
  // and clients may hide progress if we ever downgrade back to `pending`.
  private currentToolCalls = new Map<string, 'pending' | 'in_progress'>()

  // pi can emit multiple `turn_end` events for a single user prompt (e.g. after tool_use).
  // The overall agent loop completes when `agent_end` is emitted.
  private inAgentLoop = false

  // For ACP diff support: capture file contents before edits, then emit ToolCallContent {type:"diff"}.
  // This is due to pi sending diff as a string as opposed to ACP expected diff format.
  // Compatible format may need to be implemented in pi in the future.
  private editSnapshots = new Map<string, { path: string; oldText: string }>()

  // Ensure `session/update` notifications are sent in order and can be awaited
  // before completing a `session/prompt` request.
  private lastEmit: Promise<void> = Promise.resolve()

  constructor(opts: {
    sessionId: string
    cwd: string
    mcpServers: McpServer[]
    proc: PiRpcProcess
    conn: AgentSideConnection
    store?: SessionStore
    fileCommands?: FileSlashCommand[]
    supportsAskUserQuestion?: boolean
  }) {
    this.sessionId = opts.sessionId
    this.cwd = opts.cwd
    this.mcpServers = opts.mcpServers
    this.proc = opts.proc
    this.conn = opts.conn
    this.store = opts.store
    this.fileCommands = opts.fileCommands ?? []
    this.supportsAskUserQuestion = opts.supportsAskUserQuestion === true

    this.proc.onEvent(ev => this.handlePiEvent(ev))
  }

  setStartupInfo(text: string) {
    this.startupInfo = text
    this.startupInfoSentOutOfTurn = false
    this.startupInfoSentInPrompt = false
  }

  /**
   * Best-effort attempt to send startup info outside of a prompt turn.
   * Some clients (e.g. Zed) may only render agent messages once the UI is ready;
   * callers can invoke this shortly after session/new returns.
   */
  sendStartupInfoIfPending(): void {
    if (this.startupInfoSentOutOfTurn || !this.startupInfo) return
    this.startupInfoSentOutOfTurn = true

    this.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: this.startupInfo }
    })
  }

  private sendStartupInfoOnFirstPromptIfPending(): void {
    if (this.startupInfoSentInPrompt || !this.startupInfo) return
    this.startupInfoSentInPrompt = true

    this.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: this.startupInfo }
    })
  }

  setPiCommands(commands: PiRpcCommandInfo[]): void {
    this.piCommandsLoaded = true
    this.extensionCommandNames = extensionCommandNamesFromPiCommands(commands)
  }

  async prompt(message: string, images: unknown[] = []): Promise<StopReason> {
    // Keep a prompt-path fallback because some clients may ignore the best-effort
    // pre-prompt notification sent right after session/new.
    this.sendStartupInfoOnFirstPromptIfPending()

    const commandName = extractLeadingSlashCommandName(message)
    if (commandName && !this.piCommandsLoaded) await this.refreshPiCommands()

    const knownExtensionCommand = commandName ? this.extensionCommandNames.has(commandName) : false

    // pi RPC mode disables file prompt-template expansion, so we do it here.
    // Extension commands must stay intact so pi's extension runner can execute them.
    const expandedMessage = knownExtensionCommand ? message : expandSlashCommand(message, this.fileCommands)

    const turnPromise = new Promise<StopReason>((resolve, reject) => {
      const queued: QueuedTurn = { message: expandedMessage, images, knownExtensionCommand, resolve, reject }

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

  private async refreshPiCommands(): Promise<void> {
    try {
      const commands = await this.proc.getCommands()
      this.setPiCommands(piCommandsRawFromGetCommands(commands))
    } catch {
      this.piCommandsLoaded = true
    }
  }

  private async refreshAfterExtensionCommand(): Promise<void> {
    await Promise.allSettled([this.refreshPiCommands(), this.refreshPiSessionState()])
  }

  private async refreshPiSessionState(): Promise<void> {
    try {
      const state = (await this.proc.getState()) as { sessionId?: unknown; sessionFile?: unknown }
      const piSessionId = typeof state?.sessionId === 'string' ? state.sessionId : null
      const piSessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null

      if (piSessionId && piSessionFile) {
        this.store?.upsert({ sessionId: piSessionId, cwd: this.cwd, sessionFile: piSessionFile })
      }

      if (piSessionId || piSessionFile) {
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { piAcp: { piSessionId, piSessionFile } }
        })
      }
    } catch {
      // Session refresh is best-effort after extension-side session changes.
    }
  }

  private cancelPendingExtensionUiRequests(): void {
    const ids = [...this.pendingExtensionUiRequests]
    this.pendingExtensionUiRequests.clear()

    for (const id of ids) {
      this.sendExtensionUiResponse({ type: 'extension_ui_response', id, cancelled: true })
    }
  }

  private sendExtensionUiResponse(response: PiRpcExtensionUiResponse): void {
    try {
      this.proc.sendExtensionUiResponse(response)
    } catch {
      // If the subprocess is already gone, the prompt/cancel path will surface that separately.
    }
  }

  private handleExtensionUiRequest(ev: PiRpcEvent): void {
    const id = typeof (ev as { id?: unknown }).id === 'string' ? (ev as { id: string }).id : ''
    const method = typeof (ev as { method?: unknown }).method === 'string' ? (ev as { method: string }).method : ''
    if (!id || !method) return

    if (extensionUiDialogMethods.has(method)) {
      void this.handleExtensionUiDialog(ev, id, method as ExtensionUiDialogMethod)
      return
    }

    this.forwardExtensionUiNotification(ev)
    this.handleExtensionUiFireAndForget(ev, method)
  }

  private async handleExtensionUiDialog(ev: PiRpcEvent, id: string, method: ExtensionUiDialogMethod): Promise<void> {
    this.pendingExtensionUiRequests.add(id)

    try {
      const response = await this.requestExtensionUiFromAcpClient(ev, id, method)
      if (!this.pendingExtensionUiRequests.delete(id)) return
      this.sendExtensionUiResponse(response)
    } catch {
      if (!this.pendingExtensionUiRequests.delete(id)) return
      this.sendExtensionUiResponse(this.fallbackExtensionUiResponse(id, method))
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: this.extensionUiFallbackNotice(method)
        } satisfies ContentBlock
      })
    }
  }

  private extensionUiFallbackNotice(method: ExtensionUiDialogMethod): string {
    if (method === 'editor' || method === 'input') {
      return `Extension requested ${method} text input, but ACP has no standard free-form text input request; the request was cancelled. Send the text as a follow-up message instead.`
    }

    return `Extension requested ${method} input, but the ACP client did not handle it; the request was cancelled.`
  }

  private async requestExtensionUiFromAcpClient(
    ev: PiRpcEvent,
    id: string,
    method: ExtensionUiDialogMethod
  ): Promise<PiRpcExtensionUiResponse> {
    if (method === 'select') {
      const response = this.supportsAskUserQuestion
        ? await this.requestExtensionSelectViaAskUserQuestion(ev, id)
        : await this.requestExtensionSelectViaStandardAcp(ev, id)
      if (response) return response
      throw new Error('ACP client select UI is unavailable')
    }

    const standardResponse = await this.requestExtensionConfirmViaStandardAcp(ev, id, method)
    if (standardResponse) return standardResponse

    const extMethod = (
      this.conn as unknown as {
        extMethod?: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>
      }
    ).extMethod

    if (typeof extMethod !== 'function') throw new Error('ACP client extension UI is unavailable')

    const response = await extMethod.call(this.conn, 'pi/extension_ui', {
      sessionId: this.sessionId,
      request: ev
    })

    const cancelled = response.cancelled === true
    if (cancelled) return { type: 'extension_ui_response', id, cancelled: true }

    if (method === 'confirm') {
      return { type: 'extension_ui_response', id, confirmed: response.confirmed === true }
    }

    if (typeof response.value === 'string') {
      return { type: 'extension_ui_response', id, value: response.value }
    }

    return this.fallbackExtensionUiResponse(id, method)
  }

  private async requestExtensionSelectViaAskUserQuestion(
    ev: PiRpcEvent,
    id: string
  ): Promise<PiRpcExtensionUiResponse> {
    const requestPermission = (this.conn as unknown as { requestPermission?: RequestPermissionFn }).requestPermission
    if (typeof requestPermission !== 'function') throw new Error('ACP client question UI is unavailable')

    const title = typeof (ev as { title?: unknown }).title === 'string' ? (ev as { title: string }).title : 'Select'
    const optionsRaw = (ev as { options?: unknown }).options
    const options = Array.isArray(optionsRaw)
      ? optionsRaw.filter((option): option is string => typeof option === 'string')
      : []
    if (options.length === 0) return { type: 'extension_ui_response', id, cancelled: true }

    const questions = [
      {
        question: title,
        header: title,
        options: options.map(option => ({ label: option, description: option })),
        multiSelect: false
      }
    ]

    const response = await requestPermission.call(this.conn, {
      sessionId: this.sessionId,
      toolCall: {
        toolCallId: `extension-ui:${id}`,
        title,
        status: 'pending',
        kind: 'other',
        rawInput: { method: 'select', title, options }
      },
      options: [
        { optionId: 'answer', name: 'Submit answer', kind: 'allow_once' },
        { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' }
      ],
      _meta: {
        claudeCode: {
          requestType: 'askUserQuestion',
          askUserQuestion: {
            version: 1,
            allowCustomAnswer: true,
            questions
          }
        },
        piAcp: { extensionUiRequest: ev }
      }
    })

    const outcome = response.outcome
    if (outcome?.outcome === 'cancelled') return { type: 'extension_ui_response', id, cancelled: true }
    if (outcome?.outcome !== 'selected' || outcome.optionId !== 'answer') {
      return { type: 'extension_ui_response', id, cancelled: true }
    }

    const value = askUserQuestionAnswer(response, title, title)
    return value ? { type: 'extension_ui_response', id, value } : { type: 'extension_ui_response', id, cancelled: true }
  }

  private async requestExtensionSelectViaStandardAcp(
    ev: PiRpcEvent,
    id: string
  ): Promise<PiRpcExtensionUiResponse | null> {
    const requestPermission = (this.conn as unknown as { requestPermission?: RequestPermissionFn }).requestPermission
    if (typeof requestPermission !== 'function') return null

    try {
      const title = typeof (ev as { title?: unknown }).title === 'string' ? (ev as { title: string }).title : 'Select'
      const optionsRaw = (ev as { options?: unknown }).options
      const options = Array.isArray(optionsRaw)
        ? optionsRaw.filter((option): option is string => typeof option === 'string')
        : []
      if (options.length === 0) return { type: 'extension_ui_response', id, cancelled: true }

      const response = await requestPermission.call(this.conn, {
        sessionId: this.sessionId,
        toolCall: {
          toolCallId: `extension-ui:${id}`,
          title,
          status: 'pending',
          kind: 'other',
          rawInput: { method: 'select', title, options }
        },
        options: options.map((name, index): { optionId: string; name: string; kind: RequestPermissionOptionKind } => ({
          optionId: String(index),
          name,
          kind: index === 0 ? 'allow_once' : 'reject_once'
        })),
        _meta: { piAcp: { extensionUiRequest: ev } }
      })

      const outcome = response.outcome
      if (outcome?.outcome === 'cancelled') return { type: 'extension_ui_response', id, cancelled: true }

      const selectedOptionId = outcome ? selectedPermissionOptionId(outcome) : null
      const selectedIndex = selectedOptionId ? Number.parseInt(selectedOptionId, 10) : Number.NaN
      const value = Number.isInteger(selectedIndex) ? options[selectedIndex] : undefined
      return value
        ? { type: 'extension_ui_response', id, value }
        : { type: 'extension_ui_response', id, cancelled: true }
    } catch {
      return null
    }
  }

  private async requestExtensionConfirmViaStandardAcp(
    ev: PiRpcEvent,
    id: string,
    method: ExtensionUiDialogMethod
  ): Promise<PiRpcExtensionUiResponse | null> {
    if (method !== 'confirm') return null

    const requestPermission = (this.conn as unknown as { requestPermission?: RequestPermissionFn }).requestPermission
    if (typeof requestPermission !== 'function') return null

    try {
      const title = typeof (ev as { title?: unknown }).title === 'string' ? (ev as { title: string }).title : 'Confirm'
      const message =
        typeof (ev as { message?: unknown }).message === 'string' ? (ev as { message: string }).message : ''
      const response = await requestPermission.call(this.conn, {
        sessionId: this.sessionId,
        toolCall: {
          toolCallId: `extension-ui:${id}`,
          title,
          status: 'pending',
          kind: 'other',
          rawInput: { method, title, message }
        },
        options: [
          { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
          { optionId: 'no', name: 'No', kind: 'reject_once' }
        ],
        _meta: { piAcp: { extensionUiRequest: ev } }
      })

      const outcome = response.outcome
      if (outcome?.outcome === 'cancelled') return { type: 'extension_ui_response', id, cancelled: true }
      return { type: 'extension_ui_response', id, confirmed: outcome ? selectedPermissionOptionId(outcome) === 'yes' : false }
    } catch {
      return null
    }
  }

  private fallbackExtensionUiResponse(id: string, method: ExtensionUiDialogMethod): PiRpcExtensionUiResponse {
    if (method === 'confirm') return { type: 'extension_ui_response', id, confirmed: false }
    return { type: 'extension_ui_response', id, cancelled: true }
  }

  private forwardExtensionUiNotification(ev: PiRpcEvent): void {
    const extNotification = (
      this.conn as unknown as {
        extNotification?: (method: string, params: Record<string, unknown>) => Promise<void>
      }
    ).extNotification

    if (typeof extNotification !== 'function') return

    void extNotification
      .call(this.conn, 'pi/extension_ui', {
        sessionId: this.sessionId,
        request: ev
      })
      .catch(() => {
        // Custom ACP notifications are best-effort.
      })
  }

  private handleExtensionUiFireAndForget(ev: PiRpcEvent, method: string): void {
    switch (method) {
      case 'notify': {
        const message =
          typeof (ev as { message?: unknown }).message === 'string' ? (ev as { message: string }).message : ''
        if (!message) break

        const notifyType =
          typeof (ev as { notifyType?: unknown }).notifyType === 'string'
            ? (ev as { notifyType: string }).notifyType
            : 'info'
        const label =
          notifyType === 'error' ? 'Extension error' : notifyType === 'warning' ? 'Extension warning' : 'Extension'

        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `${label}: ${message}` } satisfies ContentBlock
        })
        break
      }

      case 'setStatus': {
        const key =
          typeof (ev as { statusKey?: unknown }).statusKey === 'string' ? (ev as { statusKey: string }).statusKey : ''
        const text =
          typeof (ev as { statusText?: unknown }).statusText === 'string'
            ? (ev as { statusText: string }).statusText
            : undefined
        if (!key) break

        if (text === undefined) this.extensionStatuses.delete(key)
        else this.extensionStatuses.set(key, text)

        this.emitExtensionUiState()
        break
      }

      case 'setWidget': {
        const key =
          typeof (ev as { widgetKey?: unknown }).widgetKey === 'string' ? (ev as { widgetKey: string }).widgetKey : ''
        const linesRaw = (ev as { widgetLines?: unknown }).widgetLines
        const lines = Array.isArray(linesRaw)
          ? linesRaw.filter((line): line is string => typeof line === 'string')
          : undefined
        const placement =
          typeof (ev as { widgetPlacement?: unknown }).widgetPlacement === 'string'
            ? (ev as { widgetPlacement: string }).widgetPlacement
            : undefined
        if (!key) break

        if (!lines) this.extensionWidgets.delete(key)
        else this.extensionWidgets.set(key, { lines, placement })

        this.emitExtensionUiState()
        break
      }

      case 'setTitle': {
        const title = typeof (ev as { title?: unknown }).title === 'string' ? (ev as { title: string }).title : ''
        if (!title) break
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { piAcp: { extensionTitle: title } }
        })
        break
      }

      case 'set_editor_text': {
        const text = typeof (ev as { text?: unknown }).text === 'string' ? (ev as { text: string }).text : ''
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { piAcp: { requestedEditorText: text } }
        })
        if (text) {
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `Extension requested editor text:\n${text}` } satisfies ContentBlock
          })
        }
        break
      }

      default:
        break
    }
  }

  private emitExtensionUiState(): void {
    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: {
        piAcp: {
          extensionStatuses: Object.fromEntries(this.extensionStatuses),
          extensionWidgets: Object.fromEntries(this.extensionWidgets)
        }
      }
    })
  }

  async cancel(): Promise<void> {
    // Cancel current and clear any queued prompts.
    this.cancelRequested = true
    this.cancelPendingExtensionUiRequests()

    if (this.turnQueue.length) {
      const queued = this.turnQueue.splice(0, this.turnQueue.length)
      for (const t of queued) t.resolve('cancelled')

      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Cleared queued prompts.' }
      })
      this.emit({
        sessionUpdate: 'session_info_update',
        _meta: { piAcp: { queueDepth: 0, running: Boolean(this.pendingTurn) } }
      })
    }

    // Abort the currently running turn (if any). If nothing is running, this is a no-op.
    await this.proc.abort()
  }

  wasCancelRequested(): boolean {
    return this.cancelRequested
  }

  private emit(update: SessionUpdate): void {
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

  private async flushEmits(): Promise<void> {
    await this.lastEmit
  }

  private startTurn(t: QueuedTurn): void {
    this.cancelRequested = false
    this.inAgentLoop = false

    this.pendingTurn = { resolve: t.resolve, reject: t.reject, knownExtensionCommand: t.knownExtensionCommand }

    // Publish queue depth (0 because we're starting the turn now).
    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
    })

    // Kick off pi. Normal prompts complete on `agent_end`; extension commands that do
    // not trigger an agent loop complete when the RPC prompt command returns.
    // Important: pi may emit multiple `turn_end` events (e.g. when the model requests tools).
    this.proc
      .prompt(t.message, t.images)
      .then(() => {
        if (!t.knownExtensionCommand || this.inAgentLoop || !this.pendingTurn) return

        const reason: StopReason = this.cancelRequested ? 'cancelled' : 'end_turn'
        this.completeTurnAndMaybeStartNext(reason)
      })
      .catch(err => {
        // If the subprocess errors before we get an `agent_end`, treat as error unless cancelled.
        // Also ensure we flush any already-enqueued updates first.
        void this.flushEmits().finally(() => {
          // If this looks like an auth/config issue, surface AUTH_REQUIRED so clients can offer terminal login.
          const authErr = maybeAuthRequiredError(err)
          if (authErr) {
            this.pendingTurn?.reject(authErr)
          } else {
            const reason: StopReason = this.cancelRequested ? 'cancelled' : 'error'
            this.pendingTurn?.resolve(reason)
          }

          this.pendingTurn = null
          this.inAgentLoop = false

          // If the prompt failed, do not automatically proceed—pi may be unhealthy.
          // But we still clear the queueDepth metadata.
          this.emit({
            sessionUpdate: 'session_info_update',
            _meta: { piAcp: { queueDepth: this.turnQueue.length, running: false } }
          })
        })
        void err
      })
  }

  private completeTurnAndMaybeStartNext(reason: StopReason): void {
    void (async () => {
      await this.flushEmits()

      const pending = this.pendingTurn
      if (!pending) return

      if (pending.knownExtensionCommand) {
        await this.refreshAfterExtensionCommand()
        await this.flushEmits()
      }

      pending.resolve(reason)
      this.pendingTurn = null
      this.inAgentLoop = false

      const next = this.turnQueue.shift()
      if (next) {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `Starting queued message. (${this.turnQueue.length} remaining)` }
        })
        this.startTurn(next)
      } else {
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { piAcp: { queueDepth: 0, running: false } }
        })
      }
    })()
  }

  private handlePiEvent(ev: PiRpcEvent) {
    const type = String((ev as any).type ?? '')

    switch (type) {
      case 'extension_ui_request': {
        this.handleExtensionUiRequest(ev)
        break
      }

      case 'extension_error': {
        const extensionPath =
          typeof (ev as { extensionPath?: unknown }).extensionPath === 'string'
            ? (ev as { extensionPath: string }).extensionPath
            : 'extension'
        const event = typeof (ev as { event?: unknown }).event === 'string' ? (ev as { event: string }).event : 'event'
        const error =
          typeof (ev as { error?: unknown }).error === 'string' ? (ev as { error: string }).error : 'unknown error'

        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `Extension error in ${extensionPath} (${event}): ${error}`
          } satisfies ContentBlock
        })
        break
      }

      case 'message_end': {
        const text = customMessageToDisplayText((ev as { message?: unknown }).message)
        if (text) {
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text } satisfies ContentBlock
          })
        }
        break
      }

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

            if (!existingStatus) {
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

        // Capture pre-edit file contents so we can emit a structured ACP diff on completion.
        if (toolName === 'edit') {
          const p = typeof args?.path === 'string' ? args.path : undefined
          if (p) {
            try {
              const abs = isAbsolute(p) ? p : resolvePath(this.cwd, p)
              const oldText = readFileSync(abs, 'utf8')
              this.editSnapshots.set(toolCallId, { path: p, oldText })

              const needle = typeof args?.oldText === 'string' ? args.oldText : ''
              line = findUniqueLineNumber(oldText, needle)
            } catch {
              // Ignore snapshot failures; we'll fall back to plain text output.
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
        const text = toolResultToText(partial)

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'in_progress',
          content: text
            ? ([{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[])
            : undefined,
          rawOutput: partial
        })
        break
      }

      case 'tool_execution_end': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const result = (ev as any).result
        const isError = Boolean((ev as any).isError)
        const text = toolResultToText(result)

        // If this was an edit and we captured a snapshot, emit a structured ACP diff.
        // This enables clients like Zed to render an actual diff UI.
        const snapshot = this.editSnapshots.get(toolCallId)
        let content: ToolCallContent[] | undefined

        if (!isError && snapshot) {
          try {
            const abs = isAbsolute(snapshot.path) ? snapshot.path : resolvePath(this.cwd, snapshot.path)
            const newText = readFileSync(abs, 'utf8')
            if (newText !== snapshot.oldText) {
              content = [
                {
                  type: 'diff',
                  path: snapshot.path,
                  oldText: snapshot.oldText,
                  newText
                },
                ...(text ? ([{ type: 'content', content: { type: 'text', text } }] as ToolCallContent[]) : [])
              ]
            }
          } catch {
            // ignore; fall back to text only
          }
        }

        // Fallback: just text content.
        if (!content && text) {
          content = [{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[]
        }

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: isError ? 'failed' : 'completed',
          content,
          rawOutput: result
        })

        this.currentToolCalls.delete(toolCallId)
        this.editSnapshots.delete(toolCallId)
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
        break
      }

      case 'turn_end': {
        // pi uses `turn_end` for sub-steps (e.g. tool_use) and will often start another turn.
        // Do NOT resolve the ACP `session/prompt` here; wait for `agent_end`.
        break
      }

      case 'agent_end': {
        // Ensure all updates derived from pi events are delivered before we resolve
        // the ACP `session/prompt` request.
        this.completeTurnAndMaybeStartNext(this.cancelRequested ? 'cancelled' : 'end_turn')
        break
      }

      default:
        break
    }
  }
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
      // Many ACP clients render `execute` tool calls only via the terminal APIs.
      // Since this adapter lets pi execute locally (no client terminal delegation),
      // we report bash as `other` so clients show inline text output blocks.
      return 'other'
    default:
      return 'other'
  }
}
