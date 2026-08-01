import assert from 'node:assert/strict'
import { rm, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import test from 'node:test'
import { PI_RPC_PROCESS_TERMINATED_CODE } from '../../src/pi-rpc/process.js'
import { C1_3_RECOVERY_RESPONSE_TEXT, MAX_LOOPBACK_BODY_BYTES, startRealPiFixture } from '../helpers/real-pi-fixture.js'

const TEST_TIMEOUT_MS = 45_000
const PROMPT_TIMEOUT_MS = 10_000
const TERMINATE_COMMAND = '/c1-3-terminate-child'
const RECOVERY_PROMPT = 'Return the deterministic C1.3 recovery response.'

type Transcript = ReturnType<Awaited<ReturnType<typeof startRealPiFixture>>['client']['transcript']>

function record(value: unknown): Record<string, any> {
  return typeof value === 'object' && value !== null ? (value as Record<string, any>) : {}
}

function terminatedPromptExchange(transcript: Transcript) {
  const requestIndex = transcript.findIndex(entry => {
    if (entry.kind !== 'message' || entry.direction !== 'client_to_agent') return false
    const message = record(entry.message)
    if (message.method !== 'session/prompt') return false
    const prompt = record(message.params).prompt
    return (
      Array.isArray(prompt) &&
      prompt.some(block => record(block).type === 'text' && record(block).text === TERMINATE_COMMAND)
    )
  })
  assert.notEqual(requestIndex, -1)
  const request = transcript[requestIndex]
  if (!request || request.kind !== 'message') throw new Error('C1.3 prompt request was not recorded as a message')
  const requestId = record(request.message).id

  const responses = transcript.flatMap((entry, index) => {
    if (index <= requestIndex || entry.kind !== 'message' || entry.direction !== 'agent_to_client') return []
    const message = record(entry.message)
    return message.id === requestId && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))
      ? [{ index, message }]
      : []
  })
  assert.equal(responses.length, 1)

  const terminalIdleIndexes = transcript.flatMap((entry, index) => {
    if (index <= requestIndex || entry.kind !== 'message' || entry.direction !== 'agent_to_client') return []
    const message = record(entry.message)
    if (message.method !== 'session/update') return []
    const update = record(record(message.params).update)
    const piAcp = record(record(update._meta).piAcp)
    return update.sessionUpdate === 'session_info_update' && piAcp.queueDepth === 0 && piAcp.running === false
      ? [index]
      : []
  })

  return { requestIndex, response: responses[0]!, terminalIdleIndexes }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ESRCH') return false
    throw error
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`process ${String(pid)} did not exit within ${String(timeoutMs)}ms`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function visibleTextChunks(
  transcript: ReturnType<Awaited<ReturnType<typeof startRealPiFixture>>['client']['transcript']>
) {
  return transcript.flatMap(entry => {
    if (entry.kind !== 'message' || entry.direction !== 'agent_to_client') return []
    const message = entry.message as Record<string, any>
    if (message.method !== 'session/update') return []
    const update = message.params?.update as Record<string, any> | undefined
    return update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text'
      ? [String(update.content.text)]
      : []
  })
}

test(
  'C1.3 real Pi post-ACK exit fails once and the next fresh prompt restores the same session',
  { timeout: TEST_TIMEOUT_MS },
  async t => {
    const fixture = await startRealPiFixture({
      childTermination: true,
      hardDeadlineMs: 35_000,
      transcriptCheckpoint: 'C1.3',
      transcriptCaseId: 'C1.3-child-exit-and-recovery'
    })
    t.after(async () => {
      await fixture.cleanup()
    })

    await fixture.client.initialize()
    const adapterPid = fixture.client.processId
    assert.ok(adapterPid)
    const session = await fixture.client.newSession({ cwd: fixture.cwd, mcpServers: [] })

    const initialReceipts = await fixture.readC1_3SessionStartReceipts()
    assert.equal(initialReceipts.length, 1)
    const initial = initialReceipts[0]!.receipt
    assert.equal(initial.checkpoint, 'C1.3')
    assert.equal(initial.piVersion, '0.83.0')
    assert.equal(initial.sessionId, session.sessionId)
    assert.equal(typeof initial.sessionFile, 'string')
    assert.equal(isProcessAlive(initial.piPid), true)
    const relativeSessionFile = relative(fixture.sessionDir, initial.sessionFile!)
    assert.ok(
      relativeSessionFile !== '' &&
        relativeSessionFile !== '..' &&
        !relativeSessionFile.startsWith(`..${sep}`) &&
        !isAbsolute(relativeSessionFile)
    )

    // Pi defers writing a new session until the first assistant message. Seed
    // the already-declared path with its exact header so this zero-provider
    // termination case has durable state whose identity can be validated on
    // recovery without adding a model request before the fault.
    await writeFile(
      initial.sessionFile!,
      `${JSON.stringify({
        type: 'session',
        version: 3,
        id: initial.sessionId,
        timestamp: '2026-08-01T00:00:00.000Z',
        cwd: fixture.cwd
      })}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 }
    )

    // The base C0.6 receipt names are intentionally single-process. Remove the
    // first generation's private receipts before spawning the replacement;
    // C0.7 persisted artifacts and fixture source remain untouched.
    await rm(fixture.registrationReceiptPath, { force: true })

    const startedAt = performance.now()
    const error = await fixture.client
      .prompt(
        {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: TERMINATE_COMMAND }]
        },
        { timeoutMs: PROMPT_TIMEOUT_MS }
      )
      .then(() => undefined)
      .catch((caught: unknown) => caught)
    const failureDurationMs = performance.now() - startedAt

    assert.ok(error instanceof Error)
    assert.equal((error as Error & { code?: unknown }).code, -32603)
    const errorData = record((error as Error & { data?: unknown }).data)
    assert.equal(errorData.code, PI_RPC_PROCESS_TERMINATED_CODE)
    const processData = record(record(errorData.piAcp).process)
    assert.equal(processData.state, 'terminated')
    assert.ok(
      ['exit', 'process_error', 'stdin_write_failure', 'stdin_closed', 'stdout_eof', 'stdout_error'].includes(
        String(processData.cause)
      ),
      `unexpected graceful-shutdown terminal cause: ${String(processData.cause)}`
    )
    if (Object.hasOwn(processData, 'exitCode')) assert.equal(Number.isInteger(processData.exitCode), true)
    assert.deepEqual(record(record(errorData.piAcp).recovery), {
      strategy: 'restore_session_on_next_request',
      automaticReplay: false
    })
    assert.ok(failureDurationMs < PROMPT_TIMEOUT_MS)
    assert.equal(fixture.requests.length, 0)
    assert.equal(isProcessAlive(adapterPid), true)
    await waitForProcessExit(initial.piPid)

    const failureExchange = terminatedPromptExchange(fixture.client.transcript())
    const wireError = record(failureExchange.response.message.error)
    assert.equal(wireError.code, -32603)
    assert.equal(record(wireError.data).code, PI_RPC_PROCESS_TERMINATED_CODE)
    assert.deepEqual(record(wireError.data), errorData)
    assert.deepEqual(record(record(record(wireError.data).piAcp).recovery), {
      strategy: 'restore_session_on_next_request',
      automaticReplay: false
    })
    assert.equal(Object.hasOwn(failureExchange.response.message, 'result'), false)
    assert.equal(failureExchange.terminalIdleIndexes.length, 1)
    assert.ok(failureExchange.terminalIdleIndexes[0]! < failureExchange.response.index)
    const serializedWireError = JSON.stringify(wireError)
    assert.equal(serializedWireError.includes(fixture.rootDir), false)
    assert.equal(serializedWireError.includes(initial.sessionFile!), false)
    assert.equal(serializedWireError.includes('EPIPE'), false)

    // Read the first generation's graceful-shutdown receipt before removing it
    // so the replacement can later own the canonical single-process marker.
    const initialShutdown = await fixture.readShutdownReceipt()
    assert.equal(initialShutdown.stat.isFile(), true)
    assert.equal(initialShutdown.stat.isSymbolicLink(), false)
    assert.deepEqual(initialShutdown.receipt, {
      schemaVersion: 1,
      checkpoint: 'C0.6',
      fixtureId: 'pi-extension-pack-v1',
      phase: 'session_shutdown',
      reason: 'quit',
      nonce: fixture.nonce,
      piVersion: '0.83.0',
      piPid: initial.piPid
    })
    await rm(fixture.shutdownReceiptPath, { force: true })

    const recovered = await fixture.client.prompt(
      {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: RECOVERY_PROMPT }]
      },
      { timeoutMs: PROMPT_TIMEOUT_MS }
    )
    await fixture.assertWithinHardDeadline()
    assert.equal(recovered.stopReason, 'end_turn')
    assert.equal(fixture.requests.length, 1)
    assert.ok(visibleTextChunks(fixture.client.transcript()).includes(C1_3_RECOVERY_RESPONSE_TEXT))

    const request = fixture.requests[0]!
    assert.equal(request.method, 'POST')
    assert.equal(request.url, '/v1/chat/completions')
    assert.equal(request.outcome, 'end')
    assert.equal(request.bodyExceededLimit, false)
    assert.ok(request.body && request.body.length > 0 && request.body.length <= MAX_LOOPBACK_BODY_BYTES)
    const recoveryRequestBody = request.body.toString('utf8')
    assert.equal(recoveryRequestBody.includes(RECOVERY_PROMPT), true)
    assert.equal(recoveryRequestBody.includes(TERMINATE_COMMAND), false)

    const recoveredReceipts = await fixture.readC1_3SessionStartReceipts()
    assert.equal(recoveredReceipts.length, 2)
    const replacement = recoveredReceipts
      .map(receipt => receipt.receipt)
      .find(receipt => receipt.piPid !== initial.piPid)
    assert.ok(replacement)
    assert.equal(replacement.sessionId, initial.sessionId)
    assert.equal(replacement.sessionFile, initial.sessionFile)
    assert.equal(isProcessAlive(replacement.piPid), true)
    assert.equal(isProcessAlive(adapterPid), true)

    const exit = await fixture.client.close()
    assert.deepEqual({ code: exit.code, signal: exit.signal }, { code: 0, signal: null })
    await waitForProcessExit(replacement.piPid)
    await waitForProcessExit(adapterPid)
    await fixture.closeLoopback()
    const shutdown = await fixture.readShutdownReceipt()
    assert.equal(shutdown.receipt.piPid, replacement.piPid)
  }
)

test(
  'C1.3 keeps nested Pi in the outer adapter process group for uncooperative shutdown containment',
  { timeout: TEST_TIMEOUT_MS, skip: process.platform === 'win32' },
  async () => {
    const fixture = await startRealPiFixture({
      hardDeadlineMs: 20_000,
      clientShutdownTimeoutMs: 10_000,
      transcriptCheckpoint: 'C1.3',
      transcriptCaseId: 'C1.3-inherited-process-group'
    })
    let piPid: number | undefined
    try {
      await fixture.client.initialize()
      await fixture.client.newSession({ cwd: fixture.cwd, mcpServers: [] })
      const registration = await fixture.readRegistrationReceipt()
      piPid = registration.receipt.piPid
      const adapterPid = fixture.client.processId
      assert.ok(adapterPid)
      assert.equal(isProcessAlive(piPid), true)
      assert.equal(isProcessAlive(adapterPid), true)

      // Simulate an uncooperative outer-supervisor shutdown without giving the
      // adapter's direct-child cleanup time to run. The one group SIGKILL must
      // still contain nested Pi, while the longer harness wait only permits
      // process reaping under parallel CI load.
      process.kill(piPid, 'SIGSTOP')
      process.kill(-adapterPid, 'SIGKILL')
      await waitForProcessExit(piPid, 10_000)
      await waitForProcessExit(adapterPid, 10_000)
      await fixture.client.close()
    } finally {
      if (piPid !== undefined && isProcessAlive(piPid)) {
        try {
          process.kill(piPid, 'SIGCONT')
        } catch {
          // best-effort emergency cleanup below
        }
        try {
          process.kill(piPid, 'SIGKILL')
        } catch {
          // already gone
        }
      }
      await fixture.cleanup()
    }
  }
)
