import assert from 'node:assert/strict'
import { lstat, readFile } from 'node:fs/promises'
import test from 'node:test'
import type { AcpTranscriptEntry } from '../helpers/acp-process-client.js'
import { startRealPiFixture } from '../helpers/real-pi-fixture.js'
import { CommandNotAdvertisedError, StrictCatalogClient } from '../helpers/strict-catalog-client.js'

const TEST_TIMEOUT_MS = 40_000
const PROMPT_TIMEOUT_MS = 10_000
const ARGUMENT_SENTINEL = 'C1_5_REFUSAL_ARGUMENT_SENTINEL_DO_NOT_ECHO'
const IMAGE_SENTINEL = 'C1_5_REFUSAL_IMAGE_SENTINEL_DO_NOT_ECHO'
const IMAGE_SENTINEL_BASE64 = Buffer.from(IMAGE_SENTINEL, 'utf8').toString('base64')
const EXPECTED_ADAPTER_COMMANDS = [
  'compact',
  'autocompact',
  'export',
  'session',
  'name',
  'steering',
  'follow-up',
  'changelog'
] as const
const UNSUPPORTED_PI_BUILTINS = [
  'settings',
  'model',
  'scoped-models',
  'import',
  'share',
  'copy',
  'hotkeys',
  'fork',
  'clone',
  'tree',
  'trust',
  'login',
  'logout',
  'new',
  'resume',
  'reload',
  'quit'
] as const

function record(value: unknown): Record<string, any> {
  return typeof value === 'object' && value !== null ? (value as Record<string, any>) : {}
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (isProcessRunning(pid)) {
    if (Date.now() >= deadline) throw new Error(`process ${String(pid)} remained alive after ${timeoutMs}ms`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function assertPathMissing(path: string): Promise<void> {
  await assert.rejects(lstat(path), (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT')
    return true
  })
}

function refusalResponse(command: (typeof UNSUPPORTED_PI_BUILTINS)[number]) {
  const summary = `Pi built-in /${command} is not supported over ACP; it was not sent to Pi or the model.`
  return {
    stopReason: 'refusal',
    _meta: {
      piAcp: {
        diagnostic: {
          schemaVersion: 1,
          code: 'PI_ACP_UNSUPPORTED_PI_BUILTIN',
          phase: 'routing',
          source: 'pi-builtin',
          command,
          summary,
          summaryLimitBytes: 256,
          truncated: false,
          redacted: false
        },
        routing: {
          promptForwardedToPi: false,
          sentToModel: false
        }
      }
    }
  }
}

function promptRequests(transcript: readonly AcpTranscriptEntry[]): Extract<AcpTranscriptEntry, { kind: 'message' }>[] {
  return transcript.filter(
    (entry): entry is Extract<AcpTranscriptEntry, { kind: 'message' }> =>
      entry.kind === 'message' &&
      entry.direction === 'client_to_agent' &&
      record(entry.message).method === 'session/prompt'
  )
}

function matchingPromptResponses(
  transcript: readonly AcpTranscriptEntry[],
  request: Extract<AcpTranscriptEntry, { kind: 'message' }>
): Extract<AcpTranscriptEntry, { kind: 'message' }>[] {
  const requestId = record(request.message).id
  return transcript.filter(
    (entry): entry is Extract<AcpTranscriptEntry, { kind: 'message' }> =>
      entry.kind === 'message' &&
      entry.direction === 'agent_to_client' &&
      record(entry.message).id === requestId &&
      (Object.hasOwn(record(entry.message), 'result') || Object.hasOwn(record(entry.message), 'error'))
  )
}

async function readMappedSession(fixture: Awaited<ReturnType<typeof startRealPiFixture>>, sessionId: string) {
  const sessionMap = JSON.parse(await readFile(fixture.sessionMapPath, 'utf8')) as {
    sessions?: Record<string, { sessionFile?: unknown }>
  }
  const sessionFile = sessionMap.sessions?.[sessionId]?.sessionFile
  assert.equal(typeof sessionFile, 'string')
  try {
    return await readFile(sessionFile as string, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

test(
  'C1.5 pinned real Pi refuses every unsupported built-in before Pi or the configured provider',
  { timeout: TEST_TIMEOUT_MS },
  async t => {
    const fixture = await startRealPiFixture({
      hardDeadlineMs: 30_000,
      transcriptCheckpoint: 'C1.5',
      transcriptCaseId: 'C1.5-known-pi-builtin-refusal'
    })
    t.after(fixture.cleanup)

    await fixture.client.initialize()
    const session = await fixture.client.newSession({ cwd: fixture.cwd, mcpServers: [] })
    await fixture.client.waitForSessionUpdate(
      notification =>
        notification.sessionId === session.sessionId &&
        notification.update.sessionUpdate === 'available_commands_update',
      { timeoutMs: PROMPT_TIMEOUT_MS }
    )

    const strict = new StrictCatalogClient(fixture.client, PROMPT_TIMEOUT_MS)
    t.after(() => strict.dispose())
    const catalog = await strict.waitForCatalog(session.sessionId)
    assert.deepEqual(
      catalog.commands.map(command => command.name),
      EXPECTED_ADAPTER_COMMANDS
    )
    assert.deepEqual(
      catalog.commands.filter(command => (UNSUPPORTED_PI_BUILTINS as readonly string[]).includes(command.name)),
      []
    )

    const promptCountBeforeStrictRefusal = promptRequests(fixture.client.transcript()).length
    await assert.rejects(strict.promptCommand({ sessionId: session.sessionId, name: 'trust' }), (error: unknown) => {
      assert.ok(error instanceof CommandNotAdvertisedError)
      assert.equal(error.sessionId, session.sessionId)
      assert.equal(error.commandName, 'trust')
      assert.deepEqual(error.advertisedNames, EXPECTED_ADAPTER_COMMANDS)
      return true
    })
    assert.equal(promptRequests(fixture.client.transcript()).length, promptCountBeforeStrictRefusal)
    assert.deepEqual(fixture.requests, [])
    strict.dispose()

    const { receipt } = await fixture.readRegistrationReceipt()
    assert.equal(receipt.piVersion, '0.83.0')
    const adapterPid = fixture.client.processId
    assert.ok(adapterPid)
    assert.notEqual(receipt.piPid, adapterPid)
    assert.equal(isProcessRunning(receipt.piPid), true)
    assert.equal(receipt.model.selected, true)
    assert.equal(receipt.model.available, true)
    assert.equal(receipt.model.authConfigured, true)

    const updatesBeforeRefusals = fixture.client.retainedSessionUpdateCount
    for (const command of UNSUPPORTED_PI_BUILTINS) {
      const prompt = [
        { type: 'text' as const, text: `/${command}\t${ARGUMENT_SENTINEL}` },
        ...(command === 'trust' ? [{ type: 'image' as const, mimeType: 'image/png', data: IMAGE_SENTINEL_BASE64 }] : [])
      ]
      const result = await fixture.client.prompt(
        {
          sessionId: session.sessionId,
          prompt
        },
        { timeoutMs: PROMPT_TIMEOUT_MS }
      )
      assert.deepEqual(result, refusalResponse(command))
      assert.equal(
        fixture.client.retainedSessionUpdateCount,
        updatesBeforeRefusals,
        `/${command} must not publish a rejection session/update`
      )
      assert.deepEqual(fixture.requests, [], `/${command} must not reach the configured provider`)
    }
    await fixture.assertWithinHardDeadline()
    await assertPathMissing(fixture.shutdownReceiptPath)
    assert.equal(isProcessRunning(receipt.piPid), true)

    const refusalTranscript = fixture.client.transcript()
    const refusalRequests = promptRequests(refusalTranscript)
    assert.equal(refusalRequests.length, UNSUPPORTED_PI_BUILTINS.length)
    assert.deepEqual(
      refusalRequests.map(entry => record(record(entry.message).params).prompt),
      UNSUPPORTED_PI_BUILTINS.map(command => [
        { type: 'text', text: `/${command}\t${ARGUMENT_SENTINEL}` },
        ...(command === 'trust' ? [{ type: 'image', mimeType: 'image/png', data: IMAGE_SENTINEL_BASE64 }] : [])
      ])
    )
    for (const [index, request] of refusalRequests.entries()) {
      const responses = matchingPromptResponses(refusalTranscript, request)
      assert.equal(responses.length, 1, `/${UNSUPPORTED_PI_BUILTINS[index]} must have exactly one ACP response`)
      assert.deepEqual(record(responses[0]!.message).result, refusalResponse(UNSUPPORTED_PI_BUILTINS[index]!))
    }

    const agentToClientWire = refusalTranscript
      .flatMap(entry =>
        entry.kind === 'message' && entry.direction === 'agent_to_client' ? [JSON.stringify(entry.message)] : []
      )
      .join('\n')
    for (const sentinel of [ARGUMENT_SENTINEL, IMAGE_SENTINEL, IMAGE_SENTINEL_BASE64]) {
      assert.equal(agentToClientWire.includes(sentinel), false)
    }
    const persistedSession = await readMappedSession(fixture, session.sessionId)
    assert.equal(persistedSession.includes(ARGUMENT_SENTINEL), false)
    assert.equal(persistedSession.includes(IMAGE_SENTINEL), false)
    assert.equal(persistedSession.includes(IMAGE_SENTINEL_BASE64), false)

    const liveResponse = await fixture.client.prompt(
      {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: '/session' }]
      },
      { timeoutMs: PROMPT_TIMEOUT_MS }
    )
    assert.deepEqual(liveResponse, { stopReason: 'end_turn' })
    assert.equal(fixture.client.retainedSessionUpdateCount, updatesBeforeRefusals + 1)
    assert.equal(promptRequests(fixture.client.transcript()).length, UNSUPPORTED_PI_BUILTINS.length + 1)
    assert.deepEqual(fixture.requests, [])
    await assertPathMissing(fixture.shutdownReceiptPath)
    assert.equal(isProcessRunning(receipt.piPid), true)

    await fixture.closeLoopback()
    assert.deepEqual(fixture.requests, [])
    const exit = await fixture.client.close()
    assert.deepEqual({ code: exit.code, signal: exit.signal }, { code: 0, signal: null })
    await waitForProcessExit(receipt.piPid, 5_000)
    await waitForProcessExit(adapterPid, 5_000)
    const { receipt: shutdownReceipt } = await fixture.readShutdownReceipt()
    assert.equal(shutdownReceipt.piPid, receipt.piPid)
    for (const sentinel of [ARGUMENT_SENTINEL, IMAGE_SENTINEL, IMAGE_SENTINEL_BASE64]) {
      assert.equal(exit.stderrTail.includes(sentinel), false)
    }
    await fixture.assertWithinHardDeadline()
  }
)
