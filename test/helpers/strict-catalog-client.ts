import type { AvailableCommand, PromptResponse, SessionNotification } from '@agentclientprotocol/sdk'
import { AcpProcessClient, type AcpProcessExit } from './acp-process-client.js'

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
  private readonly unsubscribe: () => void
  private disposed = false

  constructor(
    private readonly raw: AcpProcessClient,
    private readonly catalogTimeoutMs = DEFAULT_CATALOG_TIMEOUT_MS
  ) {
    if (!Number.isInteger(catalogTimeoutMs) || catalogTimeoutMs <= 0) {
      throw new TypeError('catalogTimeoutMs must be a positive integer')
    }

    this.unsubscribe = raw.subscribeSessionUpdates(notification => this.handleSessionUpdate(notification), true)
    void raw.closed.then(
      exit => {
        this.rejectAllWaiters({ exit })
      },
      cause => {
        this.rejectAllWaiters({ cause })
      }
    )
  }

  catalog(sessionId: string): CatalogSnapshot | undefined {
    const catalog = this.catalogs.get(sessionId)
    return catalog ? cloneSnapshot(catalog) : undefined
  }

  async waitForCatalog(sessionId: string, options: WaitForCatalogOptions = {}): Promise<CatalogSnapshot> {
    if (this.disposed) throw new Error('StrictCatalogClient is disposed')

    const afterRevision = options.afterRevision ?? 0
    if (!Number.isInteger(afterRevision) || afterRevision < 0) {
      throw new TypeError('afterRevision must be a non-negative integer')
    }

    const existing = this.catalogs.get(sessionId)
    if (existing && existing.revision > afterRevision) return cloneSnapshot(existing)
    if (!this.raw.isRunning) {
      let exit: AcpProcessExit
      try {
        exit = await this.raw.closed
      } catch (cause) {
        throw new CatalogTransportClosedError(sessionId, this.raw.transcriptNdjson(), undefined, cause)
      }
      throw new CatalogTransportClosedError(sessionId, this.raw.transcriptNdjson(), exit)
    }

    const timeoutMs = options.timeoutMs ?? this.catalogTimeoutMs
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a positive integer')

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
    this.unsubscribe()
    const exit: AcpProcessExit = {
      code: null,
      signal: null,
      stderrTail: '',
      spawnError: 'strict catalog client disposed'
    }
    this.rejectAllWaiters({ exit })
  }

  private handleSessionUpdate(notification: SessionNotification): void {
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

  private removeWaiter(sessionId: string, waiter: CatalogWaiter): void {
    const sessionWaiters = this.waiters.get(sessionId)
    if (!sessionWaiters) return
    sessionWaiters.delete(waiter)
    if (sessionWaiters.size === 0) this.waiters.delete(sessionId)
  }

  private rejectAllWaiters(reason: { exit?: AcpProcessExit; cause?: unknown }): void {
    for (const [sessionId, sessionWaiters] of this.waiters) {
      for (const waiter of sessionWaiters) {
        clearTimeout(waiter.timer)
        waiter.reject(
          new CatalogTransportClosedError(sessionId, this.raw.transcriptNdjson(), reason.exit, reason.cause)
        )
      }
    }
    this.waiters.clear()
  }
}
