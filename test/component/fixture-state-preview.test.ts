import test from 'node:test'
import assert from 'node:assert/strict'
import { RequestError, type AgentSideConnection, type PromptRequest } from '@agentclientprotocol/sdk'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FIXTURE_STATE_COMMAND_NAME } from '../../src/acp/pi-commands.js'
import { PiAcpSession, TERMINAL_UPDATE_FLUSH_TIMEOUT_MS } from '../../src/acp/session.js'
import {
  PiRpcExecuteCommandProtocolError,
  PiRpcProcessCleanupError,
  PiRpcProcessTerminatedError,
  type PiRpcExecuteCommandResult
} from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const SESSION_ID = 'fixture-state-preview-session'
const CWD = '/tmp/pi-acp-fixture-state-preview'
const COMMAND_CATALOG = {
  commands: [
    {
      name: 'fixture-state',
      description: 'Fixture state',
      source: 'extension',
      sourceInfo: {
        path: '/private/project/.pi/extensions/fixture.ts',
        source: 'project-settings',
        scope: 'project',
        origin: 'top-level'
      }
    }
  ]
}

class PreviewPiProcess extends FakePiRpcProcess {
  readonly executeCalls: Array<{ requestId: string; name: string; args: string }> = []
  readonly compactCalls: Array<{ customInstructions: string | undefined }> = []
  readonly setModelCalls: Array<{ provider: string; modelId: string }> = []
  readonly setThinkingLevelCalls: string[] = []
  commandCatalog: unknown = COMMAND_CATALOG
  getCommandsCount = 0
  getSessionStatsCount = 0
  notifyBeforeResponse = false
  resultFactory: (requestId: string, name: string) => PiRpcExecuteCommandResult = (requestId, name) => ({
    success: true,
    data: {
      requestId,
      name,
      source: 'extension',
      sourceInfo: {},
      disposition: 'handled'
    }
  })

  async getCommands(): Promise<unknown> {
    this.getCommandsCount += 1
    return this.commandCatalog
  }

  async compact(customInstructions?: string): Promise<unknown> {
    this.compactCalls.push({ customInstructions })
    return { tokensBefore: 1, summary: 'compacted' }
  }

  async getSessionStats(): Promise<unknown> {
    this.getSessionStatsCount += 1
    return { sessionId: SESSION_ID, totalMessages: 0 }
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    this.setModelCalls.push({ provider, modelId })
  }

  async setThinkingLevel(level: string): Promise<void> {
    this.setThinkingLevelCalls.push(level)
  }

  async executeCommand(requestId: string, name: string, args: string): Promise<PiRpcExecuteCommandResult> {
    this.executeCalls.push({ requestId, name, args })
    if (this.notifyBeforeResponse) {
      this.emit({
        type: 'extension_ui_request',
        id: 'fixture-notify',
        method: 'notify',
        message: 'Pi ACP fixture loaded',
        notifyType: 'info'
      })
    }
    return this.resultFactory(requestId, name)
  }
}

class DeferredPreviewPiProcess extends PreviewPiProcess {
  private rejectExecute: ((error: unknown) => void) | null = null
  cleanupBarrier: Promise<void> | null = null
  cleanupFailure: Error | null = null

  override executeCommand(requestId: string, name: string, args: string): Promise<PiRpcExecuteCommandResult> {
    this.executeCalls.push({ requestId, name, args })
    return new Promise((_resolve, reject) => {
      this.rejectExecute = reject
    })
  }

  override async stop(): Promise<void> {
    const error = new PiRpcProcessTerminatedError('The exact Pi child was stopped.', undefined, { kind: 'stopped' })
    this.stopCount += 1
    this.terminate(error)
    this.rejectExecute?.(error)
    if (this.cleanupBarrier) await this.cleanupBarrier
    if (this.cleanupFailure) throw this.cleanupFailure
  }
}

class GatedCatalogPreviewPiProcess extends PreviewPiProcess {
  private releaseCatalogGate!: () => void
  private resolveCatalogStarted!: () => void
  readonly catalogStarted = new Promise<void>(resolve => {
    this.resolveCatalogStarted = resolve
  })
  private readonly catalogGate = new Promise<void>(resolve => {
    this.releaseCatalogGate = resolve
  })
  catalogFailure: Error | null = null

  override async getCommands(): Promise<unknown> {
    this.getCommandsCount += 1
    this.resolveCatalogStarted()
    await this.catalogGate
    if (this.catalogFailure) throw this.catalogFailure
    return COMMAND_CATALOG
  }

  releaseCatalog(): void {
    this.releaseCatalogGate()
  }
}

class GatedCompactPreviewPiProcess extends PreviewPiProcess {
  private releaseCompactGate!: () => void
  private resolveCompactStarted!: () => void
  readonly compactStarted = new Promise<void>(resolve => {
    this.resolveCompactStarted = resolve
  })
  private readonly compactGate = new Promise<void>(resolve => {
    this.releaseCompactGate = resolve
  })

  override async compact(customInstructions?: string): Promise<unknown> {
    this.compactCalls.push({ customInstructions })
    this.resolveCompactStarted()
    await this.compactGate
    return { tokensBefore: 1, summary: 'compacted' }
  }

  releaseCompact(): void {
    this.releaseCompactGate()
  }
}

class RejectingAckPreviewPiProcess extends PreviewPiProcess {
  ackAttempts = 0

  override async sendExtensionUiResponse(): Promise<void> {
    this.ackAttempts += 1
    throw new Error('fixture notify acknowledgement write failed')
  }
}

class GatedNotifyConnection extends FakeAgentSideConnection {
  private releaseNotify!: () => void
  private resolveNotifyStarted!: () => void
  readonly notifyDeliveryStarted = new Promise<void>(resolve => {
    this.resolveNotifyStarted = resolve
  })
  private readonly notifyGate = new Promise<void>(resolve => {
    this.releaseNotify = resolve
  })

  override async sessionUpdate(message: Parameters<AgentSideConnection['sessionUpdate']>[0]): Promise<void> {
    await super.sessionUpdate(message)
    if (
      message.update.sessionUpdate === 'agent_message_chunk' &&
      (message.update._meta as any)?.piAcp?.notify?.level === 'info'
    ) {
      this.resolveNotifyStarted()
      await this.notifyGate
    }
  }

  release(): void {
    this.releaseNotify()
  }
}

class FailThenGateCatalogConnection extends FakeAgentSideConnection {
  private releasePublicationGate!: () => void
  private resolveRetryStarted!: () => void
  readonly retryStarted = new Promise<void>(resolve => {
    this.resolveRetryStarted = resolve
  })
  private readonly publicationGate = new Promise<void>(resolve => {
    this.releasePublicationGate = resolve
  })
  catalogAttempts = 0

  override async sessionUpdate(message: Parameters<AgentSideConnection['sessionUpdate']>[0]): Promise<void> {
    if (message.update.sessionUpdate === 'available_commands_update') {
      this.catalogAttempts += 1
      if (this.catalogAttempts === 1) throw new Error('first catalog publication failed')
      if (this.catalogAttempts === 2) {
        this.resolveRetryStarted()
        await this.publicationGate
      }
    }
    await super.sessionUpdate(message)
  }

  releaseRetry(): void {
    this.releasePublicationGate()
  }
}

function createHarness(options?: {
  enabled?: boolean
  capability?: boolean
  proc?: PreviewPiProcess
  conn?: FakeAgentSideConnection
}) {
  const previous = process.env.PI_ACP_EXPERIMENTAL_FIXTURE_STATE
  if (options?.enabled) process.env.PI_ACP_EXPERIMENTAL_FIXTURE_STATE = '1'
  else delete process.env.PI_ACP_EXPERIMENTAL_FIXTURE_STATE

  const conn = options?.conn ?? new FakeAgentSideConnection()
  const proc = options?.proc ?? new PreviewPiProcess()
  const session = new PiAcpSession({
    sessionId: SESSION_ID,
    initialState: {
      sessionId: SESSION_ID,
      rpcCapabilities: { executeCommand: options?.capability === false ? 0 : 1 }
    },
    cwd: CWD,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn)
  })
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).restoreSession = async () => session
  ;(agent as any).sessions = {
    maybeGet: (sessionId: string) => (sessionId === SESSION_ID ? session : undefined)
  }

  if (previous === undefined) delete process.env.PI_ACP_EXPERIMENTAL_FIXTURE_STATE
  else process.env.PI_ACP_EXPERIMENTAL_FIXTURE_STATE = previous

  return { agent, session, proc, conn }
}

function prompt(blocks: PromptRequest['prompt']): PromptRequest {
  return { sessionId: SESSION_ID, prompt: blocks } as PromptRequest
}

function responseCode(response: any): unknown {
  return response?._meta?.piAcp?.executeCommand?.code
}

test('fixture-state preview is default-off and never falls through to generic prompt', async () => {
  const { agent, proc } = createHarness({ enabled: false })
  const response = await agent.prompt(prompt([{ type: 'text', text: '/fixture-state' }]))

  assert.equal(response.stopReason, 'refusal')
  assert.equal(responseCode(response), 'COMMAND_NOT_FOUND')
  assert.equal(proc.executeCalls.length, 0)
  assert.equal(proc.prompts.length, 0)
  assert.equal(proc.getCommandsCount, 1)
})

test('fixture-state preview refuses missing physical capability without exposure, prompt, or execute', async () => {
  const { agent, proc, session } = createHarness({ enabled: true, capability: false })
  const response = await agent.prompt(prompt([{ type: 'text', text: '/fixture-state' }]))

  assert.equal(response.stopReason, 'refusal')
  assert.equal(responseCode(response), 'COMMAND_NOT_FOUND')
  assert.equal(proc.executeCalls.length, 0)
  assert.equal(proc.prompts.length, 0)
  assert.equal(
    session.commandCatalogState.snapshot?.commands.some(command => command.name === 'fixture-state'),
    false
  )
})

for (const source of ['prompt', 'skill'] as const) {
  test(`fixture-state preview reserves a normalized ${source} alias when the flag is on but capability is absent`, async () => {
    const proc = new PreviewPiProcess()
    proc.commandCatalog = {
      commands: [{ name: ' fixture-state ', description: 'Normalized alias', source }]
    }
    const { agent, proc: harnessProc, session } = createHarness({ enabled: true, capability: false, proc })
    const response = await agent.prompt(prompt([{ type: 'text', text: '/fixture-state' }]))

    assert.equal(response.stopReason, 'refusal')
    assert.equal(responseCode(response), 'COMMAND_NOT_FOUND')
    assert.equal(harnessProc.executeCalls.length, 0)
    assert.equal(harnessProc.prompts.length, 0)
    assert.equal(
      session.commandCatalogState.snapshot?.commands.some(command => command.name === FIXTURE_STATE_COMMAND_NAME),
      false
    )
  })
}

test('scheduled catalog publication reserves normalized fixture-state while capability-gated exposure stays off', async () => {
  const proc = new PreviewPiProcess()
  proc.commandCatalog = {
    commands: [{ name: ' fixture-state ', description: 'Normalized alias', source: 'prompt' }]
  }
  const { agent, session, conn } = createHarness({ enabled: true, capability: false, proc })

  ;(agent as any).scheduleCommandCatalogPublication(session, true)
  while (session.commandCatalogState.publishedSnapshot === null) {
    await new Promise(resolve => setImmediate(resolve))
  }

  const publication = conn.updates.find(update => update.update.sessionUpdate === 'available_commands_update')
  assert.ok(publication)
  if (publication.update.sessionUpdate !== 'available_commands_update') assert.fail('unexpected catalog update shape')
  assert.equal(
    publication.update.availableCommands.some(command => command.name === FIXTURE_STATE_COMMAND_NAME),
    false
  )

  const response = await agent.prompt(prompt([{ type: 'text', text: '/fixture-state' }]))
  assert.equal(response.stopReason, 'refusal')
  assert.equal(responseCode(response), 'COMMAND_NOT_FOUND')
  assert.equal(proc.executeCalls.length, 0)
  assert.equal(proc.prompts.length, 0)
})

test('fixture-state preview refuses attachments before command admission', async () => {
  const { agent, proc } = createHarness({ enabled: true })
  const response = await agent.prompt(
    prompt([
      { type: 'text', text: '/fixture-state' },
      { type: 'image', mimeType: 'image/png', data: 'AA==' }
    ])
  )

  assert.equal(response.stopReason, 'refusal')
  assert.equal(responseCode(response), 'COMMAND_INVALID_REQUEST')
  assert.equal(proc.executeCalls.length, 0)
  assert.equal(proc.prompts.length, 0)
})

test('fixture-state preview fails busy closed instead of queuing or prompting', async () => {
  const { agent, session, proc } = createHarness({ enabled: true })
  const running = session.prompt('ordinary prompt')
  const response = await agent.prompt(prompt([{ type: 'text', text: '/fixture-state' }]))

  assert.equal(response.stopReason, 'refusal')
  assert.equal(responseCode(response), 'COMMAND_BUSY')
  assert.equal(proc.executeCalls.length, 0)
  assert.deepEqual(
    proc.prompts.map(entry => entry.message),
    ['ordinary prompt']
  )

  proc.emit({ type: 'agent_settled' })
  assert.equal(await running, 'end_turn')
})

test('fixture-state pre-write cancel claims the reserved request without stopping or writing', async () => {
  const proc = new GatedCatalogPreviewPiProcess()
  const { agent } = createHarness({ enabled: true, proc })
  let responseSettled = false
  const responsePromise = agent.prompt(prompt([{ type: 'text', text: '/fixture-state reserved' }])).then(response => {
    responseSettled = true
    return response
  })

  await proc.catalogStarted
  await agent.cancel({ sessionId: SESSION_ID })
  assert.equal(responseSettled, false)
  assert.equal(proc.executeCalls.length, 0)
  assert.equal(proc.stopCount, 0)
  assert.equal(proc.abortCount, 0)
  assert.equal(proc.isAlive(), true)

  proc.releaseCatalog()
  const response = await responsePromise
  assert.equal(response.stopReason, 'cancelled')
  assert.equal(proc.executeCalls.length, 0)
  assert.equal(proc.stopCount, 0)
  assert.equal(proc.prompts.length, 0)
})

test('fixture-state pre-write cancellation remains causal when catalog discovery later fails', async () => {
  const proc = new GatedCatalogPreviewPiProcess()
  proc.catalogFailure = new Error('PRIVATE token=cancel-secret path=/private/cancel/catalog.json')
  const { agent } = createHarness({ enabled: true, proc })
  const responsePromise = agent.prompt(prompt([{ type: 'text', text: '/fixture-state reserved' }]))

  await proc.catalogStarted
  await agent.cancel({ sessionId: SESSION_ID })
  proc.releaseCatalog()

  const response = await responsePromise
  assert.equal(response.stopReason, 'cancelled')
  assert.equal(JSON.stringify(response).includes('cancel-secret'), false)
  assert.equal(JSON.stringify(response).includes('/private/cancel/catalog.json'), false)
  assert.equal(proc.executeCalls.length, 0)
  assert.equal(proc.stopCount, 0)
  assert.equal(proc.prompts.length, 0)
})

test('fixture-state reservation blocks a mutating adapter RPC before its Pi write but not read-only RPCs', async () => {
  const proc = new GatedCatalogPreviewPiProcess()
  const { agent } = createHarness({ enabled: true, proc })
  const fixture = agent.prompt(prompt([{ type: 'text', text: '/fixture-state reserved' }]))

  await proc.catalogStarted
  await assert.rejects(
    agent.prompt(prompt([{ type: 'text', text: '/compact must-not-write' }])),
    (error: unknown) =>
      error instanceof RequestError && (error.data as { code?: unknown } | undefined)?.code === 'COMMAND_BUSY'
  )
  const rejectsBusy = async (operation: () => Promise<unknown>): Promise<void> => {
    await assert.rejects(
      operation(),
      (error: unknown) =>
        error instanceof RequestError && (error.data as { code?: unknown } | undefined)?.code === 'COMMAND_BUSY'
    )
  }
  await rejectsBusy(() => agent.unstable_setSessionModel({ sessionId: SESSION_ID, modelId: 'test/model' }))
  await rejectsBusy(() => agent.setSessionMode({ sessionId: SESSION_ID, modeId: 'high' } as any))
  await rejectsBusy(() =>
    agent.setSessionConfigOption({ sessionId: SESSION_ID, configId: 'model', value: 'test/model' } as any)
  )
  await rejectsBusy(() =>
    agent.setSessionConfigOption({ sessionId: SESSION_ID, configId: 'thought_level', value: 'high' } as any)
  )
  assert.equal(proc.compactCalls.length, 0)
  assert.equal(proc.setModelCalls.length, 0)
  assert.equal(proc.setThinkingLevelCalls.length, 0)
  assert.equal(proc.executeCalls.length, 0)

  const readOnly = await agent.prompt(prompt([{ type: 'text', text: '/session' }]))
  assert.equal(readOnly.stopReason, 'end_turn')
  assert.equal(proc.getSessionStatsCount, 1)
  assert.equal(proc.compactCalls.length, 0)
  assert.equal(proc.executeCalls.length, 0)

  proc.releaseCatalog()
  assert.equal((await fixture).stopReason, 'end_turn')
  assert.equal(proc.executeCalls.length, 1)
})

test('mutating adapter reservation blocks fixture-state before discovery or execute but not read-only RPCs', async () => {
  const proc = new GatedCompactPreviewPiProcess()
  const { agent } = createHarness({ enabled: true, proc })
  const compact = agent.prompt(prompt([{ type: 'text', text: '/compact gated' }]))

  await proc.compactStarted
  const fixture = await agent.prompt(prompt([{ type: 'text', text: '/fixture-state must-not-discover' }]))
  assert.equal(fixture.stopReason, 'refusal')
  assert.equal(responseCode(fixture), 'COMMAND_BUSY')
  assert.equal(proc.getCommandsCount, 0)
  assert.equal(proc.executeCalls.length, 0)

  const readOnly = await agent.prompt(prompt([{ type: 'text', text: '/session' }]))
  assert.equal(readOnly.stopReason, 'end_turn')
  assert.equal(proc.getSessionStatsCount, 1)
  assert.equal(proc.getCommandsCount, 0)
  assert.equal(proc.executeCalls.length, 0)

  proc.releaseCompact()
  assert.equal((await compact).stopReason, 'end_turn')
  assert.deepEqual(proc.compactCalls, [{ customInstructions: 'gated' }])
})

test('fixture-state preview reserves one active-command slot and rejects a concurrent request', async () => {
  const proc = new DeferredPreviewPiProcess()
  const { agent } = createHarness({ enabled: true, proc })
  const first = agent.prompt(prompt([{ type: 'text', text: '/fixture-state first' }]))
  while (proc.executeCalls.length === 0) await new Promise(resolve => setImmediate(resolve))

  const second = await agent.prompt(prompt([{ type: 'text', text: '/fixture-state second' }]))
  assert.equal(second.stopReason, 'refusal')
  assert.equal(responseCode(second), 'COMMAND_BUSY')
  assert.deepEqual(
    proc.executeCalls.map(call => call.args),
    ['first']
  )
  assert.equal(proc.prompts.length, 0)

  await agent.cancel({ sessionId: SESSION_ID })
  assert.equal((await first).stopReason, 'cancelled')
  assert.equal(proc.stopCount, 1)
})

test('fixture-state preview preserves args after one exact whitespace delimiter and flushes notify first', async () => {
  const conn = new GatedNotifyConnection()
  const proc = new PreviewPiProcess()
  proc.notifyBeforeResponse = true
  const { agent } = createHarness({ enabled: true, proc, conn })
  let settled = false
  const responsePromise = agent
    .prompt(prompt([{ type: 'text', text: '/fixture-state\t  alpha\nbeta' }]))
    .then(response => {
      settled = true
      return response
    })

  await conn.notifyDeliveryStarted
  assert.equal(settled, false)
  assert.deepEqual(
    proc.executeCalls.map(call => ({ name: call.name, args: call.args })),
    [{ name: 'fixture-state', args: '  alpha\nbeta' }]
  )
  assert.equal(proc.prompts.length, 0)

  conn.release()
  const response = await responsePromise
  assert.equal(response.stopReason, 'end_turn')
  assert.equal((response as any)._meta?.piAcp?.executeCommand?.disposition, 'handled')
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'fixture-notify', cancelled: true }])
  assert.equal(
    conn.updates.filter(
      update =>
        update.update.sessionUpdate === 'agent_message_chunk' &&
        (update.update._meta as any)?.piAcp?.notify?.level === 'info'
    ).length,
    1
  )
})

test('fixture-state notify acknowledgement failures remain auxiliary and fully handled', async () => {
  const proc = new RejectingAckPreviewPiProcess()
  proc.notifyBeforeResponse = true
  const { agent } = createHarness({ enabled: true, proc })
  const unhandled: unknown[] = []
  const onUnhandled = (error: unknown): void => {
    unhandled.push(error)
  }
  process.on('unhandledRejection', onUnhandled)
  try {
    const response = await agent.prompt(prompt([{ type: 'text', text: '/fixture-state' }]))
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(response.stopReason, 'end_turn')
    assert.equal(proc.ackAttempts, 2)
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('fixture-state retries and awaits a startup catalog publication failure before its first execute write', async () => {
  const conn = new FailThenGateCatalogConnection()
  const proc = new PreviewPiProcess()
  let updatesAtExecute = -1
  proc.resultFactory = (requestId, name) => {
    updatesAtExecute = conn.updates.length
    return {
      success: true,
      data: { requestId, name, source: 'extension', sourceInfo: {}, disposition: 'handled' }
    }
  }
  const { agent, session } = createHarness({ enabled: true, proc, conn })
  ;(agent as any).scheduleCommandCatalogPublication(session, true)
  while (conn.catalogAttempts === 0) await new Promise(resolve => setImmediate(resolve))
  while (session.commandCatalogState.publication !== null) await new Promise(resolve => setImmediate(resolve))

  const catalog = session.commandCatalogState.snapshot
  assert.ok(catalog)
  assert.equal(conn.catalogAttempts, 1)
  assert.equal(session.commandCatalogState.publishedSnapshot, null)

  let responseSettled = false
  const responsePromise = agent
    .prompt(prompt([{ type: 'text', text: '/fixture-state publish-first' }]))
    .then(response => {
      responseSettled = true
      return response
    })
  await conn.retryStarted
  assert.equal(responseSettled, false)
  assert.equal(proc.executeCalls.length, 0)
  assert.equal(conn.updates.length, 0)

  conn.releaseRetry()
  const response = await responsePromise
  assert.equal(response.stopReason, 'end_turn')
  assert.equal(proc.executeCalls.length, 1)
  assert.equal(updatesAtExecute, 1)
  assert.equal(conn.catalogAttempts, 2)
  assert.equal(session.commandCatalogState.publishedSnapshot, catalog)
})

test('fixture-state structured Pi failure exposes only stable code and summary', async () => {
  const proc = new PreviewPiProcess()
  proc.resultFactory = (requestId, name) => ({
    success: false,
    error: 'PRIVATE path=/secret/fixture.ts token=do-not-surface',
    data: {
      requestId,
      name,
      disposition: 'rejected',
      code: 'COMMAND_HANDLER_FAILED'
    }
  })
  const { agent, conn } = createHarness({ enabled: true, proc })
  const response = await agent.prompt(prompt([{ type: 'text', text: '/fixture-state' }]))

  assert.equal(response.stopReason, 'refusal')
  assert.equal(responseCode(response), 'COMMAND_HANDLER_FAILED')
  assert.equal(JSON.stringify(response).includes('PRIVATE'), false)
  assert.equal(JSON.stringify(response).includes('/secret/fixture.ts'), false)
  assert.equal(proc.prompts.length, 0)
  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]?.update.sessionUpdate, 'available_commands_update')
})

test('fixture-state protocol failures propagate instead of being mislabeled as handler failures', async () => {
  const proc = new PreviewPiProcess()
  const protocolError = new PiRpcExecuteCommandProtocolError()
  proc.resultFactory = () => {
    throw protocolError
  }
  const { agent } = createHarness({ enabled: true, proc })

  await assert.rejects(
    agent.prompt(prompt([{ type: 'text', text: '/fixture-state' }])),
    error => error === protocolError
  )
  assert.equal(proc.executeCalls.length, 1)
  assert.equal(proc.prompts.length, 0)
})

test('fixture-state child termination propagates the causal recovery error', async () => {
  const proc = new PreviewPiProcess()
  const terminal = new PiRpcProcessTerminatedError('The Pi child exited.', undefined, {
    kind: 'exit',
    code: 9
  })
  proc.resultFactory = () => {
    throw terminal
  }
  const { agent } = createHarness({ enabled: true, proc })

  await assert.rejects(
    agent.prompt(prompt([{ type: 'text', text: '/fixture-state' }])),
    (error: any) => error?.data?.code === 'PI_RPC_PROCESS_TERMINATED'
  )
  assert.equal(proc.executeCalls.length, 1)
  assert.equal(proc.prompts.length, 0)
})

test('fixture-state catalog discovery replaces raw child details with one stable request error', async () => {
  const proc = new PreviewPiProcess()
  proc.getCommands = async () => {
    proc.getCommandsCount += 1
    throw new Error('PRIVATE token=catalog-secret path=/private/catalog/extensions.json')
  }
  const { agent, session } = createHarness({ enabled: true, proc })
  const publicError: unknown = await agent.prompt(prompt([{ type: 'text', text: '/fixture-state' }])).then(
    () => assert.fail('catalog discovery unexpectedly succeeded'),
    error => error
  )

  assert.ok(publicError instanceof RequestError)
  assert.equal(publicError.code, -32603)
  assert.equal(publicError.message, 'Internal error: Pi command catalog discovery failed; /fixture-state was not sent.')
  assert.deepEqual(publicError.data, { code: 'PI_COMMAND_CATALOG_DISCOVERY_FAILED' })
  const wireFacing = JSON.stringify({ code: publicError.code, message: publicError.message, data: publicError.data })
  assert.equal(wireFacing.includes('catalog-secret'), false)
  assert.equal(wireFacing.includes('/private/catalog/extensions.json'), false)
  assert.equal(session.commandCatalogState.snapshot, null)
  assert.equal(session.commandCatalogState.discovery, null)
  assert.equal(proc.getCommandsCount, 1)
  assert.equal(proc.executeCalls.length, 0)
  assert.equal(proc.prompts.length, 0)
})

test('fixture-state catalog discovery terminal propagates instead of freezing a not-found snapshot', async () => {
  const proc = new PreviewPiProcess()
  proc.getCommands = async () => {
    proc.getCommandsCount += 1
    const terminal = new PiRpcProcessTerminatedError('The Pi child exited during catalog discovery.', undefined, {
      kind: 'exit',
      code: 10
    })
    proc.terminate(terminal)
    throw terminal
  }
  const { agent, session } = createHarness({ enabled: true, proc })

  const terminalError: unknown = await agent.prompt(prompt([{ type: 'text', text: '/fixture-state' }])).then(
    () => assert.fail('terminal catalog discovery unexpectedly succeeded'),
    error => error
  )
  assert.ok(terminalError instanceof RequestError)
  assert.equal((terminalError.data as { code?: unknown } | undefined)?.code, 'PI_RPC_PROCESS_TERMINATED')
  assert.equal(terminalError.message, 'The Pi child exited during catalog discovery.')
  assert.equal(session.commandCatalogState.snapshot, null)
  assert.equal(session.commandCatalogState.discovery, null)
  assert.equal(proc.getCommandsCount, 1)
  assert.equal(proc.executeCalls.length, 0)
  assert.equal(proc.prompts.length, 0)
})

test('fixture-state catalog success followed by terminal before admission propagates termination, not busy', async () => {
  const proc = new PreviewPiProcess()
  proc.getCommands = async () => {
    proc.getCommandsCount += 1
    queueMicrotask(() => {
      proc.terminate(
        new PiRpcProcessTerminatedError('The Pi child exited after catalog discovery.', undefined, {
          kind: 'exit',
          code: 13
        })
      )
    })
    return COMMAND_CATALOG
  }
  const { agent, session } = createHarness({ enabled: true, proc })

  await assert.rejects(
    agent.prompt(prompt([{ type: 'text', text: '/fixture-state' }])),
    (error: any) => error?.data?.code === 'PI_RPC_PROCESS_TERMINATED'
  )
  assert.ok(session.commandCatalogState.snapshot)
  assert.equal(proc.getCommandsCount, 1)
  assert.equal(proc.executeCalls.length, 0)
  assert.equal(proc.prompts.length, 0)
})

test('fixture-state terminal waits only the fixed cut when a prior notify sink never settles', async () => {
  const conn = new GatedNotifyConnection()
  const proc = new PreviewPiProcess()
  proc.notifyBeforeResponse = true
  proc.resultFactory = () => {
    const terminal = new PiRpcProcessTerminatedError('The Pi child exited after notifying.', undefined, {
      kind: 'exit',
      code: 11
    })
    proc.terminate(terminal)
    throw terminal
  }
  const { agent } = createHarness({ enabled: true, proc, conn })
  const responsePromise = agent.prompt(prompt([{ type: 'text', text: '/fixture-state' }]))
  await conn.notifyDeliveryStarted

  let deadline: NodeJS.Timeout | undefined
  const boundedResponse = Promise.race([
    responsePromise,
    new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(
        () => reject(new Error('fixture-state terminal exceeded its fixed update cut')),
        TERMINAL_UPDATE_FLUSH_TIMEOUT_MS + 750
      )
    })
  ]).finally(() => {
    if (deadline) clearTimeout(deadline)
  })

  await assert.rejects(boundedResponse, (error: any) => error?.data?.code === 'PI_RPC_PROCESS_TERMINATED')
  assert.equal(proc.executeCalls.length, 1)
  assert.equal(proc.prompts.length, 0)
})

test('fixture-state response-first completion also uses the fixed cut if terminal overtakes notify flush', async () => {
  const conn = new GatedNotifyConnection()
  const proc = new PreviewPiProcess()
  proc.notifyBeforeResponse = true
  const execute = proc.executeCommand.bind(proc)
  proc.executeCommand = async (requestId, name, args) => {
    const response = await execute(requestId, name, args)
    setImmediate(() => {
      proc.terminate(
        new PiRpcProcessTerminatedError('The Pi child exited after its command response.', undefined, {
          kind: 'exit',
          code: 12
        })
      )
    })
    return response
  }
  const { agent } = createHarness({ enabled: true, proc, conn })
  const responsePromise = agent.prompt(prompt([{ type: 'text', text: '/fixture-state' }]))
  await conn.notifyDeliveryStarted

  let deadline: NodeJS.Timeout | undefined
  const boundedResponse = Promise.race([
    responsePromise,
    new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(
        () => reject(new Error('fixture-state response-first completion exceeded its fixed update cut')),
        TERMINAL_UPDATE_FLUSH_TIMEOUT_MS + 750
      )
    })
  ]).finally(() => {
    if (deadline) clearTimeout(deadline)
  })

  const response = await boundedResponse
  assert.equal(response.stopReason, 'end_turn')
  assert.equal((response as any)._meta?.piAcp?.executeCommand?.disposition, 'handled')
  assert.equal(proc.executeCalls.length, 1)
  assert.equal(proc.prompts.length, 0)

  await assert.rejects(
    agent.prompt(prompt([{ type: 'text', text: '/fixture-state after-terminal' }])),
    (error: any) => error?.data?.code === 'PI_RPC_PROCESS_TERMINATED'
  )
  assert.equal(proc.executeCalls.length, 1)
})

test('fixture-state cancellation after write stops the exact child once and never aborts or replays', async () => {
  const proc = new DeferredPreviewPiProcess()
  let releaseCleanup!: () => void
  proc.cleanupBarrier = new Promise<void>(resolve => {
    releaseCleanup = resolve
  })
  const { agent } = createHarness({ enabled: true, proc })
  let responseSettled = false
  const responsePromise = agent.prompt(prompt([{ type: 'text', text: '/fixture-state bytes' }])).then(response => {
    responseSettled = true
    return response
  })

  while (proc.executeCalls.length === 0) await new Promise(resolve => setImmediate(resolve))
  const cancelPromise = agent.cancel({ sessionId: SESSION_ID })
  while (proc.stopCount === 0) await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(responseSettled, false)
  releaseCleanup()
  await cancelPromise
  const response = await responsePromise

  assert.equal(response.stopReason, 'cancelled')
  assert.equal(proc.executeCalls.length, 1)
  assert.equal(proc.stopCount, 1)
  assert.equal(proc.abortCount, 0)
  assert.equal(proc.prompts.length, 0)
  assert.equal(proc.isAlive(), false)
})

test('fixture-state cleanup failure is one safe shared error and leaves the dead generation unreplayable', async () => {
  const proc = new DeferredPreviewPiProcess()
  proc.cleanupFailure = new PiRpcProcessCleanupError()
  const { agent } = createHarness({ enabled: true, proc })
  const promptFailure = agent.prompt(prompt([{ type: 'text', text: '/fixture-state cleanup-fails' }])).then(
    () => assert.fail('fixture-state unexpectedly returned after cleanup failure'),
    error => error as unknown
  )

  while (proc.executeCalls.length === 0) await new Promise(resolve => setImmediate(resolve))
  const cancelFailure = agent.cancel({ sessionId: SESSION_ID }).then(
    () => assert.fail('cancel unexpectedly succeeded without cleanup proof'),
    error => error as unknown
  )
  const [cancelReason, promptReason] = await Promise.all([cancelFailure, promptFailure])

  assert.equal(cancelReason, promptReason)
  assert.ok(cancelReason instanceof RequestError)
  assert.equal(cancelReason.code, -32603)
  assert.equal(
    cancelReason.message,
    'Internal error: The active command could not be cancelled with confirmed Pi cleanup; it was not replayed.'
  )
  assert.deepEqual(cancelReason.data, { code: 'PI_RPC_PROCESS_CLEANUP_UNCONFIRMED' })
  const wireFacing = JSON.stringify({
    code: cancelReason.code,
    message: cancelReason.message,
    data: cancelReason.data
  })
  assert.equal(wireFacing.includes('bounded graceful, TERM, and KILL attempts'), false)
  assert.equal(proc.executeCalls.length, 1)
  assert.equal(proc.stopCount, 1)
  assert.equal(proc.abortCount, 0)
  assert.equal(proc.prompts.length, 0)
  assert.equal(proc.isAlive(), false)

  const laterFailure: unknown = await agent
    .prompt(prompt([{ type: 'text', text: '/fixture-state after-cleanup-failure' }]))
    .then(
      () => assert.fail('the dead generation unexpectedly admitted a fresh command'),
      error => error
    )
  assert.ok(laterFailure instanceof RequestError)
  assert.equal((laterFailure.data as { code?: unknown } | undefined)?.code, 'PI_RPC_PROCESS_TERMINATED')
  assert.equal(proc.executeCalls.length, 1)
})

test('transparent replacement reuses the frozen logical catalog but rechecks physical capability', async () => {
  const conn = new FakeAgentSideConnection()
  const firstProc = new PreviewPiProcess()
  const first = new PiAcpSession({
    sessionId: SESSION_ID,
    initialState: { rpcCapabilities: { executeCommand: 1 } },
    cwd: CWD,
    mcpServers: [],
    proc: firstProc as any,
    conn: asAgentConn(conn)
  })
  const firstCatalog = await first.discoverCommandCatalogOnce({ enableFixtureStateCommand: true })

  const replacementProc = new PreviewPiProcess()
  const replacement = new PiAcpSession({
    sessionId: SESSION_ID,
    initialState: { rpcCapabilities: { executeCommand: 0 } },
    cwd: CWD,
    mcpServers: [],
    proc: replacementProc as any,
    conn: asAgentConn(conn),
    commandCatalogState: first.commandCatalogState
  })
  const replacementCatalog = await replacement.discoverCommandCatalogOnce({ enableFixtureStateCommand: true })

  assert.equal(firstCatalog, replacementCatalog)
  assert.equal(firstProc.getCommandsCount, 1)
  assert.equal(replacementProc.getCommandsCount, 0)
  assert.equal(first.supportsExecuteCommand(), true)
  assert.equal(replacement.supportsExecuteCommand(), false)
})

test('capability-zero exposure remains frozen and unexecutable after a capability-one replacement', async () => {
  const firstProc = new PreviewPiProcess()
  const { agent, session: first, conn } = createHarness({ enabled: true, capability: false, proc: firstProc })
  const frozen = await first.discoverCommandCatalogOnce({
    enableFixtureStateCommand: false
  })
  await (agent as any).publishCommandCatalog(first, frozen)
  assert.equal(
    frozen.commands.some(command => command.name === FIXTURE_STATE_COMMAND_NAME),
    false
  )

  const replacementProc = new PreviewPiProcess()
  const replacement = new PiAcpSession({
    sessionId: SESSION_ID,
    initialState: { rpcCapabilities: { executeCommand: 1 } },
    cwd: CWD,
    mcpServers: [],
    proc: replacementProc as any,
    conn: asAgentConn(conn),
    commandCatalogState: first.commandCatalogState
  })
  ;(agent as any).restoreSession = async () => replacement
  ;(agent as any).sessions = {
    maybeGet: (sessionId: string) => (sessionId === SESSION_ID ? replacement : undefined)
  }

  const updatesBefore = conn.updates.length
  const response = await agent.prompt(prompt([{ type: 'text', text: '/fixture-state' }]))
  assert.equal(response.stopReason, 'refusal')
  assert.equal(responseCode(response), 'COMMAND_NOT_FOUND')
  assert.equal(replacementProc.getCommandsCount, 0)
  assert.equal(replacementProc.executeCalls.length, 0)
  assert.equal(conn.updates.length, updatesBefore)
  assert.equal(replacement.commandCatalogState.snapshot, frozen)
  assert.equal(replacement.commandCatalogState.publishedSnapshot, frozen)
})
