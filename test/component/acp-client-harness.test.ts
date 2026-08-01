import { PROTOCOL_VERSION, type SessionNotification } from '@agentclientprotocol/sdk'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  AcpClientLifecycleError,
  AcpOperationTimeoutError,
  AcpMalformedMessageError,
  AcpProcessClient,
  AcpProcessExitError,
  AcpTransportClosedError,
  AcpUpdateTimeoutError,
  type AcpProcessClientOptions
} from '../helpers/acp-process-client.js'
import {
  CatalogTransportClosedError,
  CatalogWaitTimeoutError,
  CommandNotAdvertisedError,
  StrictCatalogClient
} from '../helpers/strict-catalog-client.js'

const fixturePath = fileURLToPath(new URL('../fixtures/acp/catalog-agent.mjs', import.meta.url))
const TEST_TIMEOUT_MS = 10_000

type FixtureOptions = {
  mode?:
    | 'default'
    | 'no-catalog'
    | 'hang-prompt'
    | 'timeout-race'
    | 'exit-on-prompt'
    | 'close-output-on-prompt'
    | 'malformed-primitive'
    | 'malformed-null'
    | 'malformed-array'
    | 'malformed-response'
    | 'malformed-error-object'
  fragmentBytes?: number
  client?: Partial<
    Pick<
      AcpProcessClientOptions,
      'requestTimeoutMs' | 'updateTimeoutMs' | 'shutdownTimeoutMs' | 'stderrLimitBytes' | 'clientBehavior'
    >
  >
}

function isolatedFixtureEnvironment(fragmentBytes: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ACP_FIXTURE_FRAGMENT_BYTES: String(fragmentBytes)
  }
  for (const name of ['SYSTEMROOT', 'WINDIR', 'ComSpec', 'PATHEXT']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  return env
}

async function startFixture(options: FixtureOptions = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'pi-acp-client-harness-'))
  let client: AcpProcessClient
  try {
    client = new AcpProcessClient({
      command: process.execPath,
      args: [fixturePath, `--mode=${options.mode ?? 'default'}`],
      cwd,
      env: isolatedFixtureEnvironment(options.fragmentBytes ?? 0),
      requestTimeoutMs: options.client?.requestTimeoutMs,
      updateTimeoutMs: options.client?.updateTimeoutMs,
      shutdownTimeoutMs: options.client?.shutdownTimeoutMs,
      stderrLimitBytes: options.client?.stderrLimitBytes,
      clientBehavior: options.client?.clientBehavior,
      transcriptMetadata: {
        planId: 'PACP-CMD-2026-01',
        checkpoint: 'C0.5',
        fixtureId: 'sdk-catalog-agent-v1'
      }
    })
  } catch (error) {
    await rm(cwd, { recursive: true, force: true })
    throw error
  }

  return {
    client,
    cwd,
    async cleanup() {
      try {
        await client.close()
      } finally {
        await rm(cwd, { recursive: true, force: true })
      }
    }
  }
}

async function initializeSession(client: AcpProcessClient, cwd: string): Promise<string> {
  const initialized = await client.initialize()
  assert.equal(initialized.protocolVersion, PROTOCOL_VERSION)
  const session = await client.newSession({ cwd, mcpServers: [] })
  return session.sessionId
}

function isCatalogUpdate(notification: SessionNotification): boolean {
  return notification.update.sessionUpdate === 'available_commands_update'
}

function outboundPromptCount(client: AcpProcessClient): number {
  return outboundPromptParams(client).length
}

function outboundPromptParams(client: AcpProcessClient): unknown[] {
  return client.transcript().flatMap(entry => {
    if (
      entry.kind !== 'message' ||
      entry.direction !== 'client_to_agent' ||
      !('method' in entry.message) ||
      entry.message.method !== 'session/prompt' ||
      !('params' in entry.message)
    ) {
      return []
    }
    return [entry.message.params]
  })
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

test(
  'raw process client handles fragmented NDJSON and records structured transcripts',
  { timeout: TEST_TIMEOUT_MS },
  async t => {
    const previousParentMarker = process.env.ACP_HARNESS_PARENT_MARKER
    process.env.ACP_HARNESS_PARENT_MARKER = 'parent-only-credential-marker'
    t.after(() => {
      if (previousParentMarker === undefined) delete process.env.ACP_HARNESS_PARENT_MARKER
      else process.env.ACP_HARNESS_PARENT_MARKER = previousParentMarker
    })
    const fixture = await startFixture({ fragmentBytes: 2 })
    t.after(fixture.cleanup)
    assert.throws(
      () =>
        new AcpProcessClient({
          command: process.execPath,
          args: [fixturePath],
          cwd: fixture.cwd
        } as unknown as AcpProcessClientOptions),
      /env must be an explicitly supplied plain object/
    )
    assert.throws(
      () =>
        new AcpProcessClient({
          command: process.execPath,
          args: [fixturePath],
          cwd: fixture.cwd,
          env: undefined
        } as unknown as AcpProcessClientOptions),
      /env must be an explicitly supplied plain object/
    )
    assert.throws(
      () =>
        new AcpProcessClient({
          command: process.execPath,
          args: [fixturePath],
          cwd: fixture.cwd,
          env: new (class FixtureEnvironment {})()
        } as unknown as AcpProcessClientOptions),
      /env must be an explicitly supplied plain object/
    )
    assert.throws(
      () =>
        new AcpProcessClient({
          command: process.execPath,
          args: [fixturePath],
          cwd: fixture.cwd,
          env: {},
          transcriptMetadata: { invalid: 1n } as never
        }),
      /must be JSON-safe/
    )
    const cyclicMetadata: Record<string, unknown> = {}
    cyclicMetadata.self = cyclicMetadata
    assert.throws(
      () =>
        new AcpProcessClient({
          command: process.execPath,
          args: [fixturePath],
          cwd: fixture.cwd,
          env: {},
          transcriptMetadata: cyclicMetadata as never
        }),
      /must not contain cycles/
    )
    const missingProcess = new AcpProcessClient({
      command: join(fixture.cwd, 'missing-acp-executable'),
      cwd: fixture.cwd,
      env: isolatedFixtureEnvironment(0),
      transcriptMetadata: JSON.parse('{"z":1,"__proto__":{"marker":true}}')
    })
    t.after(() => missingProcess.close().catch(() => undefined))
    const missingProcessMeta = missingProcess.transcript()[0]
    assert.equal(missingProcessMeta.kind, 'meta')
    if (missingProcessMeta.kind === 'meta') {
      assert.equal(Object.hasOwn(missingProcessMeta.metadata, '__proto__'), true)
      assert.deepEqual(missingProcessMeta.metadata, JSON.parse('{"__proto__":{"marker":true},"z":1}'))
    }
    assert.match(missingProcess.transcriptNdjson(), /"__proto__":\{"marker":true\}/)
    await assert.rejects(missingProcess.initialize(), (error: unknown) => {
      assert.ok(error instanceof AcpProcessExitError)
      assert.match(error.exit.spawnError ?? '', /ENOENT/)
      return true
    })
    await missingProcess.closed

    const sessionId = await initializeSession(fixture.client, fixture.cwd)
    const catalog = await fixture.client.waitForSessionUpdate(isCatalogUpdate)
    assert.equal(catalog.sessionId, sessionId)
    assert.deepEqual(
      catalog.update.sessionUpdate === 'available_commands_update'
        ? catalog.update.availableCommands.map(command => command.name)
        : [],
      ['alpha']
    )
    await assert.rejects(
      fixture.client.waitForSessionUpdate(() => true, {
        afterIndex: fixture.client.retainedSessionUpdateCount + 1
      }),
      /exceeds retained session update count/
    )
    await assert.rejects(
      fixture.client.waitForSessionUpdate(notification => {
        if (notification.update.sessionUpdate === 'available_commands_update') {
          notification.update.availableCommands[0].name = 'corrupted-by-predicate'
        }
        throw new Error('cached predicate failure')
      }),
      /cached predicate failure/
    )
    const retainedCatalog = await fixture.client.waitForSessionUpdate(isCatalogUpdate)
    assert.deepEqual(
      retainedCatalog.update.sessionUpdate === 'available_commands_update'
        ? retainedCatalog.update.availableCommands.map(command => command.name)
        : [],
      ['alpha']
    )

    const updateIndex = fixture.client.retainedSessionUpdateCount
    const promptText = '/alpha 你好 👩‍💻'
    const response = await fixture.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: promptText }]
    })
    assert.equal(response.stopReason, 'end_turn')
    const echo = await fixture.client.waitForSessionUpdate(
      notification => notification.update.sessionUpdate === 'agent_message_chunk',
      { afterIndex: updateIndex }
    )
    assert.equal(
      echo.update.sessionUpdate === 'agent_message_chunk' && echo.update.content.type === 'text'
        ? echo.update.content.text
        : undefined,
      `fixture echo: ${promptText}`
    )

    const transcript = fixture.client.transcript()
    assert.deepEqual(transcript[0], {
      kind: 'meta',
      schemaVersion: 1,
      protocolVersion: 1,
      sdkVersion: '0.26.0',
      nodeVersion: process.versions.node,
      clientBehavior: 'raw',
      metadata: {
        planId: 'PACP-CMD-2026-01',
        checkpoint: 'C0.5',
        fixtureId: 'sdk-catalog-agent-v1'
      }
    })
    const outboundMethods = transcript.flatMap(entry => {
      if (entry.kind !== 'message' || entry.direction !== 'client_to_agent' || !('method' in entry.message)) return []
      return [entry.message.method]
    })
    assert.deepEqual(outboundMethods, ['initialize', 'session/new', 'session/prompt'])

    const serialized = fixture.client.transcriptNdjson()
    const parsedLines = serialized
      .trimEnd()
      .split('\n')
      .map(line => JSON.parse(line))
    assert.deepEqual(parsedLines, transcript)
    assert.equal(serialized.includes('"timestamp"'), false)
    assert.equal(serialized.includes('"pid"'), false)
    assert.equal(serialized.includes('"env"'), false)
    const exit = await fixture.client.close()
    assert.equal(exit.stderrTail.includes('parent-only-credential-marker'), false)
  }
)

test('completed operations do not amplify bounded close work', { timeout: 20_000 }, async t => {
  const fixture = await startFixture({
    client: {
      requestTimeoutMs: 5_000,
      shutdownTimeoutMs: 250
    }
  })
  t.after(fixture.cleanup)

  await initializeSession(fixture.client, fixture.cwd)
  const padding = 'x'.repeat(384)
  for (let sequence = 0; sequence < 1_500; sequence += 1) {
    const result = await fixture.client.extMethod('test/ping', { sequence, padding })
    assert.equal(result.sequence, sequence)
  }

  const transcriptBytes = Buffer.byteLength(fixture.client.transcriptNdjson())
  assert.ok(transcriptBytes > 500_000, `expected a substantial transcript, received ${String(transcriptBytes)} bytes`)
  const closeStartedAt = performance.now()
  await fixture.client.close()
  const closeDurationMs = performance.now() - closeStartedAt
  assert.ok(closeDurationMs < 3_000, `close took ${closeDurationMs.toFixed(1)}ms after completed operations`)
})

test('live update fanout snapshots reentrant strict subscribers', { timeout: TEST_TIMEOUT_MS }, async t => {
  const fixture = await startFixture({ client: { clientBehavior: 'strict' } })
  t.after(fixture.cleanup)

  let strict: StrictCatalogClient | undefined
  const unsubscribe = fixture.client.subscribeSessionUpdates(notification => {
    if (notification.update.sessionUpdate === 'available_commands_update' && strict === undefined) {
      strict = new StrictCatalogClient(fixture.client, 500)
    }
  }, false)
  t.after(unsubscribe)
  t.after(() => strict?.dispose())

  const sessionId = await initializeSession(fixture.client, fixture.cwd)
  await fixture.client.waitForSessionUpdate(isCatalogUpdate)
  assert.ok(strict)
  assert.equal(strict.catalog(sessionId)?.revision, 1)

  await fixture.client.extMethod('test/set_catalog', { sessionId, names: ['beta'] })
  const replacement = await strict.waitForCatalog(sessionId, { afterRevision: 1 })
  assert.equal(replacement.revision, 2)
  assert.deepEqual(
    replacement.commands.map(command => command.name),
    ['beta']
  )
})

test('malformed JSON-RPC envelopes fail closed without reaching the SDK', { timeout: TEST_TIMEOUT_MS }, async () => {
  const cases: Array<{
    mode: NonNullable<FixtureOptions['mode']>
    receivedKind: string
    reason: RegExp
  }> = [
    { mode: 'malformed-primitive', receivedKind: 'number', reason: /expected a JSON object envelope/ },
    { mode: 'malformed-null', receivedKind: 'null', reason: /expected a JSON object envelope/ },
    { mode: 'malformed-array', receivedKind: 'array', reason: /expected a JSON object envelope/ },
    { mode: 'malformed-response', receivedKind: 'object', reason: /jsonrpc must equal "2\.0"/ },
    { mode: 'malformed-error-object', receivedKind: 'object', reason: /response error must be a JSON object/ }
  ]

  for (const malformedCase of cases) {
    const fixture = await startFixture({
      mode: malformedCase.mode,
      client: {
        requestTimeoutMs: 2_000,
        shutdownTimeoutMs: 250
      }
    })
    try {
      await assert.rejects(fixture.client.initialize(), (error: unknown) => {
        assert.ok(error instanceof AcpMalformedMessageError)
        assert.equal(error.code, 'ACP_MALFORMED_MESSAGE')
        assert.equal(error.receivedKind, malformedCase.receivedKind)
        assert.match(error.reason, malformedCase.reason)
        assert.equal(error.teardownError, undefined)
        assert.match(error.transcript, /"kind":"process_exit"/)
        if (process.platform !== 'win32') assert.equal(error.exit?.signal, 'SIGKILL')
        return true
      })
      await fixture.client.closed
      assert.equal(
        fixture.client.transcript().some(entry => entry.kind === 'message' && entry.direction === 'agent_to_client'),
        false
      )
    } finally {
      await fixture.cleanup()
    }
  }

  const cyclicPayload: Record<string, unknown> = {}
  cyclicPayload.self = cyclicPayload
  const outgoingCases: Array<{ payload: unknown; reason: RegExp }> = [
    { payload: { sequence: 1n }, reason: /must be JSON-safe/ },
    { payload: cyclicPayload, reason: /must not contain cycles/ }
  ]

  for (const outgoingCase of outgoingCases) {
    const fixture = await startFixture({
      client: {
        requestTimeoutMs: 2_000,
        shutdownTimeoutMs: 250
      }
    })
    try {
      await fixture.client.initialize()
      await assert.rejects(
        fixture.client.extMethod('test/ping', {
          payload: outgoingCase.payload
        }),
        (error: unknown) => {
          assert.ok(error instanceof AcpMalformedMessageError)
          assert.equal(error.code, 'ACP_MALFORMED_MESSAGE')
          assert.equal(error.receivedKind, 'object')
          assert.match(error.reason, outgoingCase.reason)
          assert.equal(error.teardownError, undefined)
          assert.match(error.transcript, /"kind":"process_exit"/)
          return true
        }
      )
      await fixture.client.closed
      assert.doesNotThrow(() => fixture.client.transcriptNdjson())
      assert.equal(
        fixture.client.transcript().some(entry => {
          return (
            entry.kind === 'message' &&
            entry.direction === 'client_to_agent' &&
            'method' in entry.message &&
            entry.message.method === 'test/ping'
          )
        }),
        false
      )
    } finally {
      await fixture.cleanup()
    }
  }
})

test(
  'strict client atomically replaces catalogs and never writes refused commands',
  { timeout: TEST_TIMEOUT_MS },
  async t => {
    const fixture = await startFixture({ client: { clientBehavior: 'strict' } })
    t.after(fixture.cleanup)

    const sessionId = await initializeSession(fixture.client, fixture.cwd)
    await fixture.client.waitForSessionUpdate(isCatalogUpdate)
    let throwingObserverCalls = 0
    const unsubscribeThrowingObserver = fixture.client.subscribeSessionUpdates(notification => {
      if (notification.sessionId !== sessionId || notification.update.sessionUpdate !== 'available_commands_update')
        return
      throwingObserverCalls += 1
      return Promise.reject(new Error('async diagnostic observer failure'))
    }, false)
    t.after(unsubscribeThrowingObserver)
    const strict = new StrictCatalogClient(fixture.client, 500)
    t.after(() => strict.dispose())
    const initial = await strict.waitForCatalog(sessionId)
    assert.equal(initial.revision, 1)
    assert.deepEqual(
      initial.commands.map(command => command.name),
      ['alpha']
    )

    const first = await strict.promptCommand({ sessionId, name: '/alpha', input: 'one' })
    assert.equal(first.stopReason, 'end_turn')
    assert.equal(outboundPromptCount(fixture.client), 1)
    assert.deepEqual(outboundPromptParams(fixture.client), [
      {
        sessionId,
        prompt: [{ type: 'text', text: '/alpha one' }]
      }
    ])

    const secondSession = await fixture.client.newSession({ cwd: fixture.cwd, mcpServers: [] })
    const secondSessionCatalog = await strict.waitForCatalog(secondSession.sessionId)
    assert.equal(secondSessionCatalog.revision, 1)
    assert.deepEqual(
      secondSessionCatalog.commands.map(command => command.name),
      ['alpha']
    )

    const beforeUnknown = outboundPromptCount(fixture.client)
    await assert.rejects(strict.promptCommand({ sessionId, name: 'missing' }), (error: unknown) => {
      assert.ok(error instanceof CommandNotAdvertisedError)
      assert.deepEqual(error.advertisedNames, ['alpha'])
      return true
    })
    assert.equal(outboundPromptCount(fixture.client), beforeUnknown)

    const livePredicateFailure = assert.rejects(
      fixture.client.waitForSessionUpdate(
        notification => {
          if (notification.update.sessionUpdate === 'available_commands_update') {
            throw new Error('live predicate failure')
          }
          return false
        },
        { afterIndex: fixture.client.retainedSessionUpdateCount }
      ),
      /live predicate failure/
    )
    await fixture.client.extMethod('test/set_catalog', { sessionId, names: ['beta'] })
    await livePredicateFailure
    const replacement = await strict.waitForCatalog(sessionId, { afterRevision: initial.revision })
    assert.equal(replacement.revision, 2)
    assert.equal(throwingObserverCalls, 1)
    assert.deepEqual(
      replacement.commands.map(command => command.name),
      ['beta']
    )
    assert.deepEqual(
      strict.catalog(secondSession.sessionId)?.commands.map(command => command.name),
      ['alpha']
    )
    await assert.rejects(strict.promptCommand({ sessionId, name: 'alpha' }), CommandNotAdvertisedError)
    assert.equal(outboundPromptCount(fixture.client), beforeUnknown)

    const second = await strict.promptCommand({ sessionId, name: 'beta' })
    assert.equal(second.stopReason, 'end_turn')
    assert.equal(outboundPromptCount(fixture.client), 2)

    await fixture.client.extMethod('test/set_catalog', { sessionId, names: [] })
    const empty = await strict.waitForCatalog(sessionId, { afterRevision: replacement.revision })
    assert.equal(empty.revision, 3)
    assert.equal(throwingObserverCalls, 2)
    assert.deepEqual(empty.commands, [])
    await assert.rejects(strict.promptCommand({ sessionId, name: 'beta' }), CommandNotAdvertisedError)
    assert.equal(outboundPromptCount(fixture.client), 2)
  }
)

test('raw and strict catalog waits have hard timeouts', { timeout: TEST_TIMEOUT_MS }, async t => {
  const fixture = await startFixture({
    mode: 'no-catalog',
    client: {
      updateTimeoutMs: 50,
      clientBehavior: 'strict'
    }
  })
  const strict = new StrictCatalogClient(fixture.client, 50)
  t.after(async () => {
    strict.dispose()
    await fixture.cleanup()
  })

  const sessionId = await initializeSession(fixture.client, fixture.cwd)
  await assert.rejects(fixture.client.waitForSessionUpdate(isCatalogUpdate), AcpUpdateTimeoutError)
  const outboundBeforeRefusal = fixture.client
    .transcript()
    .filter(entry => entry.kind === 'message' && entry.direction === 'client_to_agent')
  await assert.rejects(strict.promptCommand({ sessionId, name: 'alpha' }), (error: unknown) => {
    assert.ok(error instanceof CatalogWaitTimeoutError)
    assert.match(error.transcript, /"method":"session\/new"/)
    return true
  })
  assert.deepEqual(
    fixture.client.transcript().filter(entry => entry.kind === 'message' && entry.direction === 'client_to_agent'),
    outboundBeforeRefusal
  )
  assert.equal(fixture.client.isRunning, true)
})

test('prompt timeout tears down the process and close remains idempotent', { timeout: TEST_TIMEOUT_MS }, async t => {
  const fixture = await startFixture({
    mode: 'hang-prompt',
    client: {
      requestTimeoutMs: 2_000,
      shutdownTimeoutMs: 50
    }
  })
  t.after(fixture.cleanup)

  const sessionId = await initializeSession(fixture.client, fixture.cwd)
  const descendantPid =
    process.platform === 'win32'
      ? undefined
      : Number.parseInt(await readFile(join(fixture.cwd, 'descendant.pid'), 'utf8'), 10)
  const cancelledPrompt = fixture.client.prompt({
    sessionId,
    prompt: [{ type: 'text', text: '/alpha cancel' }]
  })
  await fixture.client.cancel({ sessionId })
  assert.equal((await cancelledPrompt).stopReason, 'cancelled')
  assert.equal(fixture.client.isRunning, true)

  await assert.rejects(
    fixture.client.prompt(
      {
        sessionId,
        prompt: [{ type: 'text', text: '/alpha hang' }]
      },
      { timeoutMs: 500 }
    ),
    (error: unknown) => {
      assert.ok(error instanceof AcpOperationTimeoutError)
      assert.equal(error.operation, 'session/prompt')
      assert.equal(error.teardownError, undefined)
      assert.match(error.transcript, /"method":"session\/prompt"/)
      assert.match(error.transcript, /"kind":"process_exit"/)
      return true
    }
  )

  const firstExit = await fixture.client.closed
  const secondExit = await fixture.client.close()
  assert.deepEqual(secondExit, firstExit)
  assert.equal(fixture.client.isRunning, false)
  assert.equal(fixture.client.transcript().at(-1)?.kind, 'process_exit')
  assert.equal(fixture.client.transcript().filter(entry => entry.kind === 'process_exit').length, 1)
  if (descendantPid !== undefined) {
    assert.equal(firstExit.signal, 'SIGKILL')
    assert.equal(isProcessRunning(descendantPid), false)
  }
})

test('fatal prompt timeout rejects concurrent work and quarantines late updates', { timeout: 15_000 }, async t => {
  const fixture = await startFixture({
    mode: 'timeout-race',
    client: {
      requestTimeoutMs: 8_000,
      updateTimeoutMs: 8_000,
      shutdownTimeoutMs: 500,
      clientBehavior: 'strict'
    }
  })
  t.after(fixture.cleanup)

  await fixture.client.initialize()
  const sessionA = await fixture.client.newSession({ cwd: fixture.cwd, mcpServers: [] })
  const sessionB = await fixture.client.newSession({ cwd: fixture.cwd, mcpServers: [] })
  await fixture.client.waitForSessionUpdate(
    notification => isCatalogUpdate(notification) && notification.sessionId === sessionA.sessionId
  )
  await fixture.client.waitForSessionUpdate(
    notification => isCatalogUpdate(notification) && notification.sessionId === sessionB.sessionId
  )

  const strict = new StrictCatalogClient(fixture.client, 8_000)
  t.after(() => strict.dispose())
  assert.deepEqual(
    (await strict.waitForCatalog(sessionB.sessionId)).commands.map(command => command.name),
    ['alpha']
  )
  let closedSettled = false
  void fixture.client.closed.then(
    () => {
      closedSettled = true
    },
    () => {
      closedSettled = true
    }
  )

  let lateObserverCalls = 0
  const unsubscribe = fixture.client.subscribeSessionUpdates(notification => {
    if (
      notification.sessionId === sessionB.sessionId &&
      notification.update.sessionUpdate === 'available_commands_update' &&
      notification.update.availableCommands.some(command => command.name === 'late-poison')
    ) {
      lateObserverCalls += 1
    }
  }, false)
  t.after(unsubscribe)

  const beforePrompts = fixture.client.retainedSessionUpdateCount
  const armedB = fixture.client.waitForSessionUpdate(
    notification =>
      notification.sessionId === sessionB.sessionId &&
      notification.update.sessionUpdate === 'agent_message_chunk' &&
      notification.update.content.type === 'text' &&
      notification.update.content.text === 'armed:fixture-late-b',
    { afterIndex: beforePrompts, timeoutMs: 8_000 }
  )
  const concurrentPrompt = fixture.client.prompt(
    {
      sessionId: sessionB.sessionId,
      prompt: [{ type: 'text', text: 'fixture-late-b' }]
    },
    { timeoutMs: 8_000 }
  )
  const concurrentAssertion = assert.rejects(concurrentPrompt, (error: unknown) => {
    assert.ok(error instanceof AcpClientLifecycleError)
    assert.equal(error.code, 'ACP_CLIENT_FATAL')
    assert.equal(error.operation, 'session/prompt')
    assert.ok(error.fatalReason instanceof AcpOperationTimeoutError)
    return true
  })

  await armedB
  const retainedBeforeFatalBoundary = fixture.client.retainedSessionUpdateCount
  const lateCatalog = fixture.client.waitForSessionUpdate(
    notification =>
      notification.sessionId === sessionB.sessionId &&
      notification.update.sessionUpdate === 'available_commands_update' &&
      notification.update.availableCommands.some(command => command.name === 'late-poison'),
    { afterIndex: retainedBeforeFatalBoundary, timeoutMs: 8_000 }
  )
  const lateCatalogAssertion = assert.rejects(lateCatalog, (error: unknown) => {
    assert.ok(error instanceof AcpClientLifecycleError)
    assert.equal(error.operation, 'session/update')
    assert.ok(error.fatalReason instanceof AcpOperationTimeoutError)
    return true
  })
  const pendingStrictCatalog = strict.waitForCatalog(sessionB.sessionId, {
    afterRevision: 1,
    timeoutMs: 8_000
  })
  const pendingStrictCatalogAssertion = assert.rejects(pendingStrictCatalog, (error: unknown) => {
    assert.ok(error instanceof CatalogTransportClosedError)
    assert.equal(error.exit, undefined)
    assert.ok(error.cause instanceof AcpOperationTimeoutError)
    assert.equal(error.cause.operation, 'session/prompt')
    assert.equal(error.cause.timeoutMs, 1_000)
    assert.equal(error.transcript.includes('"kind":"process_exit"'), false)
    return true
  })
  const timedOutPrompt = fixture.client.prompt(
    {
      sessionId: sessionA.sessionId,
      prompt: [{ type: 'text', text: 'fixture-timeout-a' }]
    },
    { timeoutMs: 1_000 }
  )
  const timedOutAssertion = assert.rejects(timedOutPrompt, (error: unknown) => {
    assert.ok(error instanceof AcpOperationTimeoutError)
    assert.equal(error.operation, 'session/prompt')
    assert.equal(error.timeoutMs, 1_000)
    assert.equal(error.teardownError, undefined)
    assert.match(error.transcript, /"kind":"process_exit"/)
    return true
  })

  await Promise.all([concurrentAssertion, lateCatalogAssertion, pendingStrictCatalogAssertion])
  assert.equal(fixture.client.isRunning, false)
  assert.equal(closedSettled, false)
  assert.equal(
    fixture.client.transcript().some(entry => entry.kind === 'process_exit'),
    false
  )
  assert.deepEqual(
    strict.catalog(sessionB.sessionId)?.commands.map(command => command.name),
    ['alpha']
  )
  assert.equal(strict.catalog(sessionB.sessionId)?.revision, 1)

  const replayedStrict = new StrictCatalogClient(fixture.client, 8_000)
  try {
    assert.deepEqual(
      (await replayedStrict.waitForCatalog(sessionB.sessionId)).commands.map(command => command.name),
      ['alpha']
    )
    await assert.rejects(
      replayedStrict.waitForCatalog(sessionB.sessionId, {
        afterRevision: 1,
        timeoutMs: 8_000
      }),
      (error: unknown) => {
        assert.ok(error instanceof CatalogTransportClosedError)
        assert.equal(error.exit, undefined)
        assert.ok(error.cause instanceof AcpOperationTimeoutError)
        assert.equal(error.cause.operation, 'session/prompt')
        assert.equal(error.cause.timeoutMs, 1_000)
        assert.equal(error.transcript.includes('"kind":"process_exit"'), false)
        return true
      }
    )
    const promptCountAtFatalBoundary = outboundPromptCount(fixture.client)
    await assert.rejects(
      replayedStrict.promptCommand({ sessionId: sessionB.sessionId, name: 'alpha' }),
      CatalogTransportClosedError
    )
    assert.equal(outboundPromptCount(fixture.client), promptCountAtFatalBoundary)
  } finally {
    replayedStrict.dispose()
  }
  assert.equal(closedSettled, false)
  await timedOutAssertion
  const exit = await fixture.client.closed
  assert.equal(closedSettled, true)

  assert.equal(lateObserverCalls, 0)
  assert.equal(fixture.client.retainedSessionUpdateCount, retainedBeforeFatalBoundary)
  assert.deepEqual(
    strict.catalog(sessionB.sessionId)?.commands.map(command => command.name),
    ['alpha']
  )
  assert.equal(strict.catalog(sessionB.sessionId)?.revision, 1)

  await assert.rejects(
    fixture.client.waitForSessionUpdate(
      notification =>
        notification.update.sessionUpdate === 'available_commands_update' &&
        notification.update.availableCommands.some(command => command.name === 'late-poison'),
      { afterIndex: retainedBeforeFatalBoundary }
    ),
    AcpClientLifecycleError
  )

  const transcript = fixture.client.transcript()
  const lateWireUpdates = transcript.filter(entry => {
    if (
      entry.kind !== 'message' ||
      entry.direction !== 'agent_to_client' ||
      !('method' in entry.message) ||
      entry.message.method !== 'session/update' ||
      !('params' in entry.message)
    ) {
      return false
    }
    return JSON.stringify(entry.message.params).includes('late-poison')
  })
  assert.equal(lateWireUpdates.length, 1)

  const lateRequest = transcript.find(entry => {
    if (
      entry.kind !== 'message' ||
      entry.direction !== 'client_to_agent' ||
      !('method' in entry.message) ||
      entry.message.method !== 'session/prompt' ||
      !('params' in entry.message)
    ) {
      return false
    }
    return JSON.stringify(entry.message.params).includes(sessionB.sessionId)
  })
  assert.ok(lateRequest?.kind === 'message' && 'id' in lateRequest.message)
  const lateRequestId = lateRequest.message.id
  const lateResponses = transcript.filter(
    entry =>
      entry.kind === 'message' &&
      entry.direction === 'agent_to_client' &&
      'id' in entry.message &&
      entry.message.id === lateRequestId &&
      'result' in entry.message
  )
  assert.equal(lateResponses.length, 1)
  assert.match(JSON.stringify(lateResponses[0]), /"stopReason":"end_turn"/)
  assert.match(exit.stderrTail, /TIMEOUT-RACE-EOF/)
  if (process.platform !== 'win32') assert.equal(exit.signal, 'SIGKILL')
  assert.equal(transcript.at(-1)?.kind, 'process_exit')
})

test('early child exit reports code and bounded stderr diagnostics', { timeout: TEST_TIMEOUT_MS }, async t => {
  const fixture = await startFixture({
    mode: 'exit-on-prompt',
    client: {
      requestTimeoutMs: 3_000,
      shutdownTimeoutMs: 100,
      stderrLimitBytes: 1_024
    }
  })
  t.after(fixture.cleanup)

  const sessionId = await initializeSession(fixture.client, fixture.cwd)
  const strict = new StrictCatalogClient(fixture.client, 2_000)
  t.after(() => strict.dispose())
  const strictTransportExit = assert.rejects(strict.waitForCatalog('future-session'), (error: unknown) => {
    assert.ok(error instanceof CatalogTransportClosedError)
    assert.equal(error.exit, undefined)
    assert.ok(error.cause instanceof Error)
    assert.equal(error.transcript.includes('"kind":"process_exit"'), false)
    return true
  })
  const updateExit = assert.rejects(
    fixture.client.waitForSessionUpdate(() => false, {
      afterIndex: fixture.client.retainedSessionUpdateCount,
      timeoutMs: 2_000
    }),
    (error: unknown) => {
      assert.ok(error instanceof AcpTransportClosedError)
      assert.equal(error.operation, 'session/update')
      assert.ok(error.cause instanceof Error)
      assert.equal(error.transcript.includes('"kind":"process_exit"'), false)
      return true
    }
  )
  await assert.rejects(
    fixture.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: '/alpha exit' }]
    }),
    (error: unknown) => {
      assert.ok(error instanceof AcpProcessExitError)
      assert.equal(error.operation, 'session/prompt')
      assert.equal(error.exit.code, 17)
      assert.equal(error.exit.signal, null)
      assert.ok(Buffer.byteLength(error.exit.stderrTail) <= 1_024)
      assert.match(error.exit.stderrTail, /TAIL-MARKER/)
      return true
    }
  )
  await updateExit
  await strictTransportExit

  const exit = await fixture.client.closed
  assert.equal(exit.code, 17)
  assert.equal(fixture.client.isRunning, false)
})

test('transport EOF waits for bounded teardown and preserves the final exit', { timeout: TEST_TIMEOUT_MS }, async t => {
  const fixture = await startFixture({
    mode: 'close-output-on-prompt',
    client: {
      requestTimeoutMs: 2_000,
      shutdownTimeoutMs: 500
    }
  })
  t.after(fixture.cleanup)

  const sessionId = await initializeSession(fixture.client, fixture.cwd)
  const strict = new StrictCatalogClient(fixture.client, 2_000)
  t.after(() => strict.dispose())
  assert.deepEqual(
    (await strict.waitForCatalog(sessionId)).commands.map(command => command.name),
    ['alpha']
  )

  let closedSettled = false
  void fixture.client.closed.then(
    () => {
      closedSettled = true
    },
    () => {
      closedSettled = true
    }
  )
  let pendingStrictCause: unknown
  const pendingStrictCatalogAssertion = assert.rejects(
    strict.waitForCatalog(sessionId, { afterRevision: 1, timeoutMs: 2_000 }),
    (error: unknown) => {
      assert.ok(error instanceof CatalogTransportClosedError)
      assert.equal(error.exit, undefined)
      assert.ok(error.cause instanceof Error)
      pendingStrictCause = error.cause
      assert.equal(error.transcript.includes('"kind":"process_exit"'), false)
      return true
    }
  )
  let pendingRawCause: unknown
  const pendingRawUpdateAssertion = assert.rejects(
    fixture.client.waitForSessionUpdate(() => false, {
      afterIndex: fixture.client.retainedSessionUpdateCount,
      timeoutMs: 2_000
    }),
    (error: unknown) => {
      assert.ok(error instanceof AcpTransportClosedError)
      assert.equal(error.code, 'ACP_TRANSPORT_CLOSED')
      assert.equal(error.operation, 'session/update')
      assert.ok(error.cause instanceof Error)
      pendingRawCause = error.cause
      assert.equal(error.transcript.includes('"kind":"process_exit"'), false)
      return true
    }
  )
  const promptAssertion = assert.rejects(
    fixture.client.prompt(
      {
        sessionId,
        prompt: [{ type: 'text', text: '/alpha close-output' }]
      },
      { timeoutMs: 50 }
    ),
    (error: unknown) => {
      assert.ok(error instanceof AcpProcessExitError)
      assert.equal(error.operation, 'session/prompt')
      assert.match(error.exit.stderrTail, /OUTPUT-CLOSED-MARKER/)
      if (process.platform !== 'win32') assert.equal(error.exit.signal, 'SIGKILL')
      return true
    }
  )

  await Promise.all([pendingStrictCatalogAssertion, pendingRawUpdateAssertion])
  const terminalReason = fixture.client.terminalLifecycleSignal.reason
  assert.ok(terminalReason instanceof Error)
  assert.strictEqual(pendingStrictCause, terminalReason)
  assert.strictEqual(pendingRawCause, terminalReason)
  assert.equal(fixture.client.isRunning, false)
  assert.equal(closedSettled, false)
  assert.equal(
    fixture.client.transcript().some(entry => entry.kind === 'process_exit'),
    false
  )

  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(fixture.client.fatalLifecycleSignal.aborted, false)
  assert.equal(closedSettled, false)
  assert.equal(
    fixture.client.transcript().some(entry => entry.kind === 'process_exit'),
    false
  )

  const replayedStrict = new StrictCatalogClient(fixture.client, 2_000)
  try {
    assert.deepEqual(
      (await replayedStrict.waitForCatalog(sessionId)).commands.map(command => command.name),
      ['alpha']
    )
    await assert.rejects(
      replayedStrict.waitForCatalog(sessionId, { afterRevision: 1, timeoutMs: 2_000 }),
      (error: unknown) => {
        assert.ok(error instanceof CatalogTransportClosedError)
        assert.equal(error.exit, undefined)
        assert.ok(error.cause instanceof Error)
        assert.strictEqual(error.cause, terminalReason)
        assert.equal(error.transcript.includes('"kind":"process_exit"'), false)
        return true
      }
    )
  } finally {
    replayedStrict.dispose()
  }
  await assert.rejects(
    fixture.client.waitForSessionUpdate(() => false, {
      afterIndex: fixture.client.retainedSessionUpdateCount,
      timeoutMs: 2_000
    }),
    (error: unknown) => {
      assert.ok(error instanceof AcpTransportClosedError)
      assert.equal(error.code, 'ACP_TRANSPORT_CLOSED')
      assert.equal(error.operation, 'session/update')
      assert.ok(error.cause instanceof Error)
      assert.strictEqual(error.cause, terminalReason)
      assert.equal(error.transcript.includes('"kind":"process_exit"'), false)
      return true
    }
  )
  assert.equal(closedSettled, false)

  await promptAssertion
  await fixture.client.closed
  assert.equal(closedSettled, true)
})
