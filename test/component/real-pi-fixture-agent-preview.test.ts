import assert from 'node:assert/strict'
import { lstat, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import test from 'node:test'
import {
  C3_5_FIXTURE_AGENT_RESPONSE_TEXT,
  C3_5_FIXTURE_AGENT_USER_TEXT,
  MAX_LOOPBACK_BODY_BYTES,
  REAL_PI_FIXTURE_AGENT_COMMAND_ID,
  REAL_PI_FIXTURE_MODEL_ID,
  startRealPiFixture,
  type RealPiC3_5Receipt,
  type RealPiC3_5Schedule
} from '../helpers/real-pi-fixture.js'

const TEST_TIMEOUT_MS = 45_000
const PROMPT_TIMEOUT_MS = 20_000
const RECEIPT_TIMEOUT_MS = 10_000
const patchedPiPackageRoot = process.env.PI_ACP_PATCHED_PI_PACKAGE_ROOT
const requestedSchedule = process.env.PI_ACP_C3_5_STRESS_SCHEDULE
const missingPatchedPiSkip = patchedPiPackageRoot
  ? false
  : 'PI_ACP_PATCHED_PI_PACKAGE_ROOT is required for the dedicated C3.5 real-Pi matrix'

if (requestedSchedule !== undefined && requestedSchedule !== 'preflight' && requestedSchedule !== 'provider-final') {
  throw new Error('PI_ACP_C3_5_STRESS_SCHEDULE must be preflight or provider-final')
}

const schedules: readonly RealPiC3_5Schedule[] = requestedSchedule
  ? [requestedSchedule]
  : ['preflight', 'provider-final']

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

async function waitForReceipts(
  fixture: Fixture,
  phase: RealPiC3_5Receipt['phase'],
  count = 1
): Promise<RealPiC3_5Receipt[]> {
  const deadline = Date.now() + RECEIPT_TIMEOUT_MS
  for (;;) {
    const receipts = (await fixture.readC3_5Receipts(phase)).map(item => item.receipt)
    if (receipts.length >= count) return receipts
    if (Date.now() >= deadline) {
      throw new Error(`expected ${String(count)} C3.5 ${phase} receipts, received ${String(receipts.length)}`)
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function c3_5ReleasePath(fixture: Fixture, phase: 'preflight' | 'provider-final'): string {
  return join(fixture.rootDir, 'artifacts', `pi-acp-c3.5-${phase}-release-${fixture.nonce}`)
}

async function assertNoC3_5TemporaryPublications(fixture: Fixture): Promise<void> {
  const names = await readdir(join(fixture.rootDir, 'artifacts'))
  assert.deepEqual(
    names.filter(name => name.endsWith('.tmp')),
    []
  )
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

function assertFixtureCatalog(transcript: Transcript): void {
  const catalogs = availableCommandUpdates(transcript)
  assert.equal(catalogs.length, 1)
  const commands = catalogs[0]!.update.availableCommands
  assert.equal(Array.isArray(commands), true)
  const fixtures = (commands as unknown[]).filter(command => {
    const name = record(command).name
    return name === REAL_PI_FIXTURE_AGENT_COMMAND_ID || name === 'fixture-state'
  })
  assert.deepEqual(fixtures, [
    {
      name: REAL_PI_FIXTURE_AGENT_COMMAND_ID,
      description: 'Run the deterministic Pi ACP C3.5 fixture agent turn',
      _meta: {
        piAcp: {
          command: {
            schemaVersion: 1,
            id: 'extension:pi-acp-fixture:fixture-agent',
            source: 'extension',
            sourceId: 'extension:pi-acp-fixture',
            compatibility: 'rpc-native',
            execution: 'agent',
            exposure: 'experimental',
            interactions: []
          }
        }
      }
    }
  ])
}

function matchingPromptExchange(transcript: Transcript) {
  const requestIndex = transcript.findIndex(entry => {
    if (entry.kind !== 'message' || entry.direction !== 'client_to_agent') return false
    const message = record(entry.message)
    const prompt = record(message.params).prompt
    return (
      message.method === 'session/prompt' &&
      Array.isArray(prompt) &&
      prompt.length === 1 &&
      record(prompt[0]).type === 'text' &&
      record(prompt[0]).text === '/fixture-agent'
    )
  })
  assert.notEqual(requestIndex, -1)
  const request = transcript[requestIndex]
  if (!request || request.kind !== 'message') throw new Error('C3.5 prompt request was not retained')
  const requestId = record(request.message).id
  const responses = transcript.flatMap((entry, index) => {
    if (entry.kind !== 'message' || entry.direction !== 'agent_to_client' || index <= requestIndex) return []
    const message = record(entry.message)
    return message.id === requestId && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))
      ? [{ index, message }]
      : []
  })
  return { requestIndex, responses }
}

function assistantChunks(transcript: Transcript) {
  return transcript.flatMap((entry, index) => {
    if (entry.kind !== 'message' || entry.direction !== 'agent_to_client') return []
    const message = record(entry.message)
    if (message.method !== 'session/update') return []
    const update = record(record(message.params).update)
    const content = record(update.content)
    return update.sessionUpdate === 'agent_message_chunk' && content.type === 'text'
      ? [{ index, text: content.text }]
      : []
  })
}

function assertNoPromptCompletion(fixture: Fixture, settled: boolean): void {
  assert.equal(settled, false)
  assert.equal(matchingPromptExchange(fixture.client.transcript()).responses.length, 0)
}

function assertPrivateSessionPath(fixture: Fixture, sessionFile: string): void {
  assert.equal(isAbsolute(sessionFile), true)
  const relativePath = relative(fixture.sessionDir, sessionFile)
  assert.ok(
    relativePath !== '' && relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
  )
}

function messageText(message: Record<string, any>): string {
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  return message.content
    .filter((content: unknown) => record(content).type === 'text' && typeof record(content).text === 'string')
    .map((content: unknown) => String(record(content).text))
    .join('')
}

async function assertPersistedTurn(fixture: Fixture, sessionId: string, sessionFile: string): Promise<void> {
  const sessionMap = JSON.parse(await readFile(fixture.sessionMapPath, 'utf8')) as {
    sessions?: Record<string, { sessionFile?: unknown }>
  }
  assert.equal(sessionMap.sessions?.[sessionId]?.sessionFile, sessionFile)
  assert.equal(await realpath(sessionFile), sessionFile)
  const stat = await lstat(sessionFile)
  assert.equal(stat.isFile(), true)
  assert.equal(stat.isSymbolicLink(), false)

  const source = await readFile(sessionFile, 'utf8')
  assert.equal(source.includes('/fixture-agent'), false)
  const entries = source
    .trimEnd()
    .split('\n')
    .map(line => record(JSON.parse(line)))
  const messages = entries.filter(entry => entry.type === 'message').map(entry => record(entry.message))
  const userMessages = messages.filter(message => message.role === 'user')
  const assistantMessages = messages.filter(message => message.role === 'assistant')
  assert.equal(userMessages.length, 1)
  assert.equal(assistantMessages.length, 1)
  assert.equal(messageText(userMessages[0]!), C3_5_FIXTURE_AGENT_USER_TEXT)
  assert.equal(messageText(assistantMessages[0]!), C3_5_FIXTURE_AGENT_RESPONSE_TEXT)
}

function assertReceiptIdentity(
  receipt: RealPiC3_5Receipt,
  expected: {
    phase: RealPiC3_5Receipt['phase']
    sequence: number
    schedule: RealPiC3_5Schedule
    nonce: string
    piPid: number
    sessionId: string
    sessionFile: string
  }
): void {
  assert.equal(receipt.schemaVersion, 1)
  assert.equal(receipt.checkpoint, 'C3.5')
  assert.equal(receipt.phase, expected.phase)
  assert.equal(receipt.sequence, expected.sequence)
  assert.equal(receipt.schedule, expected.schedule)
  assert.equal(receipt.nonce, expected.nonce)
  assert.equal(receipt.piVersion, '0.83.0')
  assert.equal(receipt.piPid, expected.piPid)
  assert.equal(receipt.sessionId, expected.sessionId)
  assert.equal(receipt.sessionFile, expected.sessionFile)
}

for (const schedule of schedules) {
  test(
    `C3.5 ${schedule} schedule holds agent_run completion until the attributed real Pi turn settles`,
    { timeout: TEST_TIMEOUT_MS, skip: missingPatchedPiSkip },
    async t => {
      assert.ok(patchedPiPackageRoot)
      const fixture = await startRealPiFixture({
        fixtureMode: 'c3.5-agent-run',
        c3_5Schedule: schedule,
        patchedPiPackageRoot,
        hardDeadlineMs: 35_000,
        transcriptCheckpoint: 'C3.5'
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

      const starts = await waitForReceipts(fixture, 'session-start')
      assert.equal(starts.length, 1)
      const started = starts[0]!
      assert.equal(typeof started.sessionFile, 'string')
      assertPrivateSessionPath(fixture, started.sessionFile!)
      assertReceiptIdentity(started, {
        phase: 'session-start',
        sequence: 1,
        schedule,
        nonce: fixture.nonce,
        piPid: started.piPid,
        sessionId: session.sessionId,
        sessionFile: started.sessionFile!
      })
      assert.equal(isProcessAlive(started.piPid), true)
      assert.equal(fixture.piPackageRoot, await realpath(patchedPiPackageRoot))

      if (schedule === 'preflight') {
        const releasePath = c3_5ReleasePath(fixture, schedule)
        await writeFile(releasePath, 'corrupt\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        try {
          await assert.rejects(fixture.releaseC3_5Preflight(), /release sentinel has invalid contents/u)
          assert.equal(await readFile(releasePath, 'utf8'), 'corrupt\n')
        } finally {
          await rm(releasePath, { force: true })
        }
        await assertNoC3_5TemporaryPublications(fixture)
      }

      let promptSettled = false
      const prompt = fixture.client
        .prompt(
          {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: '/fixture-agent' }]
          },
          { timeoutMs: PROMPT_TIMEOUT_MS }
        )
        .then(
          response => {
            promptSettled = true
            return response
          },
          error => {
            promptSettled = true
            throw error
          }
        )

      const invocations = await waitForReceipts(fixture, 'command-invocation')
      assert.equal(invocations.length, 1)
      const invocation = invocations[0]!
      assertReceiptIdentity(invocation, {
        phase: 'command-invocation',
        sequence: 2,
        schedule,
        nonce: fixture.nonce,
        piPid: started.piPid,
        sessionId: session.sessionId,
        sessionFile: started.sessionFile!
      })
      assert.equal(invocation.invocationCount, 1)
      assert.equal(invocation.name, REAL_PI_FIXTURE_AGENT_COMMAND_ID)
      assert.equal(invocation.args, '')
      assert.equal(invocation.argsUtf8ByteLength, 0)
      assert.equal(invocation.argsBase64, '')

      const entered = (await waitForReceipts(fixture, 'before-agent-start-entered'))[0]!
      assertReceiptIdentity(entered, {
        phase: 'before-agent-start-entered',
        sequence: 3,
        schedule,
        nonce: fixture.nonce,
        piPid: started.piPid,
        sessionId: session.sessionId,
        sessionFile: started.sessionFile!
      })

      if (schedule === 'preflight') {
        await new Promise(resolve => setImmediate(resolve))
        assert.equal((await fixture.readC3_5Receipts('before-agent-start-released')).length, 0)
        assert.equal(fixture.requests.length, 0)
        assertNoPromptCompletion(fixture, promptSettled)
        await Promise.all([fixture.releaseC3_5Preflight(), fixture.releaseC3_5Preflight()])
      } else {
        await fixture.client.waitForSessionUpdate(
          notification => {
            const update = record(notification.update)
            return (
              update.sessionUpdate === 'agent_message_chunk' &&
              record(update.content).text === C3_5_FIXTURE_AGENT_RESPONSE_TEXT
            )
          },
          { timeoutMs: RECEIPT_TIMEOUT_MS }
        )
        assert.equal(fixture.requests.length, 1)
        assert.equal(fixture.requests[0]!.outcome, 'end')
        assert.equal((await fixture.readC3_5Receipts('agent-settled')).length, 0)
        assertNoPromptCompletion(fixture, promptSettled)
        await Promise.all([fixture.releaseC3_5ProviderFinal(), fixture.releaseC3_5ProviderFinal()])
      }

      const response = await prompt
      assert.equal(promptSettled, true)
      const settledAtCompletion = await fixture.readC3_5Receipts('agent-settled')
      assert.equal(settledAtCompletion.length, 1)
      assert.equal(response.stopReason, 'end_turn')
      const piAcp = record(record(response)._meta).piAcp
      const execution = record(record(piAcp).executeCommand)
      assert.equal(typeof execution.requestId, 'string')
      assert.deepEqual(execution, {
        requestId: execution.requestId,
        name: REAL_PI_FIXTURE_AGENT_COMMAND_ID,
        source: 'extension',
        disposition: 'agent_run'
      })
      assert.deepEqual(record(record(piAcp).routing), {
        promptForwardedToPi: false,
        sentToModel: true
      })

      const lifecycle: readonly [RealPiC3_5Receipt['phase'], number][] = [
        ['before-agent-start-released', 4],
        ['agent-start', 5],
        ['agent-end', 6],
        ['agent-settled', 7]
      ]
      for (const [phase, sequence] of lifecycle) {
        const receipt =
          phase === 'agent-settled' ? settledAtCompletion[0]!.receipt : (await waitForReceipts(fixture, phase))[0]!
        assertReceiptIdentity(receipt, {
          phase,
          sequence,
          schedule,
          nonce: fixture.nonce,
          piPid: started.piPid,
          sessionId: session.sessionId,
          sessionFile: started.sessionFile!
        })
      }

      assert.equal(fixture.requests.length, 1)
      const providerRequest = fixture.requests[0]!
      assert.equal(providerRequest.method, 'POST')
      assert.equal(providerRequest.url, '/v1/chat/completions')
      assert.equal(providerRequest.host, `${fixture.loopbackAddress.host}:${String(fixture.loopbackAddress.port)}`)
      assert.equal(providerRequest.authorization, `Bearer pi-acp-fixture-${fixture.nonce}`)
      assert.equal(providerRequest.contentType?.startsWith('application/json'), true)
      assert.equal(providerRequest.outcome, 'end')
      assert.equal(providerRequest.bodyExceededLimit, false)
      assert.ok(providerRequest.body)
      assert.ok(providerRequest.body.length > 0 && providerRequest.body.length <= MAX_LOOPBACK_BODY_BYTES)
      const body = JSON.parse(providerRequest.body.toString('utf8')) as {
        model?: unknown
        stream?: unknown
        messages?: { role?: unknown; content?: unknown }[]
      }
      assert.equal(body.model, REAL_PI_FIXTURE_MODEL_ID)
      assert.equal(body.stream, true)
      const userMessages = (body.messages ?? []).filter(message => message.role === 'user')
      assert.equal(userMessages.length, 1)
      assert.equal(messageText(record(userMessages[0])), C3_5_FIXTURE_AGENT_USER_TEXT)
      assert.equal(providerRequest.body.includes(Buffer.from('/fixture-agent')), false)

      const exchange = matchingPromptExchange(fixture.client.transcript())
      assert.equal(exchange.responses.length, 1)
      const commandChunks = assistantChunks(fixture.client.transcript()).filter(
        chunk => chunk.index > exchange.requestIndex && chunk.index < exchange.responses[0]!.index
      )
      assert.deepEqual(
        commandChunks.map(chunk => chunk.text),
        [C3_5_FIXTURE_AGENT_RESPONSE_TEXT]
      )
      assert.deepEqual(record(exchange.responses[0]!.message).result, response)
      await assertPersistedTurn(fixture, session.sessionId, started.sessionFile!)

      const liveness = await fixture.client.prompt(
        {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: '/session' }]
        },
        { timeoutMs: PROMPT_TIMEOUT_MS }
      )
      assert.deepEqual(liveness, { stopReason: 'end_turn' })
      assert.equal(isProcessAlive(started.piPid), true)
      assert.equal((await fixture.readC3_5Receipts('session-start')).length, 1)
      assert.equal((await fixture.readC3_5Receipts('command-invocation')).length, 1)
      assert.equal((await fixture.readC3_5Receipts('agent-start')).length, 1)
      assert.equal((await fixture.readC3_5Receipts('agent-end')).length, 1)
      assert.equal((await fixture.readC3_5Receipts('agent-settled')).length, 1)
      assert.equal(fixture.requests.length, 1)

      const exit = await fixture.client.close()
      assert.deepEqual({ code: exit.code, signal: exit.signal }, { code: 0, signal: null })
      await waitForProcessExit(started.piPid)
      await waitForProcessExit(adapterPid)
      const shutdowns = await waitForReceipts(fixture, 'session-shutdown')
      assert.equal(shutdowns.length, 1)
      assertReceiptIdentity(shutdowns[0]!, {
        phase: 'session-shutdown',
        sequence: 8,
        schedule,
        nonce: fixture.nonce,
        piPid: started.piPid,
        sessionId: session.sessionId,
        sessionFile: started.sessionFile!
      })
      assert.equal(shutdowns[0]!.reason, 'quit')
      await assertNoC3_5TemporaryPublications(fixture)
      await fixture.closeLoopback()
      await fixture.assertWithinHardDeadline()
    }
  )
}
