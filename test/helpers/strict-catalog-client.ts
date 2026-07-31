import type { AvailableCommand, PromptResponse, SessionNotification } from '@agentclientprotocol/sdk'
import { AcpProcessClient, type AcpProcessExit, type AcpTerminalLifecycle } from './acp-process-client.js'

const DEFAULT_CATALOG_TIMEOUT_MS = 1_000

export type CatalogSnapshot = {
  sessionId: string
  revision: number
  commands: AvailableCommand[]
}

export type WaitForCatalogOptions = {
  afterRevision?: number
  timeoutMs?: number
}

export type PromptCommandRequest = {
  sessionId: string
  name: string
  input?: string
  catalogTimeoutMs?: number
}

type CatalogWaiter = {
  afterRevision: number
  resolve: (snapshot: CatalogSnapshot) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

type InternalCatalog = CatalogSnapshot & {
  byName: Map<string, AvailableCommand>
}

export class CommandNotAdvertisedError extends Error {
  constructor(
    readonly sessionId: string,
    readonly commandName: string,
    readonly advertisedNames: string[]
  ) {
    super(
      `Command /${commandName} is not advertised for session ${sessionId}; advertised commands: ${
        advertisedNames.length === 0 ? '(none)' : advertisedNames.map(name => `/${name}`).join(', ')
      }`
    )
    this.name = 'CommandNotAdvertisedError'
  }
}

export class CatalogWaitTimeoutError extends Error {
  constructor(
    readonly sessionId: string,
    readonly afterRevision: number,
    readonly timeoutMs: number,
    readonly transcript: string
  ) {
    super(
      `Command catalog for session ${sessionId} did not advance past revision ${afterRevision} within ${timeoutMs}ms`
    )
    this.name = 'CatalogWaitTimeoutError'
  }
}

export class CatalogTransportClosedError extends Error {
  constructor(
    readonly sessionId: string,
    readonly transcript: string,
    readonly exit?: AcpProcessExit,
    cause?: unknown
  ) {
    super(`ACP transport closed before a command catalog arrived for session ${sessionId}`, { cause })
    this.name = 'CatalogTransportClosedError'
  }
}

export class StrictCatalogClientDisposedError extends Error {
  constructor() {
    super('StrictCatalogClient is disposed')
    this.name = 'StrictCatalogClientDisposedError'
  }
}

function cloneSnapshot(catalog: InternalCatalog): CatalogSnapshot {
  return {
    sessionId: catalog.sessionId,
    revision: catalog.revision,
    commands: structuredClone(catalog.commands)
  }
}

function normalizeCommandName(name: string): string {
  const normalized = name.startsWith('/') ? name.slice(1) : name
  if (normalized.length === 0 || normalized.includes('/') || /\s/u.test(normalized)) {
    throw new TypeError('command name must be a bare ACP command name with at most one leading slash')
  }
  return normalized
}

export class StrictCatalogClient {
  private readonly catalogs = new Map<string, InternalCatalog>()
  private readonly waiters = new Map<string, Set<CatalogWaiter>>()
  private readonly unsubscribeUpdates: () => void
  private readonly unsubscribeTerminal: () => void
  private terminal: AcpTerminalLifecycle | undefined
  private disposed = false

  constructor(
    private readonly raw: AcpProcessClient,
    private readonly catalogTimeoutMs = DEFAULT_CATALOG_TIMEOUT_MS
  ) {
    if (!Number.isInteger(catalogTimeoutMs) || catalogTimeoutMs <= 0) {
      throw new TypeError('catalogTimeoutMs must be a positive integer')
    }

    this.unsubscribeUpdates = raw.subscribeSessionUpdates(notification => this.handleSessionUpdate(notification), true)
    this.unsubscribeTerminal = raw.subscribeTerminalLifecycle(terminal => {
      this.handleTerminalLifecycle(terminal)
    })
  }

  catalog(sessionId: string): CatalogSnapshot | undefined {
    const catalog = this.catalogs.get(sessionId)
    return catalog ? cloneSnapshot(catalog) : undefined
  }

  async waitForCatalog(sessionId: string, options: WaitForCatalogOptions = {}): Promise<CatalogSnapshot> {
    if (this.disposed) throw new StrictCatalogClientDisposedError()

    const afterRevision = options.afterRevision ?? 0
    if (!Number.isInteger(afterRevision) || afterRevision < 0) {
      throw new TypeError('afterRevision must be a non-negative integer')
    }
    const timeoutMs = options.timeoutMs ?? this.catalogTimeoutMs
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a positive integer')

    const existing = this.catalogs.get(sessionId)
    if (existing && existing.revision > afterRevision) return cloneSnapshot(existing)
    if (this.terminal) throw this.transportClosedError(sessionId)
    if (!this.raw.isRunning) {
      throw new CatalogTransportClosedError(
        sessionId,
        this.raw.transcriptNdjson(),
        undefined,
        this.raw.terminalLifecycleSignal.reason
      )
    }

    return await new Promise<CatalogSnapshot>((resolve, reject) => {
      const waiter: CatalogWaiter = {
        afterRevision,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removeWaiter(sessionId, waiter)
          reject(new CatalogWaitTimeoutError(sessionId, afterRevision, timeoutMs, this.raw.transcriptNdjson()))
        }, timeoutMs)
      }
      const sessionWaiters = this.waiters.get(sessionId) ?? new Set<CatalogWaiter>()
      sessionWaiters.add(waiter)
      this.waiters.set(sessionId, sessionWaiters)
    })
  }

  async promptCommand(request: PromptCommandRequest): Promise<PromptResponse> {
    const name = normalizeCommandName(request.name)
    await this.waitForCatalog(request.sessionId, { timeoutMs: request.catalogTimeoutMs })
    if (this.disposed) throw new StrictCatalogClientDisposedError()
    if (this.terminal) throw this.transportClosedError(request.sessionId)
    const catalog = this.catalogs.get(request.sessionId)
    if (!catalog?.byName.has(name)) {
      throw new CommandNotAdvertisedError(request.sessionId, name, catalog?.commands.map(command => command.name) ?? [])
    }

    const text = request.input === undefined || request.input.length === 0 ? `/${name}` : `/${name} ${request.input}`
    return await this.raw.prompt({
      sessionId: request.sessionId,
      prompt: [{ type: 'text', text }]
    })
  }

  async close(): Promise<AcpProcessExit> {
    this.dispose()
    return await this.raw.close()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeUpdates()
    this.unsubscribeTerminal()
    this.rejectAllWaiters(() => new StrictCatalogClientDisposedError())
  }

  private handleSessionUpdate(notification: SessionNotification): void {
    if (this.disposed || this.terminal) return
    if (notification.update.sessionUpdate !== 'available_commands_update') return

    const previous = this.catalogs.get(notification.sessionId)
    const commands = structuredClone(notification.update.availableCommands)
    const catalog: InternalCatalog = {
      sessionId: notification.sessionId,
      revision: (previous?.revision ?? 0) + 1,
      commands,
      byName: new Map(commands.map(command => [command.name, command]))
    }
    this.catalogs.set(notification.sessionId, catalog)

    const sessionWaiters = this.waiters.get(notification.sessionId)
    if (!sessionWaiters) return
    for (const waiter of [...sessionWaiters]) {
      if (catalog.revision <= waiter.afterRevision) continue
      clearTimeout(waiter.timer)
      this.removeWaiter(notification.sessionId, waiter)
      waiter.resolve(cloneSnapshot(catalog))
    }
  }

  private handleTerminalLifecycle(terminal: AcpTerminalLifecycle): void {
    if (this.terminal) return
    this.terminal = terminal
    this.unsubscribeUpdates()
    const transcript = this.raw.transcriptNdjson()
    this.rejectAllWaiters(
      sessionId => new CatalogTransportClosedError(sessionId, transcript, terminal.exit, terminal.cause)
    )
  }

  private removeWaiter(sessionId: string, waiter: CatalogWaiter): void {
    const sessionWaiters = this.waiters.get(sessionId)
    if (!sessionWaiters) return
    sessionWaiters.delete(waiter)
    if (sessionWaiters.size === 0) this.waiters.delete(sessionId)
  }

  private transportClosedError(sessionId: string): CatalogTransportClosedError {
    return new CatalogTransportClosedError(
      sessionId,
      this.raw.transcriptNdjson(),
      this.terminal?.exit,
      this.terminal?.cause
    )
  }

  private rejectAllWaiters(createError: (sessionId: string) => Error): void {
    for (const [sessionId, sessionWaiters] of this.waiters) {
      const error = createError(sessionId)
      for (const waiter of sessionWaiters) {
        clearTimeout(waiter.timer)
        waiter.reject(error)
      }
    }
    this.waiters.clear()
  }
}
