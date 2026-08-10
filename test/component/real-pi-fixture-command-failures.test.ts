import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import test from 'node:test'
import { PI_RPC_PROCESS_TERMINATED_CODE } from '../../src/pi-rpc/process.js'
import { AcpOperationTimeoutError } from '../helpers/acp-process-client.js'
import {
  C3_6_FIXTURE_OK_NOTIFICATION,
  C3_6_PRIVATE_THROW_CANARY,
  REAL_PI_FIXTURE_COMMAND_ID,
  startRealPiFixture,
  type RealPiC3_6Receipt,
  type RealPiC3_6Schedule
} from '../helpers/real-pi-fixture.js'

const TEST_TIMEOUT_MS = 45_000
const PROMPT_TIMEOUT_MS = 15_000
const RECEIPT_TIMEOUT_MS = 10_000
const CLIENT_OPERATION_TIMEOUT_MS = 5_000
const patchedPiPackageRoot = process.env.PI_ACP_PATCHED_PI_PACKAGE_ROOT
const requestedSchedule = process.env.PI_ACP_C3_6_STRESS_SCHEDULE
const missingPatchedPiSkip = patchedPiPackageRoot
  ? false
  : 'PI_ACP_PATCHED_PI_PACKAGE_ROOT is required for the dedicated C3.6 real-Pi matrix'

const ALL_SCHEDULES = [
  'throw',
  'cancel',
  'timeout',
  'exit-before-response',
  'response-before-exit'
] as const satisfies readonly RealPiC3_6Schedule[]

if (requestedSchedule !== undefined && !ALL_SCHEDULES.some(schedule => schedule === requestedSchedule)) {
  throw new Error(
    'PI_ACP_C3_6_STRESS_SCHEDULE must be throw, cancel, timeout, exit-before-response, or response-before-exit'
  )
}

const schedules: readonly RealPiC3_6Schedule[] = requestedSchedule
  ? [requestedSchedule as RealPiC3_6Schedule]
  : ALL_SCHEDULES

type Fixture = Awaited<ReturnType<typeof startRealPiFixture>>
type Transcript = ReturnType<Fixture['client']['transcript']>
type StartedFixture = {
  fixture: Fixture
  adapterPid: number
  sessionId: string
  sessionFile: string
  initialPid: number
  header: string
}

function record(value: unknown): Record<string, any> {
  return typeof value === 'object' && value !== null ? (value as Record<string, any>) : {}
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`process ${String(pid)} did not exit within ${String(timeoutMs)}ms`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function waitForReceipts(
  fixture: Fixture,
  phase: RealPiC3_6Receipt['phase'],
  count: number
): Promise<RealPiC3_6Receipt[]> {
  const deadline = Date.now() + RECEIPT_TIMEOUT_MS
  for (;;) {
    const receipts = (await fixture.readC3_6Receipts(phase)).map(item => item.receipt)
    if (receipts.length >= count) return receipts
    if (Date.now() >= deadline) {
      throw new Error(`expected ${String(count)} C3.6 ${phase} receipts, received ${String(receipts.length)}`)
    }
    await new Promise(resolve => setImmediate(resolve))
  }
}

function promptText(args: string): string {
  return `/${REAL_PI_FIXTURE_COMMAND_ID} ${args}`
}

function promptExchanges(transcript: Transcript, text: string, occurrence = 0) {
  const requestIndexes = transcript.flatMap((entry, index) => {
    if (entry.kind !== 'message' || entry.direction !== 'client_to_agent') return []
    const message = record(entry.message)
    const prompt = record(message.params).prompt
    return message.method === 'session/prompt' &&
      Array.isArray(prompt) &&
      prompt.length === 1 &&
      record(prompt[0]).type === 'text' &&
      record(prompt[0]).text === text
      ? [index]
      : []
  })
  const requestIndex = requestIndexes[occurrence] ?? -1
  assert.notEqual(requestIndex, -1)
  const request = transcript[requestIndex]
  if (!request || request.kind !== 'message') throw new Error('C3.6 prompt request was not retained')
  const requestId = record(request.message).id
  const responses = transcript.flatMap((entry, index) => {
    if (entry.kind !== 'message' || entry.direction !== 'agent_to_client' || index <= requestIndex) return []
    const message = record(entry.message)
    return message.id === requestId && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))
      ? [{ index, message }]
      : []
  })
  return { requestIndex, requestId, responses }
}

function availableCommandUpdates(transcript: Transcript) {
  return transcript.flatMap(entry => {
    if (entry.kind !== 'message' || entry.direction !== 'agent_to_client') return []
    const message = record(entry.message)
    if (message.method !== 'session/update') return []
    const update = record(record(message.params).update)
    return update.sessionUpdate === 'available_commands_update' ? [update] : []
  })
}

function fixtureNotifications(transcript: Transcript): string[] {
  return transcript.flatMap(entry => {
    if (entry.kind !== 'message' || entry.direction !== 'agent_to_client') return []
    const message = record(entry.message)
    if (message.method !== 'session/update') return []
    const update = record(record(message.params).update)
    const content = record(update.content)
    const notify = record(record(record(update._meta).piAcp).notify)
    return update.sessionUpdate === 'agent_message_chunk' &&
      content.type === 'text' &&
      notify.level === 'info' &&
      typeof content.text === 'string'
      ? [content.text]
      : []
  })
}

function assertFixtureCatalog(transcript: Transcript): void {
  const catalogs = availableCommandUpdates(transcript)
  assert.ok(catalogs.length >= 1)
  for (const catalog of catalogs) {
    assert.equal(Array.isArray(catalog.availableCommands), true)
    const fixtureCommands = (catalog.availableCommands as unknown[]).filter(command =>
      ['fixture-state', 'fixture-agent'].includes(String(record(command).name))
    )
    assert.deepEqual(
      fixtureCommands.map(command => record(command).name),
      [REAL_PI_FIXTURE_COMMAND_ID]
    )
  }
}

function assertPrivateSessionPath(fixture: Fixture, sessionFile: string): void {
  assert.equal(isAbsolute(sessionFile), true)
  const relativePath = relative(fixture.sessionDir, sessionFile)
  assert.ok(
    relativePath !== '' && relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
  )
}

function assertInvocation(
  receipt: RealPiC3_6Receipt,
  expected: {
    nonce: string
    pid: number
    sessionId: string
    sessionFile: string
    invocationCount: number
    args: string
  }
): void {
  const bytes = Buffer.from(expected.args, 'utf8')
  assert.deepEqual(receipt, {
    schemaVersion: 1,
    checkpoint: 'C3.6',
    phase: 'command_invocation',
    sequence: receipt.sequence,
    nonce: expected.nonce,
    piVersion: '0.83.0',
    piPid: expected.pid,
    sessionId: expected.sessionId,
    sessionFile: expected.sessionFile,
    invocationCount: expected.invocationCount,
    name: REAL_PI_FIXTURE_COMMAND_ID,
    args: expected.args,
    argsUtf8ByteLength: bytes.length,
    argsSha256: createHash('sha256').update(bytes).digest('hex'),
    argsBase64: bytes.toString('base64')
  })
}

function assertNoProviderOrPrivateCanary(fixture: Fixture): void {
  assert.deepEqual(fixture.requests, [])
  const transcript = fixture.client.transcriptNdjson()
  assert.equal(transcript.includes(C3_6_PRIVATE_THROW_CANARY), false)
  assert.equal(transcript.includes('extension_error'), false)
}

async function assertNoCommandPersistence(started: StartedFixture): Promise<void> {
  const source = await readFile(started.sessionFile, 'utf8')
  assert.equal(source.startsWith(started.header), true)
  for (const args of [
    'c3.6-ok',
    'c3.6-throw',
    'c3.6-block',
    'c3.6-exit-before-response',
    'c3.6-response-before-exit'
  ]) {
    assert.equal(source.includes(args), false)
  }
  assert.equal(source.includes('/fixture-state'), false)
  const entries = source
    .trimEnd()
    .split('\n')
    .map(line => record(JSON.parse(line)))
  assert.equal(
    entries.some(entry => entry.type === 'message'),
    false
  )
}

async function startPatchedFixture(t: test.TestContext): Promise<StartedFixture> {
  assert.ok(patchedPiPackageRoot)
  const fixture = await startRealPiFixture({
    fixtureMode: 'c3.6-failure-lifecycle',
    patchedPiPackageRoot,
    hardDeadlineMs: 35_000,
    clientShutdownTimeoutMs: 5_000,
    transcriptCheckpoint: 'C3.6'
  })
  t.after(fixture.cleanup)
  const adapterPid = fixture.client.processId
  assert.ok(adapterPid)
  await fixture.client.initialize()
  const session = await fixture.client.newSession({ cwd: fixture.cwd, mcpServers: [] })
  await fixture.client.waitForSessionUpdate(
    notification => notification.update.sessionUpdate === 'available_commands_update',
    { timeoutMs: RECEIPT_TIMEOUT_MS }
  )
  assertFixtureCatalog(fixture.client.transcript())
  assert.equal(fixture.piPackageRoot, await realpath(patchedPiPackageRoot))

  const starts = await waitForReceipts(fixture, 'session_start', 1)
  assert.equal(starts.length, 1)
  const initial = starts[0]!
  assert.equal(initial.schemaVersion, 1)
  assert.equal(initial.checkpoint, 'C3.6')
  assert.equal(initial.phase, 'session_start')
  assert.equal(initial.sequence, 1)
  assert.equal(initial.nonce, fixture.nonce)
  assert.equal(initial.piVersion, '0.83.0')
  assert.equal(initial.sessionId, session.sessionId)
  assert.equal(typeof initial.sessionFile, 'string')
  assertPrivateSessionPath(fixture, initial.sessionFile!)
  assert.equal(isProcessAlive(initial.piPid), true)

  const header = `${JSON.stringify({
    type: 'session',
    version: 3,
    id: session.sessionId,
    timestamp: '2026-08-02T00:00:00.000Z',
    cwd: fixture.cwd
  })}\n`
  await writeFile(initial.sessionFile!, header, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  const stat = await lstat(initial.sessionFile!)
  assert.equal(stat.isFile(), true)
  assert.equal(stat.isSymbolicLink(), false)

  return {
    fixture,
    adapterPid,
    sessionId: session.sessionId,
    sessionFile: initial.sessionFile!,
    initialPid: initial.piPid,
    header
  }
}

async function promptFixture(started: StartedFixture, args: string, timeoutMs = PROMPT_TIMEOUT_MS) {
  return await started.fixture.client.prompt(
    {
      sessionId: started.sessionId,
      prompt: [{ type: 'text', text: promptText(args) }]
    },
    { timeoutMs }
  )
}

function assertHandled(response: unknown): void {
  const value = record(response)
  assert.equal(value.stopReason, 'end_turn')
  const piAcp = record(record(value._meta).piAcp)
  const execution = record(piAcp.executeCommand)
  assert.equal(typeof execution.requestId, 'string')
  assert.deepEqual(execution, {
    requestId: execution.requestId,
    name: REAL_PI_FIXTURE_COMMAND_ID,
    source: 'extension',
    disposition: 'handled'
  })
  assert.deepEqual(record(piAcp.routing), { promptForwardedToPi: false, sentToModel: false })
}

async function assertFreshRecovery(started: StartedFixture, invocationCount: number) {
  const response = await promptFixture(started, 'c3.6-ok')
  assertHandled(response)
  const starts = await waitForReceipts(started.fixture, 'session_start', 2)
  const replacement = starts.find(receipt => receipt.piPid !== started.initialPid)
  assert.ok(replacement)
  assert.notEqual(replacement.piPid, started.initialPid)
  assert.equal(replacement.sessionId, started.sessionId)
  assert.equal(replacement.sessionFile, started.sessionFile)
  assert.equal(isProcessAlive(replacement.piPid), true)
  const invocations = await waitForReceipts(started.fixture, 'command_invocation', invocationCount)
  const replacementInvocations = invocations.filter(receipt => receipt.piPid === replacement.piPid)
  assert.equal(replacementInvocations.length, 1)
  assertInvocation(replacementInvocations[0]!, {
    nonce: started.fixture.nonce,
    pid: replacement.piPid,
    sessionId: started.sessionId,
    sessionFile: started.sessionFile,
    invocationCount: 1,
    args: 'c3.6-ok'
  })
  return replacement.piPid
}

async function closeCleanly(started: StartedFixture, livePid: number): Promise<void> {
  const exit = await started.fixture.client.close()
  assert.deepEqual({ code: exit.code, signal: exit.signal }, { code: 0, signal: null })
  await waitForProcessExit(livePid)
  await waitForProcessExit(started.adapterPid)
  assert.equal(exit.stderrTail.includes(C3_6_PRIVATE_THROW_CANARY), false)
  await started.fixture.assertWithinHardDeadline()
}

async function assertShutdownPids(started: StartedFixture, expectedPids: readonly number[]): Promise<void> {
  const shutdowns = await waitForReceipts(started.fixture, 'session_shutdown', expectedPids.length)
  assert.equal(shutdowns.length, expectedPids.length)
  assert.deepEqual(
    shutdowns.map(receipt => receipt.piPid).sort((left, right) => left - right),
    [...expectedPids].sort((left, right) => left - right)
  )
  for (const receipt of shutdowns) {
    assert.equal(receipt.schemaVersion, 1)
    assert.equal(receipt.checkpoint, 'C3.6')
    assert.equal(receipt.phase, 'session_shutdown')
    assert.equal(receipt.nonce, started.fixture.nonce)
    assert.equal(receipt.piVersion, '0.83.0')
    assert.equal(receipt.sessionId, started.sessionId)
    assert.equal(receipt.sessionFile, started.sessionFile)
    assert.equal(receipt.reason, 'quit')
  }
  const names = await readdir(join(started.fixture.rootDir, 'artifacts'))
  assert.deepEqual(
    names.filter(name => name.endsWith('.tmp')),
    []
  )
}

async function runThrowSchedule(t: test.TestContext): Promise<void> {
  const started = await startPatchedFixture(t)
  const response = await promptFixture(started, 'c3.6-throw')
  assert.equal(response.stopReason, 'refusal')
  const piAcp = record(record(record(response)._meta).piAcp)
  const execution = record(piAcp.executeCommand)
  assert.equal(typeof execution.requestId, 'string')
  assert.deepEqual(execution, {
    requestId: execution.requestId,
    name: REAL_PI_FIXTURE_COMMAND_ID,
    disposition: 'rejected',
    code: 'COMMAND_HANDLER_FAILED'
  })
  assert.deepEqual(record(piAcp.routing), { promptForwardedToPi: false, sentToModel: false })
  assert.equal(record(piAcp.diagnostic).code, 'COMMAND_HANDLER_FAILED')

  const failed = await waitForReceipts(started.fixture, 'command_invocation', 1)
  assertInvocation(failed[0]!, {
    nonce: started.fixture.nonce,
    pid: started.initialPid,
    sessionId: started.sessionId,
    sessionFile: started.sessionFile,
    invocationCount: 1,
    args: 'c3.6-throw'
  })
  assert.equal(isProcessAlive(started.initialPid), true)

  const liveness = await promptFixture(started, 'c3.6-ok')
  assertHandled(liveness)
  const invocations = await waitForReceipts(started.fixture, 'command_invocation', 2)
  assertInvocation(invocations[1]!, {
    nonce: started.fixture.nonce,
    pid: started.initialPid,
    sessionId: started.sessionId,
    sessionFile: started.sessionFile,
    invocationCount: 2,
    args: 'c3.6-ok'
  })
  assert.equal((await started.fixture.readC3_6Receipts('session_start')).length, 1)
  assert.equal(isProcessAlive(started.initialPid), true)
  const throwExchange = promptExchanges(started.fixture.client.transcript(), promptText('c3.6-throw'))
  assert.equal(throwExchange.responses.length, 1)
  assert.deepEqual(record(throwExchange.responses[0]!.message).result, response)
  assert.equal(Object.hasOwn(throwExchange.responses[0]!.message, 'error'), false)
  const livenessExchange = promptExchanges(started.fixture.client.transcript(), promptText('c3.6-ok'))
  assert.equal(livenessExchange.responses.length, 1)
  assert.deepEqual(record(livenessExchange.responses[0]!.message).result, liveness)
  assert.deepEqual(fixtureNotifications(started.fixture.client.transcript()), [C3_6_FIXTURE_OK_NOTIFICATION])
  assertNoProviderOrPrivateCanary(started.fixture)
  await assertNoCommandPersistence(started)
  await closeCleanly(started, started.initialPid)
  await assertShutdownPids(started, [started.initialPid])
}

async function runCancelSchedule(t: test.TestContext): Promise<void> {
  const started = await startPatchedFixture(t)
  const blocked = promptFixture(started, 'c3.6-block')
  const invoked = await waitForReceipts(started.fixture, 'command_invocation', 1)
  assertInvocation(invoked[0]!, {
    nonce: started.fixture.nonce,
    pid: started.initialPid,
    sessionId: started.sessionId,
    sessionFile: started.sessionFile,
    invocationCount: 1,
    args: 'c3.6-block'
  })

  const busy = await promptFixture(started, 'c3.6-ok')
  assert.equal(busy.stopReason, 'refusal')
  assert.equal(record(record(record(record(busy)._meta).piAcp).executeCommand).code, 'COMMAND_BUSY')
  assert.equal((await started.fixture.readC3_6Receipts('command_invocation')).length, 1)

  await started.fixture.client.cancel({ sessionId: started.sessionId })
  const cancelled = await blocked
  assert.equal(cancelled.stopReason, 'cancelled')
  const execution = record(record(record(cancelled)._meta).piAcp).executeCommand
  assert.equal(typeof record(execution).requestId, 'string')
  assert.deepEqual(record(execution), {
    requestId: record(execution).requestId,
    name: REAL_PI_FIXTURE_COMMAND_ID,
    disposition: 'cancelled'
  })
  await waitForProcessExit(started.initialPid)
  assert.equal(isProcessAlive(started.adapterPid), true)

  const replacementPid = await assertFreshRecovery(started, 2)
  const invocations = await started.fixture.readC3_6Receipts('command_invocation')
  assert.equal(invocations.length, 2)
  const blockedExchange = promptExchanges(started.fixture.client.transcript(), promptText('c3.6-block'))
  assert.equal(blockedExchange.responses.length, 1)
  assert.deepEqual(record(blockedExchange.responses[0]!.message).result, cancelled)
  const busyExchange = promptExchanges(started.fixture.client.transcript(), promptText('c3.6-ok'), 0)
  assert.equal(busyExchange.responses.length, 1)
  assert.deepEqual(record(busyExchange.responses[0]!.message).result, busy)
  const recoveredExchange = promptExchanges(started.fixture.client.transcript(), promptText('c3.6-ok'), 1)
  assert.equal(recoveredExchange.responses.length, 1)
  assert.equal(record(record(recoveredExchange.responses[0]!.message).result).stopReason, 'end_turn')
  assert.deepEqual(fixtureNotifications(started.fixture.client.transcript()), [C3_6_FIXTURE_OK_NOTIFICATION])
  assertNoProviderOrPrivateCanary(started.fixture)
  await assertNoCommandPersistence(started)
  await closeCleanly(started, replacementPid)
  await assertShutdownPids(started, [started.initialPid, replacementPid])
}

async function runTimeoutSchedule(t: test.TestContext): Promise<void> {
  const started = await startPatchedFixture(t)
  const outcome = promptFixture(started, 'c3.6-block', CLIENT_OPERATION_TIMEOUT_MS).then(
    value => ({ status: 'resolved' as const, value }),
    error => ({ status: 'rejected' as const, error })
  )
  const invoked = await waitForReceipts(started.fixture, 'command_invocation', 1)
  assertInvocation(invoked[0]!, {
    nonce: started.fixture.nonce,
    pid: started.initialPid,
    sessionId: started.sessionId,
    sessionFile: started.sessionFile,
    invocationCount: 1,
    args: 'c3.6-block'
  })
  const exchangeBeforeTimeout = promptExchanges(started.fixture.client.transcript(), promptText('c3.6-block'))
  assert.deepEqual(exchangeBeforeTimeout.responses, [])

  const settled = await outcome
  assert.equal(settled.status, 'rejected')
  if (settled.status === 'rejected') {
    assert.ok(settled.error instanceof AcpOperationTimeoutError)
    assert.equal(settled.error.operation, 'session/prompt')
    assert.equal(settled.error.timeoutMs, CLIENT_OPERATION_TIMEOUT_MS)
    assert.equal(settled.error.teardownError, undefined)
  }
  const exit = await started.fixture.client.closed
  await waitForProcessExit(started.initialPid)
  await waitForProcessExit(started.adapterPid)
  assert.equal(started.fixture.client.isRunning, false)
  assert.equal(started.fixture.client.transcript().filter(entry => entry.kind === 'process_exit').length, 1)
  const exchangeAfterTimeout = promptExchanges(started.fixture.client.transcript(), promptText('c3.6-block'))
  assert.deepEqual(exchangeAfterTimeout.responses, [])
  assert.deepEqual(fixtureNotifications(started.fixture.client.transcript()), [])
  assert.equal((await started.fixture.readC3_6Receipts('command_invocation')).length, 1)
  assert.equal(exit.stderrTail.includes(C3_6_PRIVATE_THROW_CANARY), false)
  assertNoProviderOrPrivateCanary(started.fixture)
  await assertNoCommandPersistence(started)
  await started.fixture.closeLoopback()
  await assertShutdownPids(started, [started.initialPid])
  await started.fixture.assertWithinHardDeadline()
}

async function runExitBeforeResponseSchedule(t: test.TestContext): Promise<void> {
  const started = await startPatchedFixture(t)
  const error = await promptFixture(started, 'c3.6-exit-before-response').then(
    () => undefined,
    (caught: unknown) => caught
  )
  assert.ok(error instanceof Error)
  assert.equal((error as Error & { code?: unknown }).code, -32603)
  assert.equal(record((error as Error & { data?: unknown }).data).code, PI_RPC_PROCESS_TERMINATED_CODE)
  await waitForProcessExit(started.initialPid)
  assert.equal(isProcessAlive(started.adapterPid), true)

  const failed = await waitForReceipts(started.fixture, 'command_invocation', 1)
  assertInvocation(failed[0]!, {
    nonce: started.fixture.nonce,
    pid: started.initialPid,
    sessionId: started.sessionId,
    sessionFile: started.sessionFile,
    invocationCount: 1,
    args: 'c3.6-exit-before-response'
  })
  const failureExchange = promptExchanges(started.fixture.client.transcript(), promptText('c3.6-exit-before-response'))
  assert.equal(failureExchange.responses.length, 1)
  assert.equal(record(record(failureExchange.responses[0]!.message).error).code, -32603)

  const replacementPid = await assertFreshRecovery(started, 2)
  assert.equal((await started.fixture.readC3_6Receipts('command_invocation')).length, 2)
  assert.deepEqual(fixtureNotifications(started.fixture.client.transcript()), [C3_6_FIXTURE_OK_NOTIFICATION])
  assertNoProviderOrPrivateCanary(started.fixture)
  await assertNoCommandPersistence(started)
  await closeCleanly(started, replacementPid)
  await assertShutdownPids(started, [replacementPid])
}

async function runResponseBeforeExitSchedule(t: test.TestContext): Promise<void> {
  const started = await startPatchedFixture(t)
  const response = await promptFixture(started, 'c3.6-response-before-exit')
  assertHandled(response)
  const succeeded = await waitForReceipts(started.fixture, 'command_invocation', 1)
  assertInvocation(succeeded[0]!, {
    nonce: started.fixture.nonce,
    pid: started.initialPid,
    sessionId: started.sessionId,
    sessionFile: started.sessionFile,
    invocationCount: 1,
    args: 'c3.6-response-before-exit'
  })
  const exchange = promptExchanges(started.fixture.client.transcript(), promptText('c3.6-response-before-exit'))
  assert.equal(exchange.responses.length, 1)
  assert.deepEqual(record(exchange.responses[0]!.message).result, response)
  assert.equal(Object.hasOwn(exchange.responses[0]!.message, 'error'), false)
  await waitForProcessExit(started.initialPid)
  assert.equal(isProcessAlive(started.adapterPid), true)

  const replacementPid = await assertFreshRecovery(started, 2)
  assert.equal((await started.fixture.readC3_6Receipts('command_invocation')).length, 2)
  assert.deepEqual(fixtureNotifications(started.fixture.client.transcript()), [C3_6_FIXTURE_OK_NOTIFICATION])
  assertNoProviderOrPrivateCanary(started.fixture)
  await assertNoCommandPersistence(started)
  await closeCleanly(started, replacementPid)
  await assertShutdownPids(started, [started.initialPid, replacementPid])
}

const scheduleRunners: Record<RealPiC3_6Schedule, (t: test.TestContext) => Promise<void>> = {
  throw: runThrowSchedule,
  cancel: runCancelSchedule,
  timeout: runTimeoutSchedule,
  'exit-before-response': runExitBeforeResponseSchedule,
  'response-before-exit': runResponseBeforeExitSchedule
}

for (const schedule of schedules) {
  test(
    `C3.6 real Pi failure lifecycle: ${schedule}`,
    { timeout: TEST_TIMEOUT_MS, skip: missingPatchedPiSkip },
    scheduleRunners[schedule]
  )
}
