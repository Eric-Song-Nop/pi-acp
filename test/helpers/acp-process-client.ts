import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type AnyMessage,
  type CancelNotification,
  type Client,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SessionNotification,
  type Stream
} from '@agentclientprotocol/sdk'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { Readable as NodeReadable, Writable as NodeWritable } from 'node:stream'

const DEFAULT_REQUEST_TIMEOUT_MS = 2_000
const DEFAULT_UPDATE_TIMEOUT_MS = 1_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 250
const DEFAULT_STDERR_LIMIT_BYTES = 16 * 1024
const ACP_SDK_VERSION = '0.26.0'

export type AcpTranscriptDirection = 'client_to_agent' | 'agent_to_client'
export type AcpTranscriptJsonValue =
  | null
  | boolean
  | number
  | string
  | AcpTranscriptJsonValue[]
  | { [key: string]: AcpTranscriptJsonValue }
export type AcpTranscriptMetadata = Record<string, AcpTranscriptJsonValue>

export type AcpTranscriptEntry =
  | {
      kind: 'meta'
      schemaVersion: 1
      protocolVersion: typeof PROTOCOL_VERSION
      sdkVersion: typeof ACP_SDK_VERSION
      nodeVersion: string
      clientBehavior: 'raw' | 'strict'
      metadata: AcpTranscriptMetadata
    }
  | {
      kind: 'message'
      seq: number
      direction: AcpTranscriptDirection
      message: AnyMessage
    }
  | {
      kind: 'process_exit'
      seq: number
      code: number | null
      signal: NodeJS.Signals | null
    }

export type AcpProcessExit = {
  code: number | null
  signal: NodeJS.Signals | null
  stderrTail: string
  spawnError?: string
}

export type AcpProcessClientOptions = {
  command: string
  args?: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  requestTimeoutMs?: number
  updateTimeoutMs?: number
  shutdownTimeoutMs?: number
  stderrLimitBytes?: number
  clientBehavior?: 'raw' | 'strict'
  transcriptMetadata?: AcpTranscriptMetadata
}

export type WaitForSessionUpdateOptions = {
  afterIndex?: number
  timeoutMs?: number
}

export type AcpOperationOptions = {
  timeoutMs?: number
}

type SessionUpdateListener = (notification: SessionNotification) => void

export class AcpOperationTimeoutError extends Error {
  teardownError?: unknown

  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
    transcript: string
  ) {
    super(`ACP operation ${operation} exceeded its ${timeoutMs}ms timeout`)
    this.name = 'AcpOperationTimeoutError'
    this.transcript = transcript
  }

  transcript: string
}

export class AcpUpdateTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    readonly transcript: string
  ) {
    super(`ACP session update did not arrive within ${timeoutMs}ms`)
    this.name = 'AcpUpdateTimeoutError'
  }
}

export class AcpProcessExitError extends Error {
  constructor(
    readonly operation: string,
    readonly exit: AcpProcessExit,
    readonly transcript: string
  ) {
    const disposition = exit.spawnError
      ? `spawn error: ${exit.spawnError}`
      : `code ${String(exit.code)}, signal ${String(exit.signal)}`
    super(`ACP process exited during ${operation} (${disposition})`)
    this.name = 'AcpProcessExitError'
  }
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`)
  return value
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function canonicalizeTranscriptMetadata(metadata: AcpTranscriptMetadata): AcpTranscriptMetadata {
  const ancestors = new Set<object>()

  const visit = (value: unknown, path: string): AcpTranscriptJsonValue => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new TypeError(`transcript metadata ${path} must be a finite number`)
      return value
    }
    if (typeof value !== 'object') {
      throw new TypeError(`transcript metadata ${path} must be JSON-safe`)
    }
    if (ancestors.has(value)) throw new TypeError(`transcript metadata ${path} must not contain cycles`)

    ancestors.add(value)
    try {
      if (Array.isArray(value)) {
        const result: AcpTranscriptJsonValue[] = []
        for (let index = 0; index < value.length; index += 1) {
          if (!(index in value)) throw new TypeError(`transcript metadata ${path}[${String(index)}] must not be sparse`)
          result.push(visit(value[index], `${path}[${String(index)}]`))
        }
        return result
      }

      const prototype = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(`transcript metadata ${path} must contain only plain objects`)
      }
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new TypeError(`transcript metadata ${path} must not contain symbol keys`)
      }

      const result: Record<string, AcpTranscriptJsonValue> = {}
      for (const key of Object.keys(value).sort()) {
        result[key] = visit((value as Record<string, unknown>)[key], `${path}.${key}`)
      }
      return result
    } finally {
      ancestors.delete(value)
    }
  }

  return visit(metadata, 'metadata') as AcpTranscriptMetadata
}

function tapStream(stream: Stream, record: (direction: AcpTranscriptDirection, message: AnyMessage) => void): Stream {
  const writer = stream.writable.getWriter()
  const reader = stream.readable.getReader()

  return {
    writable: new WritableStream<AnyMessage>({
      async write(message) {
        record('client_to_agent', message)
        await writer.write(message)
      },
      async close() {
        await writer.close()
      },
      async abort(reason) {
        await writer.abort(reason)
      }
    }),
    readable: new ReadableStream<AnyMessage>({
      async pull(controller) {
        const result = await reader.read()
        if (result.done) {
          controller.close()
          return
        }

        record('agent_to_client', result.value)
        controller.enqueue(result.value)
      },
      async cancel(reason) {
        await reader.cancel(reason)
      }
    })
  }
}

export class AcpProcessClient {
  readonly cwd: string

  private readonly child: ChildProcessWithoutNullStreams
  private readonly connection: ClientSideConnection
  private readonly requestTimeoutMs: number
  private readonly updateTimeoutMs: number
  private readonly shutdownTimeoutMs: number
  private readonly stderrLimitBytes: number
  private readonly transcriptEntries: AcpTranscriptEntry[]
  private readonly sessionUpdates: SessionNotification[] = []
  private readonly updateListeners = new Set<SessionUpdateListener>()
  private readonly exitPromise: Promise<AcpProcessExit>
  private readonly closedPromise: Promise<AcpProcessExit>
  private resolveExit!: (exit: AcpProcessExit) => void
  private resolveClosed!: (exit: AcpProcessExit) => void
  private rejectClosed!: (error: Error) => void
  private stderrTail = Buffer.alloc(0)
  private sequence = 0
  private exitInfo: AcpProcessExit | undefined
  private closePromise: Promise<AcpProcessExit> | undefined
  private lastProcessError: string | undefined
  private spawned = false
  private closedSettled = false
  private unusable = false

  constructor(options: AcpProcessClientOptions) {
    if (!isAbsolute(options.command)) throw new TypeError('ACP harness command must be an absolute path')
    if (!isAbsolute(options.cwd)) throw new TypeError('ACP harness cwd must be an absolute path')

    this.cwd = options.cwd
    this.requestTimeoutMs = requirePositiveInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      'requestTimeoutMs'
    )
    this.updateTimeoutMs = requirePositiveInteger(
      options.updateTimeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS,
      'updateTimeoutMs'
    )
    this.shutdownTimeoutMs = requirePositiveInteger(
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
      'shutdownTimeoutMs'
    )
    this.stderrLimitBytes = requirePositiveInteger(
      options.stderrLimitBytes ?? DEFAULT_STDERR_LIMIT_BYTES,
      'stderrLimitBytes'
    )
    this.transcriptEntries = [
      {
        kind: 'meta',
        schemaVersion: 1,
        protocolVersion: PROTOCOL_VERSION,
        sdkVersion: ACP_SDK_VERSION,
        nodeVersion: process.versions.node,
        clientBehavior: options.clientBehavior ?? 'raw',
        metadata: canonicalizeTranscriptMetadata(options.transcriptMetadata ?? {})
      }
    ]
    this.exitPromise = new Promise(resolve => {
      this.resolveExit = resolve
    })
    this.closedPromise = new Promise((resolve, reject) => {
      this.resolveClosed = resolve
      this.rejectClosed = reject
    })
    void this.closedPromise.catch(() => undefined)

    this.child = spawn(options.command, [...(options.args ?? [])], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      detached: process.platform !== 'win32'
    })
    this.child.stderr.on('data', chunk => this.captureStderr(chunk))
    this.child.once('spawn', () => {
      this.spawned = true
    })
    this.child.on('error', error => {
      if (!this.spawned && this.child.pid === undefined) {
        this.settleExit({
          code: null,
          signal: null,
          stderrTail: this.stderrText(),
          spawnError: error.message
        })
        return
      }
      this.lastProcessError = error.message
    })
    this.child.once('close', (code, signal) => {
      this.settleExit({
        code,
        signal,
        stderrTail: this.stderrText()
      })
    })

    const output = NodeWritable.toWeb(this.child.stdin) as WritableStream<Uint8Array>
    const input = NodeReadable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>
    const stream = tapStream(ndJsonStream(output, input), (direction, message) => {
      this.recordMessage(direction, message)
    })
    const client: Client = {
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      sessionUpdate: async notification => {
        const retained = clone(notification)
        this.sessionUpdates.push(retained)
        for (const listener of this.updateListeners) listener(clone(retained))
      }
    }

    this.connection = new ClientSideConnection(() => client, stream)
    this.connection.signal.addEventListener(
      'abort',
      () => {
        if (!this.closePromise && !this.exitInfo) void this.close().catch(() => undefined)
      },
      { once: true }
    )
  }

  get closed(): Promise<AcpProcessExit> {
    return this.closedPromise
  }

  get processId(): number | undefined {
    return this.child.pid
  }

  get isRunning(): boolean {
    return this.exitInfo === undefined && this.child.exitCode === null && this.child.signalCode === null
  }

  get retainedSessionUpdateCount(): number {
    return this.sessionUpdates.length
  }

  transcript(): AcpTranscriptEntry[] {
    return clone(this.transcriptEntries)
  }

  transcriptNdjson(): string {
    return `${this.transcriptEntries.map(entry => JSON.stringify(entry)).join('\n')}\n`
  }

  subscribeSessionUpdates(listener: SessionUpdateListener, replay = true): () => void {
    if (replay) {
      for (const notification of this.sessionUpdates) listener(clone(notification))
    }

    this.updateListeners.add(listener)
    return () => {
      this.updateListeners.delete(listener)
    }
  }

  async waitForSessionUpdate(
    predicate: (notification: SessionNotification) => boolean,
    options: WaitForSessionUpdateOptions = {}
  ): Promise<SessionNotification> {
    const afterIndex = options.afterIndex ?? 0
    if (!Number.isInteger(afterIndex) || afterIndex < 0)
      throw new TypeError('afterIndex must be a non-negative integer')

    for (const notification of this.sessionUpdates.slice(afterIndex)) {
      if (predicate(clone(notification))) return clone(notification)
    }
    if (this.exitInfo) throw new AcpProcessExitError('session/update', this.exitInfo, this.transcriptNdjson())

    const timeoutMs = requirePositiveInteger(options.timeoutMs ?? this.updateTimeoutMs, 'timeoutMs')
    return await new Promise<SessionNotification>((resolve, reject) => {
      let settled = false
      const finish = (complete: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.updateListeners.delete(listener)
        complete()
      }
      const listener: SessionUpdateListener = notification => {
        try {
          if (!predicate(clone(notification))) return
          finish(() => resolve(clone(notification)))
        } catch (error) {
          finish(() => reject(error))
        }
      }
      const timer = setTimeout(() => {
        finish(() => reject(new AcpUpdateTimeoutError(timeoutMs, this.transcriptNdjson())))
      }, timeoutMs)
      this.updateListeners.add(listener)
      void this.exitPromise.then(exit => {
        finish(() => reject(new AcpProcessExitError('session/update', exit, this.transcriptNdjson())))
      })
    })
  }

  async initialize(
    params: InitializeRequest = {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {}
    }
  ): Promise<InitializeResponse> {
    const result = await this.runOperation('initialize', () => this.connection.initialize(params))
    if (result.protocolVersion !== PROTOCOL_VERSION) {
      this.unusable = true
      await this.close()
      throw new Error(
        `ACP protocol mismatch: harness requires ${String(PROTOCOL_VERSION)}, agent returned ${String(result.protocolVersion)}`
      )
    }
    return result
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const result = await this.runOperation('session/new', () => this.connection.newSession(params))
    if (typeof result.sessionId !== 'string' || result.sessionId.length === 0) {
      this.unusable = true
      await this.close()
      throw new Error('ACP session/new returned an invalid sessionId')
    }
    return result
  }

  async prompt(params: PromptRequest, options: AcpOperationOptions = {}): Promise<PromptResponse> {
    const timeoutMs = requirePositiveInteger(options.timeoutMs ?? this.requestTimeoutMs, 'timeoutMs')
    return await this.runOperation('session/prompt', () => this.connection.prompt(params), timeoutMs)
  }

  async cancel(params: CancelNotification): Promise<void> {
    await this.runOperation('session/cancel', () => this.connection.cancel(params))
  }

  async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return await this.runOperation(method, () => this.connection.extMethod(method, params))
  }

  close(): Promise<AcpProcessExit> {
    this.closePromise ??= this.performClose()
    return this.closePromise
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }

  private async runOperation<T>(
    operation: string,
    invoke: () => Promise<T>,
    timeoutMs = this.requestTimeoutMs
  ): Promise<T> {
    if (this.unusable || this.closePromise || this.connection.signal.aborted) {
      let closeError: unknown
      if (!this.exitInfo && (this.closePromise || this.connection.signal.aborted)) {
        try {
          await this.close()
        } catch (error) {
          closeError = error
        }
      }
      if (this.exitInfo) throw new AcpProcessExitError(operation, this.exitInfo, this.transcriptNdjson())
      if (closeError) throw closeError
      throw new Error(`ACP process client is closed and cannot run ${operation}`)
    }

    let timeout: NodeJS.Timeout | undefined
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new AcpOperationTimeoutError(operation, timeoutMs, this.transcriptNdjson()))
      }, timeoutMs)
    })
    const exitPromise = this.exitPromise.then(exit => {
      throw new AcpProcessExitError(operation, exit, this.transcriptNdjson())
    })

    try {
      const result = await Promise.race([invoke(), timeoutPromise, exitPromise])
      if (this.connection.signal.aborted) {
        throw this.connection.signal.reason ?? new Error(`ACP transport closed during ${operation}`)
      }
      return result
    } catch (error) {
      if (error instanceof AcpOperationTimeoutError) {
        this.unusable = true
        try {
          await this.close()
        } catch (teardownError) {
          error.teardownError = teardownError
        }
        error.transcript = this.transcriptNdjson()
      } else if (!(error instanceof AcpProcessExitError)) {
        let teardownError: unknown
        if (!this.exitInfo && this.connection.signal.aborted) {
          try {
            await this.close()
          } catch (closeError) {
            teardownError = closeError
          }
        }
        if (this.exitInfo) {
          throw new AcpProcessExitError(operation, this.exitInfo, this.transcriptNdjson())
        }
        if (teardownError) throw teardownError
      }
      throw error
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  private recordMessage(direction: AcpTranscriptDirection, message: AnyMessage): void {
    this.transcriptEntries.push({
      kind: 'message',
      seq: ++this.sequence,
      direction,
      message: clone(message)
    })
  }

  private captureStderr(chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    const combined = Buffer.concat([this.stderrTail, bytes])
    this.stderrTail =
      combined.length <= this.stderrLimitBytes ? combined : combined.subarray(combined.length - this.stderrLimitBytes)
  }

  private stderrText(): string {
    const codePoints = Array.from(this.stderrTail.toString('utf8'))
    const retained: string[] = []
    let retainedBytes = 0

    for (let index = codePoints.length - 1; index >= 0; index -= 1) {
      const codePoint = codePoints[index]
      const codePointBytes = Buffer.byteLength(codePoint)
      if (retainedBytes + codePointBytes > this.stderrLimitBytes) break
      retained.push(codePoint)
      retainedBytes += codePointBytes
    }
    return retained.reverse().join('')
  }

  private settleExit(exit: AcpProcessExit): void {
    if (this.exitInfo) return
    this.exitInfo = exit
    this.transcriptEntries.push({
      kind: 'process_exit',
      seq: ++this.sequence,
      code: exit.code,
      signal: exit.signal
    })
    this.resolveExit(exit)
    if (!this.closePromise) void this.close().catch(() => undefined)
  }

  private async performClose(): Promise<AcpProcessExit> {
    if (!this.exitInfo) {
      try {
        this.child.stdin.end()
      } catch {
        this.child.stdin.destroy()
      }
    }

    if (!(await this.waitForProcessTreeExit(this.shutdownTimeoutMs))) {
      this.signalProcess('SIGTERM')
    }
    if (!(await this.waitForProcessTreeExit(this.shutdownTimeoutMs))) {
      this.signalProcess('SIGKILL')
    }
    if (!(await this.waitForProcessTreeExit(this.shutdownTimeoutMs))) {
      this.destroyStreams()
      const processError = this.lastProcessError ? `; last process error: ${this.lastProcessError}` : ''
      const error = new Error(`ACP process tree ${String(this.processId)} did not exit after SIGKILL${processError}`)
      if (!this.closedSettled) {
        this.closedSettled = true
        this.rejectClosed(error)
      }
      throw error
    }

    this.destroyStreams()
    const exit = this.exitInfo!
    if (!this.closedSettled) {
      this.closedSettled = true
      this.resolveClosed(exit)
    }
    return exit
  }

  private async waitForProcessTreeExit(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (true) {
      if (this.exitInfo && !this.processGroupIsRunning()) return true

      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) return false
      await new Promise(resolve => setTimeout(resolve, Math.min(10, remainingMs)))
    }
  }

  private processGroupIsRunning(): boolean {
    if (process.platform === 'win32') return this.exitInfo === undefined

    const pid = this.child.pid
    if (pid === undefined) return this.exitInfo === undefined
    try {
      process.kill(-pid, 0)
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ESRCH') return false
      if (code !== 'EPERM') this.lastProcessError = error instanceof Error ? error.message : String(error)
      return true
    }
  }

  private signalProcess(signal: NodeJS.Signals): void {
    const pid = this.child.pid
    if (process.platform !== 'win32' && pid !== undefined) {
      try {
        process.kill(-pid, signal)
        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
        this.lastProcessError = error instanceof Error ? error.message : String(error)
      }
    }

    try {
      if (!this.child.kill(signal)) this.lastProcessError = `failed to send ${signal} to child process`
    } catch (error) {
      this.lastProcessError = error instanceof Error ? error.message : String(error)
    }
  }

  private destroyStreams(): void {
    this.child.stdin.destroy()
    this.child.stdout.destroy()
    this.child.stderr.destroy()
  }
}
