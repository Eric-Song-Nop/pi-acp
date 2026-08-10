import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import test from 'node:test'
import { FIXTURE_STATE_SAFE_COMMAND_METADATA } from '../../src/acp/pi-commands.js'
import {
  C3_4_FIXTURE_HANG_SENTINEL,
  REAL_PI_FIXTURE_COMMAND_ID,
  startRealPiFixture
} from '../helpers/real-pi-fixture.js'

const TEST_TIMEOUT_MS = 45_000
const PROMPT_TIMEOUT_MS = 15_000
const RECEIPT_TIMEOUT_MS = 10_000
const NORMAL_ARGS = '  alpha\nβ'
const NORMAL_PROMPT = `/fixture-state\t${NORMAL_ARGS}`
const HANG_PROMPT = `/fixture-state ${C3_4_FIXTURE_HANG_SENTINEL}`
const NOTIFY_TEXT = 'Pi ACP C3.4 fixture state'
const patchedPiPackageRoot = process.env.PI_ACP_PATCHED_PI_PACKAGE_ROOT
const missingPatchedPiSkip = patchedPiPackageRoot
  ? false
  : 'PI_ACP_PATCHED_PI_PACKAGE_ROOT is required for the dedicated C3.4 real-Pi matrix'

type Fixture = Awaited<ReturnType<typeof startRealPiFixture>>
type Transcript = ReturnType<Fixture['client']['transcript']>

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

async function assertPathMissing(path: string): Promise<void> {
  await assert.rejects(lstat(path), (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT')
    return true
  })
}

async function waitForCount<T>(read: () => Promise<T[]>, count: number, timeoutMs = RECEIPT_TIMEOUT_MS): Promise<T[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const values = await read()
    if (values.length >= count) return values
    if (Date.now() >= deadline) {
      throw new Error(
        `expected ${String(count)} C3.4 receipts within ${String(timeoutMs)}ms, received ${values.length}`
      )
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function availableCommandUpdates(transcript: Transcript) {
  return transcript.flatMap((entry, index) => {
    if (entry.kind !== 'message' || entry.direction !== 'agent_to_client') return []
    const message = record(entry.message)
    if (message.method !== 'session/update') return []
    const update = record(record(message.params).update)
    return update.sessionUpdate === 'available_commands_update' ? [{ index, update }] : []
  })
}

function notifyUpdates(transcript: Transcript) {
  return transcript.flatMap((entry, index) => {
    if (entry.kind !== 'message' || entry.direction !== 'agent_to_client') return []
    const message = record(entry.message)
    if (message.method !== 'session/update') return []
    const update = record(record(message.params).update)
    const content = record(update.content)
    const notify = record(record(update._meta).piAcp).notify
    return update.sessionUpdate === 'agent_message_chunk' && content.type === 'text' && record(notify).level === 'info'
      ? [{ index, text: content.text }]
      : []
  })
}

function promptExchange(transcript: Transcript, text: string) {
  const requestIndex = transcript.findIndex(entry => {
    if (entry.kind !== 'message' || entry.direction !== 'client_to_agent') return false
    const message = record(entry.message)
    const prompt = record(message.params).prompt
    return (
      message.method === 'session/prompt' &&
      Array.isArray(prompt) &&
      prompt.length === 1 &&
      record(prompt[0]).type === 'text' &&
      record(prompt[0]).text === text
    )
  })
  assert.notEqual(requestIndex, -1)
  const requestEntry = transcript[requestIndex]
  if (!requestEntry || requestEntry.kind !== 'message') throw new Error('prompt request was not retained')
  const requestId = record(requestEntry.message).id
  const responses = transcript.flatMap((entry, index) => {
    if (index <= requestIndex || entry.kind !== 'message' || entry.direction !== 'agent_to_client') return []
    const message = record(entry.message)
    return message.id === requestId && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))
      ? [{ index, message }]
      : []
  })
  assert.equal(responses.length, 1)
  return { requestIndex, response: responses[0]! }
}

function assertFixtureCatalog(transcript: Transcript): void {
  const catalogs = availableCommandUpdates(transcript)
  assert.equal(catalogs.length, 1)
  const commands = catalogs[0]!.update.availableCommands
  assert.equal(Array.isArray(commands), true)
  const fixtures = (commands as unknown[]).filter(command => record(command).name === REAL_PI_FIXTURE_COMMAND_ID)
  assert.deepEqual(fixtures, [
    {
      name: REAL_PI_FIXTURE_COMMAND_ID,
      description: 'Report that the deterministic Pi ACP fixture is loaded',
      _meta: { piAcp: { command: FIXTURE_STATE_SAFE_COMMAND_METADATA } }
    }
  ])
}

function assertPrivateSessionPath(fixture: Fixture, sessionFile: string): void {
  assert.equal(isAbsolute(sessionFile), true)
  const relativePath = relative(fixture.sessionDir, sessionFile)
  assert.ok(
    relativePath !== '' && relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
  )
}

async function startPatchedFixture(t: test.TestContext): Promise<Fixture> {
  assert.ok(patchedPiPackageRoot)
  const fixture = await startRealPiFixture({
    fixtureMode: 'c3.4-execute-command',
    patchedPiPackageRoot,
    hardDeadlineMs: 35_000,
    transcriptCheckpoint: 'C3.4'
  })
  t.after(fixture.cleanup)
  await fixture.client.initialize()
  return fixture
}

test(
  'C3.4 patched Pi completes exact state-only /fixture-state with notify-before-response and no model turn',
  { timeout: TEST_TIMEOUT_MS, skip: missingPatchedPiSkip },
  async t => {
    const fixture = await startPatchedFixture(t)
    const adapterPid = fixture.client.processId
    assert.ok(adapterPid)
    const session = await fixture.client.newSession({ cwd: fixture.cwd, mcpServers: [] })
    await fixture.client.waitForSessionUpdate(
      notification => notification.update.sessionUpdate === 'available_commands_update',
      { timeoutMs: RECEIPT_TIMEOUT_MS }
    )
    assertFixtureCatalog(fixture.client.transcript())

    const starts = await waitForCount(fixture.readC3_4SessionStartReceipts, 1)
    assert.equal(starts.length, 1)
    const started = starts[0]!.receipt
    assert.equal(started.schemaVersion, 1)
    assert.equal(started.checkpoint, 'C3.4')
    assert.equal(started.phase, 'session_start')
    assert.equal(started.nonce, fixture.nonce)
    assert.equal(started.piVersion, '0.83.0')
    assert.equal(started.sessionId, session.sessionId)
    assert.equal(typeof started.sessionFile, 'string')
    assertPrivateSessionPath(fixture, started.sessionFile!)
    assert.equal(isProcessAlive(started.piPid), true)
    assert.ok(patchedPiPackageRoot)
    assert.equal(fixture.piPackageRoot, await realpath(patchedPiPackageRoot))
    const wrapperSource = await readFile(fixture.piCommandPath, 'utf8')
    assert.equal(wrapperSource.includes(fixture.expectedNodeRealpath), true)
    assert.equal(wrapperSource.includes(fixture.expectedCliRealpath), true)
    assert.equal(wrapperSource.includes('$PI_ACP_FIXTURE_NODE'), false)
    assert.equal(wrapperSource.includes('$PI_PACKAGE_DIR'), false)
    const wrapperStat = await lstat(fixture.piCommandPath)
    assert.equal(wrapperStat.isFile(), true)
    assert.equal(wrapperStat.isSymbolicLink(), false)
    if (process.platform !== 'win32') assert.equal(wrapperStat.mode & 0o777, 0o700)
    await assertPathMissing(started.sessionFile!)

    const response = await fixture.client.prompt(
      {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: NORMAL_PROMPT }]
      },
      { timeoutMs: PROMPT_TIMEOUT_MS }
    )
    assert.equal(response.stopReason, 'end_turn')
    const execution = record(record(record(response)._meta).piAcp).executeCommand
    assert.equal(typeof record(execution).requestId, 'string')
    assert.deepEqual(record(execution), {
      requestId: record(execution).requestId,
      name: REAL_PI_FIXTURE_COMMAND_ID,
      source: 'extension',
      disposition: 'handled'
    })
    assert.deepEqual(record(record(record(response)._meta).piAcp).routing, {
      promptForwardedToPi: false,
      sentToModel: false
    })

    const invocations = await waitForCount(fixture.readC3_4InvocationReceipts, 1)
    assert.equal(invocations.length, 1)
    const invocation = invocations[0]!.receipt
    const argsBytes = Buffer.from(NORMAL_ARGS, 'utf8')
    assert.equal(argsBytes.length, 10)
    assert.equal(argsBytes.toString('base64'), 'ICBhbHBoYQrOsg==')
    assert.equal(
      createHash('sha256').update(argsBytes).digest('hex'),
      '36ff42db42a8f19c0837bd792ce97819c0f2cc4a1e0f0808d02d4cecb5b8776c'
    )
    assert.deepEqual(invocation, {
      schemaVersion: 1,
      checkpoint: 'C3.4',
      phase: 'command_invocation',
      nonce: fixture.nonce,
      piVersion: '0.83.0',
      piPid: started.piPid,
      sessionId: session.sessionId,
      sessionFile: started.sessionFile,
      invocationCount: 1,
      name: REAL_PI_FIXTURE_COMMAND_ID,
      args: NORMAL_ARGS,
      argsUtf8ByteLength: 10,
      argsSha256: '36ff42db42a8f19c0837bd792ce97819c0f2cc4a1e0f0808d02d4cecb5b8776c',
      argsBase64: 'ICBhbHBoYQrOsg=='
    })

    const transcript = fixture.client.transcript()
    const exchange = promptExchange(transcript, NORMAL_PROMPT)
    const notifications = notifyUpdates(transcript)
    assert.deepEqual(
      notifications.map(notification => notification.text),
      [NOTIFY_TEXT]
    )
    assert.ok(notifications[0]!.index > exchange.requestIndex)
    assert.ok(notifications[0]!.index < exchange.response.index)
    assert.deepEqual(record(exchange.response.message).result, response)
    assertFixtureCatalog(transcript)
    assert.deepEqual(fixture.requests, [])
    await assertPathMissing(started.sessionFile!)

    const sessionResponse = await fixture.client.prompt(
      {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: '/session' }]
      },
      { timeoutMs: PROMPT_TIMEOUT_MS }
    )
    assert.deepEqual(sessionResponse, { stopReason: 'end_turn' })
    assert.equal((await fixture.readC3_4SessionStartReceipts()).length, 1)
    assert.equal((await fixture.readC3_4InvocationReceipts()).length, 1)
    assert.equal(isProcessAlive(started.piPid), true)
    assertFixtureCatalog(fixture.client.transcript())
    assert.deepEqual(fixture.requests, [])
    await assertPathMissing(started.sessionFile!)

    const exit = await fixture.client.close()
    assert.deepEqual({ code: exit.code, signal: exit.signal }, { code: 0, signal: null })
    await waitForProcessExit(started.piPid)
    await waitForProcessExit(adapterPid)
    const shutdowns = await waitForCount(fixture.readC3_4ShutdownReceipts, 1)
    assert.deepEqual(
      shutdowns.map(item => item.receipt.piPid),
      [started.piPid]
    )
    assert.deepEqual(fixture.requests, [])
    await fixture.assertWithinHardDeadline()
  }
)

test(
  'C3.4 post-write cancel stops the exact patched child and fresh recovery never replays the command',
  { timeout: TEST_TIMEOUT_MS, skip: missingPatchedPiSkip },
  async t => {
    const fixture = await startPatchedFixture(t)
    const adapterPid = fixture.client.processId
    assert.ok(adapterPid)
    const session = await fixture.client.newSession({ cwd: fixture.cwd, mcpServers: [] })
    await fixture.client.waitForSessionUpdate(
      notification => notification.update.sessionUpdate === 'available_commands_update',
      { timeoutMs: RECEIPT_TIMEOUT_MS }
    )
    assertFixtureCatalog(fixture.client.transcript())

    const starts = await waitForCount(fixture.readC3_4SessionStartReceipts, 1)
    const initial = starts[0]!.receipt
    assert.equal(initial.sessionId, session.sessionId)
    assert.equal(typeof initial.sessionFile, 'string')
    assertPrivateSessionPath(fixture, initial.sessionFile!)
    const header = `${JSON.stringify({
      type: 'session',
      version: 3,
      id: session.sessionId,
      timestamp: '2026-08-02T00:00:00.000Z',
      cwd: fixture.cwd
    })}\n`
    await writeFile(initial.sessionFile!, header, { encoding: 'utf8', flag: 'wx', mode: 0o600 })

    const promptPromise = fixture.client.prompt(
      {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: HANG_PROMPT }]
      },
      { timeoutMs: PROMPT_TIMEOUT_MS }
    )
    const written = await waitForCount(fixture.readC3_4InvocationReceipts, 1)
    assert.equal(written.length, 1)
    assert.equal(written[0]!.receipt.piPid, initial.piPid)
    assert.equal(written[0]!.receipt.args, C3_4_FIXTURE_HANG_SENTINEL)
    assert.equal(written[0]!.receipt.invocationCount, 1)
    assert.equal(await readFile(initial.sessionFile!, 'utf8'), header)

    await fixture.client.cancel({ sessionId: session.sessionId })
    const cancelled = await promptPromise
    assert.equal(cancelled.stopReason, 'cancelled')
    const cancelledExecution = record(record(record(cancelled)._meta).piAcp).executeCommand
    assert.deepEqual(record(cancelledExecution), {
      requestId: record(cancelledExecution).requestId,
      name: REAL_PI_FIXTURE_COMMAND_ID,
      disposition: 'cancelled'
    })
    assert.deepEqual(record(record(record(cancelled)._meta).piAcp).routing, {
      promptForwardedToPi: false,
      sentToModel: false
    })
    await waitForProcessExit(initial.piPid)
    assert.equal(isProcessAlive(adapterPid), true)
    assert.deepEqual(fixture.requests, [])
    assert.equal((await fixture.readC3_4InvocationReceipts()).length, 1)
    assert.equal(await readFile(initial.sessionFile!, 'utf8'), header)

    const cancelExchange = promptExchange(fixture.client.transcript(), HANG_PROMPT)
    assert.deepEqual(record(cancelExchange.response.message).result, cancelled)
    assert.equal(notifyUpdates(fixture.client.transcript()).length, 0)
    assertFixtureCatalog(fixture.client.transcript())

    const recoveredResponse = await fixture.client.prompt(
      {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: '/session' }]
      },
      { timeoutMs: PROMPT_TIMEOUT_MS }
    )
    assert.deepEqual(recoveredResponse, { stopReason: 'end_turn' })
    const recoveredStarts = await waitForCount(fixture.readC3_4SessionStartReceipts, 2)
    assert.equal(recoveredStarts.length, 2)
    const replacement = recoveredStarts.map(item => item.receipt).find(receipt => receipt.piPid !== initial.piPid)
    assert.ok(replacement)
    assert.equal(replacement.sessionId, initial.sessionId)
    assert.equal(replacement.sessionFile, initial.sessionFile)
    assert.equal(isProcessAlive(replacement.piPid), true)
    assert.equal(isProcessAlive(adapterPid), true)
    const recoveredSessionText = await readFile(initial.sessionFile!, 'utf8')
    assert.equal(recoveredSessionText.startsWith(header), true)
    assert.equal(`${recoveredSessionText.split('\n')[0]}\n`, header)
    assert.deepEqual(
      recoveredSessionText
        .trimEnd()
        .split('\n')
        .slice(1)
        .map(line => record(JSON.parse(line)).type),
      ['model_change', 'thinking_level_change']
    )
    assert.equal(recoveredSessionText.includes(C3_4_FIXTURE_HANG_SENTINEL), false)
    assert.equal((await fixture.readC3_4InvocationReceipts()).length, 1)
    assertFixtureCatalog(fixture.client.transcript())
    assert.deepEqual(fixture.requests, [])

    const firstShutdowns = await waitForCount(fixture.readC3_4ShutdownReceipts, 1)
    assert.deepEqual(
      firstShutdowns.map(item => item.receipt.piPid),
      [initial.piPid]
    )
    const exit = await fixture.client.close()
    assert.deepEqual({ code: exit.code, signal: exit.signal }, { code: 0, signal: null })
    await waitForProcessExit(replacement.piPid)
    await waitForProcessExit(adapterPid)
    const shutdowns = await waitForCount(fixture.readC3_4ShutdownReceipts, 2)
    assert.deepEqual(
      shutdowns.map(item => item.receipt.piPid).sort((left, right) => left - right),
      [initial.piPid, replacement.piPid].sort((left, right) => left - right)
    )
    assert.equal(await readFile(initial.sessionFile!, 'utf8'), recoveredSessionText)
    assert.equal((await fixture.readC3_4InvocationReceipts()).length, 1)
    assert.deepEqual(fixture.requests, [])
    await fixture.assertWithinHardDeadline()
  }
)

test(
  'C3.4 adapter shutdown fences an active patched command without an ACP completion or replay',
  { timeout: TEST_TIMEOUT_MS, skip: missingPatchedPiSkip },
  async t => {
    const fixture = await startPatchedFixture(t)
    const adapterPid = fixture.client.processId
    assert.ok(adapterPid)
    const session = await fixture.client.newSession({ cwd: fixture.cwd, mcpServers: [] })
    await fixture.client.waitForSessionUpdate(
      notification => notification.update.sessionUpdate === 'available_commands_update',
      { timeoutMs: RECEIPT_TIMEOUT_MS }
    )
    assertFixtureCatalog(fixture.client.transcript())

    const starts = await waitForCount(fixture.readC3_4SessionStartReceipts, 1)
    assert.equal(starts.length, 1)
    const started = starts[0]!.receipt
    assert.equal(started.sessionId, session.sessionId)
    assert.equal(typeof started.sessionFile, 'string')
    assertPrivateSessionPath(fixture, started.sessionFile!)
    const header = `${JSON.stringify({
      type: 'session',
      version: 3,
      id: session.sessionId,
      timestamp: '2026-08-02T00:00:00.000Z',
      cwd: fixture.cwd
    })}\n`
    await writeFile(started.sessionFile!, header, { encoding: 'utf8', flag: 'wx', mode: 0o600 })

    let promptSettled = false
    const promptOutcome = fixture.client
      .prompt(
        {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: HANG_PROMPT }]
        },
        { timeoutMs: PROMPT_TIMEOUT_MS }
      )
      .then(
        value => {
          promptSettled = true
          return { status: 'resolved' as const, value }
        },
        error => {
          promptSettled = true
          return { status: 'rejected' as const, error }
        }
      )

    const written = await waitForCount(fixture.readC3_4InvocationReceipts, 1)
    assert.equal(written.length, 1)
    assert.equal(written[0]!.receipt.piPid, started.piPid)
    assert.equal(written[0]!.receipt.sessionId, session.sessionId)
    assert.equal(written[0]!.receipt.sessionFile, started.sessionFile)
    assert.equal(written[0]!.receipt.args, C3_4_FIXTURE_HANG_SENTINEL)
    assert.equal(written[0]!.receipt.invocationCount, 1)
    assert.equal(promptSettled, false)
    assert.equal(await readFile(started.sessionFile!, 'utf8'), header)

    const beforeClose = fixture.client.transcript()
    const lastSequenceBeforeClose = beforeClose.reduce(
      (last, entry) => ('seq' in entry ? Math.max(last, entry.seq) : last),
      -1
    )
    assert.ok(lastSequenceBeforeClose >= 0)
    const requestIndex = beforeClose.findIndex(entry => {
      if (entry.kind !== 'message' || entry.direction !== 'client_to_agent') return false
      const message = record(entry.message)
      const prompt = record(message.params).prompt
      return (
        message.method === 'session/prompt' &&
        Array.isArray(prompt) &&
        prompt.length === 1 &&
        record(prompt[0]).type === 'text' &&
        record(prompt[0]).text === HANG_PROMPT
      )
    })
    assert.notEqual(requestIndex, -1)
    const requestEntry = beforeClose[requestIndex]
    if (!requestEntry || requestEntry.kind !== 'message') throw new Error('active prompt request was not retained')
    const requestId = record(requestEntry.message).id

    const firstClose = fixture.client.close()
    assert.strictEqual(fixture.client.close(), firstClose)
    const [exit, outcome] = await Promise.all([firstClose, promptOutcome])
    assert.equal(outcome.status, 'rejected')
    if (outcome.status === 'rejected') assert.ok(outcome.error instanceof Error)
    assert.deepEqual({ code: exit.code, signal: exit.signal }, { code: 0, signal: null })
    await waitForProcessExit(started.piPid)
    await waitForProcessExit(adapterPid)

    const transcript = fixture.client.transcript()
    const matchingResponses = transcript.filter(entry => {
      if (entry.kind !== 'message' || entry.direction !== 'agent_to_client') return false
      const message = record(entry.message)
      return message.id === requestId && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))
    })
    assert.deepEqual(matchingResponses, [])
    const postFenceMessages = transcript.filter(
      entry => entry.kind === 'message' && entry.direction === 'agent_to_client' && entry.seq > lastSequenceBeforeClose
    )
    assert.deepEqual(postFenceMessages, [])
    assert.equal(notifyUpdates(transcript).length, 0)
    assertFixtureCatalog(transcript)
    assert.equal(transcript.filter(entry => entry.kind === 'process_exit').length, 1)
    const processExit = transcript.at(-1)
    assert.equal(processExit?.kind, 'process_exit')
    if (processExit?.kind === 'process_exit') {
      assert.equal(processExit.code, 0)
      assert.equal(processExit.signal, null)
    }

    const shutdowns = await waitForCount(fixture.readC3_4ShutdownReceipts, 1)
    assert.equal(shutdowns.length, 1)
    assert.deepEqual(shutdowns[0]!.receipt, {
      schemaVersion: 1,
      checkpoint: 'C3.4',
      phase: 'session_shutdown',
      reason: 'quit',
      nonce: fixture.nonce,
      piVersion: '0.83.0',
      piPid: started.piPid
    })
    assert.equal((await fixture.readC3_4SessionStartReceipts()).length, 1)
    assert.equal((await fixture.readC3_4InvocationReceipts()).length, 1)
    assert.equal(await readFile(started.sessionFile!, 'utf8'), header)
    assert.deepEqual(fixture.requests, [])
    await fixture.closeLoopback()
    assert.deepEqual(fixture.requests, [])
    await fixture.assertWithinHardDeadline()
  }
)
