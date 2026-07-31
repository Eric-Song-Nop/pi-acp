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

export type AcpTerminalLifecycle = {
  cause?: unknown
  exit?: AcpProcessExit
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

type SessionUpdateListener = (notification: SessionNotification) => void | PromiseLike<void>
type ProcessExitListener = (exit: AcpProcessExit) => void
type TerminalLifecycleListener = (terminal: AcpTerminalLifecycle) => void

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

export class AcpClientLifecycleError extends Error {
  readonly code = 'ACP_CLIENT_FATAL'

  constructor(
    readonly operation: string,
    readonly fatalReason: Error,
    readonly transcript: string
  ) {
    super(`ACP operation ${operation} was aborted by fatal client lifecycle: ${fatalReason.message}`)
    this.name = 'AcpClientLifecycleError'
  }
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

export class AcpTransportClosedError extends Error {
  readonly code = 'ACP_TRANSPORT_CLOSED'

  constructor(
    readonly operation: string,
    readonly transportReason: unknown,
    readonly transcript: string
  ) {
    const detail = transportReason instanceof Error ? `: ${transportReason.message}` : ''
    super(`ACP transport closed during ${operation}${detail}`, { cause: transportReason })
    this.name = 'AcpTransportClosedError'
  }
}

export class AcpMalformedMessageError extends Error {
  readonly code = 'ACP_MALFORMED_MESSAGE'
  transcript = ''
  exit?: AcpProcessExit
  teardownError?: unknown

  constructor(
    readonly reason: string,
    readonly receivedKind: string
  ) {
    super(`Rejected malformed ACP JSON-RPC message (${receivedKind}): ${reason}`)
    this.name = 'AcpMalformedMessageError'
  }
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`)
  return value
}

function requireExplicitEnvironment(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  if (env === undefined || env === null || typeof env !== 'object' || Array.isArray(env)) {
    throw new TypeError('ACP harness env must be an explicitly supplied plain object')
  }

  const prototype = Object.getPrototypeOf(env)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('ACP harness env must be an explicitly supplied plain object')
  }
  if (Object.getOwnPropertySymbols(env).length > 0) {
    throw new TypeError('ACP harness env must not contain symbol keys')
  }

  const normalized: NodeJS.ProcessEnv = Object.create(null)
  for (const key of Object.keys(env)) {
    const value = env[key]
    if (value !== undefined && typeof value !== 'string') {
      throw new TypeError(`ACP harness env.${key} must be a string or undefined`)
    }
    normalized[key] = value
  }
  return normalized
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
        Object.defineProperty(result, key, {
          value: visit((value as Record<string, unknown>)[key], `${path}.${key}`),
          enumerable: true,
          configurable: true,
          writable: true
        })
      }
      return result
    } finally {
      ancestors.delete(value)
    }
  }

  return visit(metadata, 'metadata') as AcpTranscriptMetadata
}

function receivedKind(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function canonicalizeOutgoingJsonValue(
  value: unknown,
  path: string,
  ancestors = new Set<object>()
): AcpTranscriptJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must be a finite number`)
    return Object.is(value, -0) ? 0 : value
  }
  if (typeof value !== 'object') throw new TypeError(`${path} must be JSON-safe`)
  if (ancestors.has(value)) throw new TypeError(`${path} must not contain cycles`)

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const result: AcpTranscriptJsonValue[] = []
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) throw new TypeError(`${path}[${String(index)}] must not be sparse`)
        result.push(canonicalizeOutgoingJsonValue(value[index], `${path}[${String(index)}]`, ancestors))
      }
      return result
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must contain only plain objects`)
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError(`${path} must not contain symbol keys`)
    }

    const result: Record<string, AcpTranscriptJsonValue> = {}
    for (const key of Object.keys(value).sort()) {
      const propertyValue = (value as Record<string, unknown>)[key]
      if (propertyValue === undefined) continue
      Object.defineProperty(result, key, {
        value: canonicalizeOutgoingJsonValue(propertyValue, `${path}.${key}`, ancestors),
        enumerable: true,
        configurable: true,
        writable: true
      })
    }
    return result
  } finally {
    ancestors.delete(value)
  }
}

function isRequestId(value: unknown): value is string | number | null {
  return value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
}

function validateIncomingMessage(value: unknown): AnyMessage {
  const kind = receivedKind(value)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AcpMalformedMessageError('expected a JSON object envelope', kind)
  }

  const message = value as Record<string, unknown>
  if (!Object.hasOwn(message, 'jsonrpc') || message.jsonrpc !== '2.0') {
    throw new AcpMalformedMessageError('jsonrpc must equal "2.0"', kind)
  }

  const hasMethod = Object.hasOwn(message, 'method')
  const hasId = Object.hasOwn(message, 'id')
  const hasResult = Object.hasOwn(message, 'result')
  const hasError = Object.hasOwn(message, 'error')

  if (hasMethod) {
    if (typeof message.method !== 'string') {
      throw new AcpMalformedMessageError('request/notification method must be a string', kind)
    }
    if (hasId && !isRequestId(message.id)) {
      throw new AcpMalformedMessageError('request id must be a string, finite number, or null', kind)
    }
    if (hasResult || hasError) {
      throw new AcpMalformedMessageError('request/notification must not contain result or error', kind)
    }
    return message as AnyMessage
  }

  if (!hasId || !isRequestId(message.id)) {
    throw new AcpMalformedMessageError('response id must be a string, finite number, or null', kind)
  }
  if (hasResult === hasError) {
    throw new AcpMalformedMessageError('response must contain exactly one of result or error', kind)
  }
  if (hasError) {
    const error = message.error
    if (error === null || typeof error !== 'object' || Array.isArray(error)) {
      throw new AcpMalformedMessageError('response error must be a JSON object', kind)
    }
    const errorRecord = error as Record<string, unknown>
    if (
      !Object.hasOwn(errorRecord, 'code') ||
      !Object.hasOwn(errorRecord, 'message') ||
      !Number.isInteger(errorRecord.code) ||
      typeof errorRecord.message !== 'string'
    ) {
      throw new AcpMalformedMessageError('response error requires an integer code and string message', kind)
    }
  }

  return message as AnyMessage
}

function canonicalizeOutgoingMessage(value: unknown): AnyMessage {
  try {
    return validateIncomingMessage(canonicalizeOutgoingJsonValue(value, 'outgoing message'))
  } catch (error) {
    if (error instanceof AcpMalformedMessageError) throw error
    const reason = error instanceof Error ? error.message : String(error)
    throw new AcpMalformedMessageError(reason, receivedKind(value))
  }
}

function tapStream(stream: Stream, record: (direction: AcpTranscriptDirection, message: AnyMessage) => void): Stream {
  const writer = stream.writable.getWriter()
  const reader = stream.readable.getReader()

  return {
    writable: new WritableStream<AnyMessage>({
      async write(message) {
        const canonicalMessage = canonicalizeOutgoingMessage(message)
        record('client_to_agent', canonicalMessage)
        await writer.write(canonicalMessage)
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

        const message = validateIncomingMessage(result.value)
        record('agent_to_client', message)
        controller.enqueue(message)
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
  private readonly exitListeners = new Set<ProcessExitListener>()
  private readonly terminalLifecycleListeners = new Set<TerminalLifecycleListener>()
  private readonly fatalLifecycleController = new AbortController()
  private readonly terminalLifecycleController = new AbortController()
  private readonly closedPromise: Promise<AcpProcessExit>
  private resolveClosed!: (exit: AcpProcessExit) => void
  private rejectClosed!: (error: Error) => void
  private stderrTail = Buffer.alloc(0)
  private sequence = 0
  private exitInfo: AcpProcessExit | undefined
  private closePromise: Promise<AcpProcessExit> | undefined
  private lastProcessError: string | undefined
  private malformedMessageError: AcpMalformedMessageError | undefined
  private terminalLifecycle: AcpTerminalLifecycle | undefined
  private fatalLifecycleTranscript: string | undefined
  private terminalLifecycleTranscript: string | undefined
  private spawned = false
  private closedSettled = false
  private unusable = false

  constructor(options: AcpProcessClientOptions) {
    if (!isAbsolute(options.command)) throw new TypeError('ACP harness command must be an absolute path')
    if (!isAbsolute(options.cwd)) throw new TypeError('ACP harness cwd must be an absolute path')
    if (!Object.hasOwn(options, 'env')) {
      throw new TypeError('ACP harness env must be an explicitly supplied plain object')
    }

    const env = requireExplicitEnvironment(options.env)
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
    this.closedPromise = new Promise((resolve, reject) => {
      this.resolveClosed = resolve
      this.rejectClosed = reject
    })
    void this.closedPromise.catch(() => undefined)

    this.child = spawn(options.command, [...(options.args ?? [])], {
      cwd: options.cwd,
      env,
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
        if (
          this.terminalLifecycleController.signal.aborted ||
          this.fatalLifecycleController.signal.aborted ||
          this.closePromise ||
          this.exitInfo
        ) {
          return
        }
        const retained = clone(notification)
        this.sessionUpdates.push(retained)
        for (const listener of [...this.updateListeners]) {
          this.deliverSessionUpdate(listener, retained)
        }
      }
    }

    this.connection = new ClientSideConnection(() => client, stream)
    this.connection.signal.addEventListener(
      'abort',
      () => {
        const reason = this.connection.signal.reason
        if (reason instanceof AcpMalformedMessageError) {
          this.malformedMessageError = reason
          this.beginFatalLifecycle(reason)
        } else {
          this.beginTerminalLifecycle({
            cause: reason instanceof Error ? reason : new Error('ACP transport entered a terminal lifecycle state')
          })
        }
        if (!this.closePromise && !this.exitInfo) void this.ensureClose().catch(() => undefined)
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

  get fatalLifecycleSignal(): AbortSignal {
    return this.fatalLifecycleController.signal
  }

  get terminalLifecycleSignal(): AbortSignal {
    return this.terminalLifecycleController.signal
  }

  get isRunning(): boolean {
    return (
      !this.terminalLifecycleController.signal.aborted &&
      !this.fatalLifecycleController.signal.aborted &&
      !this.closePromise &&
      !this.connection.signal.aborted &&
      this.exitInfo === undefined &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    )
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
      for (const notification of this.sessionUpdates) this.deliverSessionUpdate(listener, notification)
    }

    this.updateListeners.add(listener)
    return () => {
      this.updateListeners.delete(listener)
    }
  }

  subscribeTerminalLifecycle(listener: TerminalLifecycleListener, replay = true): () => void {
    const terminal = this.terminalLifecycle
    if (terminal) {
      if (replay) this.deliverTerminalLifecycle(listener, terminal)
      return () => undefined
    }

    this.terminalLifecycleListeners.add(listener)
    return () => {
      this.terminalLifecycleListeners.delete(listener)
    }
  }

  private deliverSessionUpdate(listener: SessionUpdateListener, notification: SessionNotification): void {
    try {
      const delivery = listener(clone(notification))
      if (delivery) void Promise.resolve(delivery).catch(() => undefined)
    } catch {
      // A diagnostic observer must not prevent later stateful subscribers
      // from receiving the authoritative catalog/update.
    }
  }

  private deliverTerminalLifecycle(listener: TerminalLifecycleListener, terminal: AcpTerminalLifecycle): void {
    try {
      listener({
        cause: terminal.cause,
        exit: terminal.exit ? clone(terminal.exit) : undefined
      })
    } catch {
      // Lifecycle delivery must reach every active stateful subscriber.
    }
  }

  async waitForSessionUpdate(
    predicate: (notification: SessionNotification) => boolean,
    options: WaitForSessionUpdateOptions = {}
  ): Promise<SessionNotification> {
    const afterIndex = options.afterIndex ?? 0
    if (!Number.isInteger(afterIndex) || afterIndex < 0)
      throw new TypeError('afterIndex must be a non-negative integer')
    if (afterIndex > this.sessionUpdates.length) {
      throw new RangeError(
        `afterIndex ${String(afterIndex)} exceeds retained session update count ${String(this.sessionUpdates.length)}`
      )
    }

    for (const notification of this.sessionUpdates.slice(afterIndex)) {
      if (predicate(clone(notification))) return clone(notification)
    }
    if (this.fatalLifecycleController.signal.aborted) {
      throw this.fatalLifecycleReason('session/update')
    }
    if (this.exitInfo) throw new AcpProcessExitError('session/update', this.exitInfo, this.transcriptNdjson())
    if (this.terminalLifecycleController.signal.aborted) {
      throw this.terminalLifecycleReason('session/update')
    }

    const timeoutMs = requirePositiveInteger(options.timeoutMs ?? this.updateTimeoutMs, 'timeoutMs')
    return await new Promise<SessionNotification>((resolve, reject) => {
      let settled = false
      const exitListener: ProcessExitListener = exit => {
        finish(() => reject(new AcpProcessExitError('session/update', exit, this.transcriptNdjson())))
      }
      const fatalLifecycleListener = (): void => {
        finish(() => reject(this.fatalLifecycleReason('session/update')))
      }
      const terminalLifecycleListener = (): void => {
        finish(() => reject(this.terminalLifecycleReason('session/update')))
      }
      const finish = (complete: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.updateListeners.delete(listener)
        this.exitListeners.delete(exitListener)
        this.fatalLifecycleController.signal.removeEventListener('abort', fatalLifecycleListener)
        this.terminalLifecycleController.signal.removeEventListener('abort', terminalLifecycleListener)
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
      this.exitListeners.add(exitListener)
      this.fatalLifecycleController.signal.addEventListener('abort', fatalLifecycleListener, { once: true })
      this.terminalLifecycleController.signal.addEventListener('abort', terminalLifecycleListener, {
        once: true
      })
      if (this.terminalLifecycleController.signal.aborted) terminalLifecycleListener()
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
    this.beginFatalLifecycle(new Error('ACP process client teardown has begun'))
    return this.ensureClose()
  }

  private ensureClose(): Promise<AcpProcessExit> {
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
    if (
      this.unusable ||
      this.closePromise ||
      this.fatalLifecycleController.signal.aborted ||
      this.connection.signal.aborted ||
      this.exitInfo
    ) {
      let closeError: unknown
      if (
        !this.exitInfo &&
        (this.closePromise || this.fatalLifecycleController.signal.aborted || this.connection.signal.aborted)
      ) {
        try {
          await this.ensureClose()
        } catch (error) {
          closeError = error
        }
      }
      if (this.malformedMessageError) {
        throw this.finalizeMalformedMessageError(this.malformedMessageError, closeError)
      }
      if (this.exitInfo) throw new AcpProcessExitError(operation, this.exitInfo, this.transcriptNdjson())
      if (closeError) throw closeError
      if (this.fatalLifecycleController.signal.aborted) throw this.fatalLifecycleReason(operation)
      throw new Error(`ACP process client is closed and cannot run ${operation}`)
    }

    let timeout: NodeJS.Timeout | undefined
    let exitListener: ProcessExitListener | undefined
    let fatalLifecycleListener: (() => void) | undefined
    let raceResourcesCleaned = false
    const cleanupRaceResources = (): void => {
      if (raceResourcesCleaned) return
      raceResourcesCleaned = true
      if (timeout) {
        clearTimeout(timeout)
        timeout = undefined
      }
      if (exitListener) {
        this.exitListeners.delete(exitListener)
        exitListener = undefined
      }
      if (fatalLifecycleListener) {
        this.fatalLifecycleController.signal.removeEventListener('abort', fatalLifecycleListener)
        fatalLifecycleListener = undefined
      }
    }
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        const error = new AcpOperationTimeoutError(operation, timeoutMs, this.transcriptNdjson())
        cleanupRaceResources()
        reject(error)
        this.beginFatalLifecycle(error)
      }, timeoutMs)
    })
    const exitPromise = new Promise<never>((_resolve, reject) => {
      exitListener = exit => {
        cleanupRaceResources()
        reject(new AcpProcessExitError(operation, exit, this.transcriptNdjson()))
      }
      this.exitListeners.add(exitListener)
    })
    const fatalLifecyclePromise = new Promise<never>((_resolve, reject) => {
      fatalLifecycleListener = () => {
        cleanupRaceResources()
        reject(this.fatalLifecycleReason(operation))
      }
      this.fatalLifecycleController.signal.addEventListener('abort', fatalLifecycleListener, { once: true })
    })

    try {
      const result = await Promise.race([invoke(), timeoutPromise, exitPromise, fatalLifecyclePromise])
      cleanupRaceResources()
      if (this.fatalLifecycleController.signal.aborted) throw this.fatalLifecycleReason(operation)
      if (this.connection.signal.aborted) {
        throw this.connection.signal.reason ?? new Error(`ACP transport closed during ${operation}`)
      }
      return result
    } catch (error) {
      cleanupRaceResources()
      const malformedError = error instanceof AcpMalformedMessageError ? error : this.malformedMessageError
      if (malformedError) {
        this.beginFatalLifecycle(malformedError)
        let teardownError: unknown
        try {
          await this.ensureClose()
        } catch (closeError) {
          teardownError = closeError
        }
        throw this.finalizeMalformedMessageError(malformedError, teardownError)
      }
      if (error instanceof AcpOperationTimeoutError) {
        this.beginFatalLifecycle(error)
        try {
          await this.ensureClose()
        } catch (teardownError) {
          error.teardownError = teardownError
        }
        error.transcript = this.transcriptNdjson()
      } else if (!(error instanceof AcpProcessExitError)) {
        let teardownError: unknown
        if (!this.exitInfo && this.connection.signal.aborted) {
          try {
            await this.ensureClose()
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
      cleanupRaceResources()
    }
  }

  private beginFatalLifecycle(reason: Error): void {
    this.unusable = true
    if (!this.fatalLifecycleController.signal.aborted) {
      this.fatalLifecycleTranscript = this.transcriptNdjson()
      this.fatalLifecycleController.abort(reason)
    }
    this.beginTerminalLifecycle({ cause: reason })
  }

  private beginTerminalLifecycle(terminal: AcpTerminalLifecycle): void {
    this.unusable = true
    if (this.terminalLifecycle) return

    this.terminalLifecycle = {
      cause: terminal.cause,
      exit: terminal.exit ? clone(terminal.exit) : undefined
    }
    this.terminalLifecycleTranscript = this.transcriptNdjson()
    const abortReason =
      terminal.cause ??
      (terminal.exit
        ? new Error(`ACP process exited (code ${String(terminal.exit.code)}, signal ${String(terminal.exit.signal)})`)
        : new Error('ACP transport entered a terminal lifecycle state'))
    this.terminalLifecycleController.abort(abortReason)

    const listeners = [...this.terminalLifecycleListeners]
    this.terminalLifecycleListeners.clear()
    for (const listener of listeners) this.deliverTerminalLifecycle(listener, this.terminalLifecycle)
  }

  private fatalLifecycleReason(operation: string): Error {
    const reason = this.fatalLifecycleController.signal.reason
    const fatalReason =
      reason instanceof Error
        ? reason
        : new Error(`ACP process client entered a fatal lifecycle state during ${operation}`)
    return new AcpClientLifecycleError(operation, fatalReason, this.fatalLifecycleTranscript ?? this.transcriptNdjson())
  }

  private terminalLifecycleReason(operation: string): Error {
    if (this.exitInfo) return new AcpProcessExitError(operation, this.exitInfo, this.transcriptNdjson())
    const reason = this.terminalLifecycle?.cause ?? this.terminalLifecycleController.signal.reason
    return new AcpTransportClosedError(operation, reason, this.terminalLifecycleTranscript ?? this.transcriptNdjson())
  }

  private finalizeMalformedMessageError(
    error: AcpMalformedMessageError,
    teardownError?: unknown
  ): AcpMalformedMessageError {
    error.exit = this.exitInfo
    error.teardownError = teardownError
    error.transcript = this.transcriptNdjson()
    return error
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
    const exitListeners = [...this.exitListeners]
    this.exitListeners.clear()
    for (const listener of exitListeners) {
      try {
        listener(exit)
      } catch {
        // Exit delivery must reach every active waiter/operation.
      }
    }
    this.beginTerminalLifecycle({ exit })
    if (!this.closePromise) void this.ensureClose().catch(() => undefined)
  }

  private async performClose(): Promise<AcpProcessExit> {
    if (!this.exitInfo) {
      try {
        this.child.stdin.end()
      } catch {
        this.child.stdin.destroy()
      }
    }

    if (!(await this.waitForManagedProcessExit(this.shutdownTimeoutMs))) {
      this.signalProcess('SIGTERM')
    }
    if (!(await this.waitForManagedProcessExit(this.shutdownTimeoutMs))) {
      this.signalProcess('SIGKILL')
    }
    if (!(await this.waitForManagedProcessExit(this.shutdownTimeoutMs))) {
      this.destroyStreams()
      const processError = this.lastProcessError ? `; last process error: ${this.lastProcessError}` : ''
      const managedTarget = process.platform === 'win32' ? 'child process' : 'process group'
      const error = new Error(
        `ACP ${managedTarget} ${String(this.processId)} did not exit after SIGKILL${processError}`
      )
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

  private async waitForManagedProcessExit(timeoutMs: number): Promise<boolean> {
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
