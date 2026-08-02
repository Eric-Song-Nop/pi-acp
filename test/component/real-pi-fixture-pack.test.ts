import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import assert from 'node:assert/strict'
import { lstat, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import test from 'node:test'
import { PROJECT_TRUST_WARNING } from '../../src/acp/agent.js'
import {
  FORBIDDEN_REAL_PI_ENV_NAMES,
  REAL_PI_FIXTURE_COMMAND_ID,
  REAL_PI_FIXTURE_ENV_NAMES,
  REAL_PI_FIXTURE_MODEL_ID,
  REAL_PI_FIXTURE_PROVIDER_ID,
  REAL_PI_VERSION,
  startRealPiFixture
} from '../helpers/real-pi-fixture.js'

const TEST_TIMEOUT_MS = 40_000

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

function outboundMethods(
  transcript: ReturnType<Awaited<ReturnType<typeof startRealPiFixture>>['client']['transcript']>
) {
  return transcript.flatMap(entry => {
    if (entry.kind !== 'message' || entry.direction !== 'client_to_agent' || !('method' in entry.message)) {
      return []
    }
    return [entry.message.method]
  })
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function projectTrustWarningCount(
  transcript: ReturnType<Awaited<ReturnType<typeof startRealPiFixture>>['client']['transcript']>
): number {
  return transcript.filter(entry => {
    if (entry.kind !== 'message' || entry.direction !== 'agent_to_client') return false
    const message = record(entry.message)
    if (message.method !== 'session/update') return false
    const update = record(record(message.params).update)
    const content = record(update.content)
    return (
      update.sessionUpdate === 'agent_message_chunk' &&
      content.type === 'text' &&
      content.text === `${PROJECT_TRUST_WARNING}\n`
    )
  }).length
}

async function readProjectCanaryPids(path: string): Promise<number[]> {
  const lines = (await readFile(path, 'utf8')).trim().split('\n')
  const pids = lines.map(line => Number(line))
  assert.equal(
    pids.every(pid => Number.isInteger(pid) && pid > 0),
    true
  )
  return pids
}

function assertProjectCanaryInvokedOncePerChild(actualPids: number[], expectedPids: number[]): void {
  assert.equal(new Set(expectedPids).size, expectedPids.length)

  const invocationCounts = new Map<number, number>()
  for (const pid of actualPids) invocationCounts.set(pid, (invocationCounts.get(pid) ?? 0) + 1)

  assert.equal(invocationCounts.size, expectedPids.length)
  for (const pid of expectedPids)
    assert.equal(invocationCounts.get(pid), 1, `project canary invocation count for ${pid}`)
}

async function materializeMappedSession(
  fixture: Awaited<ReturnType<typeof startRealPiFixture>>,
  sessionId: string
): Promise<void> {
  const sessionMap = JSON.parse(await readFile(fixture.sessionMapPath, 'utf8')) as {
    sessions?: Record<string, { sessionFile?: unknown }>
  }
  const sessionFile = sessionMap.sessions?.[sessionId]?.sessionFile
  assert.equal(typeof sessionFile, 'string')
  await writeFile(
    sessionFile as string,
    `${JSON.stringify({
      type: 'session',
      version: 3,
      id: sessionId,
      timestamp: '2026-08-02T00:00:00.000Z',
      cwd: fixture.cwd
    })}\n`,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 }
  )
}

test(
  'C0.6 fixture pack records C1.6 forced project approval without ambient credentials or model calls',
  {
    timeout: TEST_TIMEOUT_MS
  },
  async t => {
    const parentMarker = `parent-secret-${process.pid}-${Date.now()}`
    const previousEnvironment = new Map<string, string | undefined>()
    for (const name of FORBIDDEN_REAL_PI_ENV_NAMES) {
      previousEnvironment.set(name, process.env[name])
      process.env[name] = parentMarker
    }
    for (const [name, value] of [
      ['PI_PACKAGE_DIR', parentMarker],
      ['PI_CODING_AGENT_DIR', parentMarker],
      ['PI_CODING_AGENT_SESSION_DIR', parentMarker],
      ['PI_ACP_PI_COMMAND', parentMarker]
    ] as const) {
      previousEnvironment.set(name, process.env[name])
      process.env[name] = value
    }
    t.after(() => {
      for (const [name, value] of previousEnvironment) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    })

    const fixture = await startRealPiFixture()
    t.after(fixture.cleanup)
    assert.equal(Object.hasOwn(fixture, 'expectedRuntimeErrorExtensionRealpath'), false)
    assert.equal(Object.hasOwn(fixture, 'expectedRuntimeErrorExtensionSha256'), false)

    const initialized = await fixture.client.initialize()
    assert.equal(initialized.protocolVersion, PROTOCOL_VERSION)
    const session = await fixture.client.newSession({ cwd: fixture.cwd, mcpServers: [] })

    const expectedModelId = `${REAL_PI_FIXTURE_PROVIDER_ID}/${REAL_PI_FIXTURE_MODEL_ID}`
    assert.match(session.sessionId, /\S/u)
    assert.deepEqual((session as typeof session & { models?: unknown }).models, {
      availableModels: [
        {
          modelId: expectedModelId,
          name: `${REAL_PI_FIXTURE_PROVIDER_ID}/Pi ACP Fixture Model`,
          description: null
        }
      ],
      currentModelId: expectedModelId
    })
    assert.deepEqual(
      session.configOptions?.find(option => option.id === 'model'),
      {
        type: 'select',
        id: 'model',
        category: 'model',
        name: 'Model',
        description: 'Select the model for this session',
        currentValue: expectedModelId,
        options: [
          {
            value: expectedModelId,
            name: `${REAL_PI_FIXTURE_PROVIDER_ID}/Pi ACP Fixture Model`,
            description: null
          }
        ]
      }
    )

    const { receipt, stat: receiptStat } = await fixture.readRegistrationReceipt()
    assert.equal(receiptStat.isFile(), true)
    assert.equal(receiptStat.isSymbolicLink(), false)
    assert.equal(receiptStat.nlink, 1)
    assert.ok(receiptStat.size > 0 && receiptStat.size < 8_192)
    if (process.platform !== 'win32') {
      assert.equal(receiptStat.mode & 0o777, 0o600)
      if (process.getuid) assert.equal(receiptStat.uid, process.getuid())
    }

    assert.equal(receipt.schemaVersion, 1)
    assert.equal(receipt.checkpoint, 'C0.6')
    assert.equal(receipt.fixtureId, 'pi-extension-pack-v1')
    assert.equal(receipt.extensionEvidenceKind, 'cooperative_session_start_on_disk_self_report')
    assert.equal(receipt.phase, 'registered_and_started')
    assert.equal(receipt.event, 'session_start')
    assert.equal(receipt.reason, 'startup')
    assert.equal(receipt.nonce, fixture.nonce)
    assert.equal(receipt.factoryInvocationCount, 1)
    assert.equal(receipt.piVersion, REAL_PI_VERSION)
    assert.equal(receipt.nodeVersion, process.versions.node)
    assert.equal(receipt.cwd, fixture.cwd)
    assert.equal(receipt.agentDir, fixture.agentDir)
    assert.equal(receipt.sessionDir, fixture.sessionDir)
    assert.equal(receipt.packageDir, fixture.piPackageRoot)
    assert.equal(receipt.extensionRealpath, fixture.expectedExtensionRealpath)
    assert.equal(receipt.extensionSha256, fixture.expectedExtensionSha256)
    assert.equal(receipt.cliRealpath, fixture.expectedCliRealpath)
    assert.equal(receipt.offline, true)
    assert.equal(receipt.versionCheckDisabled, true)
    assert.equal(receipt.telemetryDisabled, true)
    assert.equal(receipt.approveArgPresent, true)
    assert.equal(receipt.extensionArgPresent, false)
    assert.deepEqual(receipt.forbiddenEnvPresent, [])
    const requiredEnvironmentKeys = [
      ...REAL_PI_FIXTURE_ENV_NAMES,
      'PI_CODING_AGENT',
      ...(process.platform === 'win32'
        ? ['SYSTEMROOT', 'WINDIR', 'ComSpec', 'PATHEXT'].filter(name => process.env[name] !== undefined)
        : [])
    ]
    const optionalEnvironmentKeys =
      process.platform === 'win32'
        ? []
        : ['PWD', 'SHLVL', ...(process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : [])]
    assert.deepEqual(receipt.environmentKeys, [...receipt.environmentKeys].sort())
    assert.equal(new Set(receipt.environmentKeys).size, receipt.environmentKeys.length)
    for (const name of requiredEnvironmentKeys) assert.equal(receipt.environmentKeys.includes(name), true)
    const allowedEnvironmentKeys = new Set([...requiredEnvironmentKeys, ...optionalEnvironmentKeys])
    assert.deepEqual(
      receipt.environmentKeys.filter(name => !allowedEnvironmentKeys.has(name)),
      []
    )
    assert.equal(receipt.projectTrusted, true)
    assert.deepEqual(receipt.registrations, {
      providers: [REAL_PI_FIXTURE_PROVIDER_ID],
      commands: [REAL_PI_FIXTURE_COMMAND_ID]
    })
    assert.deepEqual(receipt.model, {
      provider: REAL_PI_FIXTURE_PROVIDER_ID,
      id: REAL_PI_FIXTURE_MODEL_ID,
      name: 'Pi ACP Fixture Model',
      available: true,
      authConfigured: true,
      selected: true
    })
    assert.equal(Number.isInteger(receipt.piPid) && receipt.piPid > 0, true)
    assert.notEqual(receipt.piPid, fixture.client.processId)
    assert.equal(isProcessRunning(receipt.piPid), true)
    assert.equal(fixture.packageVersion, REAL_PI_VERSION)
    assert.deepEqual(fixture.requests, [])
    assertProjectCanaryInvokedOncePerChild(await readProjectCanaryPids(fixture.projectCanaryPath), [receipt.piPid])
    await assertPathMissing(fixture.trustPath)
    assert.equal(await readFile(fixture.authPath, 'utf8'), '{}\n')

    if (process.platform !== 'win32') {
      const externalRoot = await mkdtemp(join(await realpath(tmpdir()), 'pi-acp-receipt-ancestor-'))
      const receiptDir = dirname(fixture.registrationReceiptPath)
      const movedReceiptDir = join(externalRoot, 'moved-artifacts')
      await rename(receiptDir, movedReceiptDir)
      await symlink(movedReceiptDir, receiptDir, 'dir')
      try {
        await assert.rejects(fixture.readRegistrationReceipt(), /C0\.6 receipt ancestor must be a real directory/u)
      } finally {
        await unlink(receiptDir)
        await rename(movedReceiptDir, receiptDir)
        await rm(externalRoot, { recursive: true, force: true })
      }
    }

    const sessionMap = JSON.parse(await readFile(fixture.sessionMapPath, 'utf8')) as {
      version?: unknown
      sessions?: Record<
        string,
        {
          sessionId?: unknown
          cwd?: unknown
          sessionFile?: unknown
        }
      >
    }
    assert.equal(sessionMap.version, 1)
    assert.deepEqual(Object.keys(sessionMap.sessions ?? {}), [session.sessionId])
    const mappedSession = sessionMap.sessions?.[session.sessionId]
    assert.equal(mappedSession?.sessionId, session.sessionId)
    assert.equal(mappedSession.cwd, fixture.cwd)
    assert.ok(typeof mappedSession.sessionFile === 'string')
    assert.equal(isAbsolute(mappedSession.sessionFile), true)
    const relativeSessionPath = relative(fixture.sessionDir, mappedSession.sessionFile)
    assert.notEqual(relativeSessionPath, '')
    assert.notEqual(relativeSessionPath, '..')
    assert.equal(relativeSessionPath.startsWith(`..${sep}`), false)
    assert.equal(isAbsolute(relativeSessionPath), false)
    assert.deepEqual(outboundMethods(fixture.client.transcript()), ['initialize', 'session/new'])

    const outerPid = fixture.client.processId
    assert.ok(outerPid)
    const exit = await fixture.client.close()
    assert.equal(exit.code, 0)
    assert.equal(exit.signal, null)
    await waitForProcessExit(receipt.piPid, 5_000)
    await waitForProcessExit(outerPid, 5_000)

    const { receipt: shutdownReceipt, stat: shutdownReceiptStat } = await fixture.readShutdownReceipt()
    assert.equal(shutdownReceiptStat.isFile(), true)
    assert.equal(shutdownReceiptStat.isSymbolicLink(), false)
    assert.equal(shutdownReceiptStat.nlink, 1)
    assert.ok(shutdownReceiptStat.size > 0 && shutdownReceiptStat.size < 8_192)
    if (process.platform !== 'win32') {
      assert.equal(shutdownReceiptStat.mode & 0o777, 0o600)
      if (process.getuid) assert.equal(shutdownReceiptStat.uid, process.getuid())
    }
    assert.deepEqual(shutdownReceipt, {
      schemaVersion: 1,
      checkpoint: 'C0.6',
      fixtureId: 'pi-extension-pack-v1',
      phase: 'session_shutdown',
      reason: 'quit',
      nonce: fixture.nonce,
      piVersion: REAL_PI_VERSION,
      piPid: receipt.piPid
    })
    assert.deepEqual(await fixture.client.closed, exit)
    assert.equal(fixture.client.isRunning, false)
    await fixture.closeLoopback()
    assert.deepEqual(fixture.requests, [])

    const serializedEvidence = `${fixture.client.transcriptNdjson()}\n${JSON.stringify(receipt)}\n${exit.stderrTail}`
    assert.equal(serializedEvidence.includes(parentMarker), false)
    assert.equal(serializedEvidence.includes(`pi-acp-fixture-${fixture.nonce}`), false)
    assert.equal(serializedEvidence.includes('session/prompt'), false)
  }
)

test(
  'C1.6 reload and automatic recovery rerun the approved project canary once per Pi child without persisting trust',
  { timeout: TEST_TIMEOUT_MS },
  async t => {
    await t.test('session/load', async st => {
      const fixture = await startRealPiFixture({ childTermination: true })
      st.after(fixture.cleanup)

      await fixture.client.initialize()
      const session = await fixture.client.newSession({ cwd: fixture.cwd, mcpServers: [] })
      const { receipt } = await fixture.readRegistrationReceipt()
      assert.equal(receipt.approveArgPresent, true)
      assert.equal(receipt.projectTrusted, true)
      assertProjectCanaryInvokedOncePerChild(await readProjectCanaryPids(fixture.projectCanaryPath), [receipt.piPid])
      await assertPathMissing(fixture.trustPath)

      await materializeMappedSession(fixture, session.sessionId)
      await rm(fixture.registrationReceiptPath, { force: true })
      const afterLoadIndex = fixture.client.retainedSessionUpdateCount
      await fixture.client.extMethod('session/load', {
        sessionId: session.sessionId,
        cwd: fixture.cwd,
        mcpServers: []
      })

      await fixture.client.waitForSessionUpdate(
        notification =>
          notification.sessionId === session.sessionId &&
          notification.update.sessionUpdate === 'agent_message_chunk' &&
          notification.update.content.type === 'text' &&
          notification.update.content.text === `${PROJECT_TRUST_WARNING}\n`,
        { afterIndex: afterLoadIndex, timeoutMs: 10_000 }
      )

      const sessionStarts = (await fixture.readC1_3SessionStartReceipts()).map(item => item.receipt.piPid)
      assert.equal(sessionStarts.length, 2)
      assertProjectCanaryInvokedOncePerChild(await readProjectCanaryPids(fixture.projectCanaryPath), sessionStarts)
      assert.equal(projectTrustWarningCount(fixture.client.transcript()), 2)
      await assertPathMissing(fixture.trustPath)

      // Loading stops the first child, whose canonical shutdown receipt must
      // be removed before the replacement owns the same single-child marker.
      await rm(fixture.shutdownReceiptPath, { force: true })
      const exit = await fixture.client.close()
      assert.deepEqual({ code: exit.code, signal: exit.signal }, { code: 0, signal: null })
      await assertPathMissing(fixture.trustPath)
    })

    await t.test('automatic recovery', async st => {
      const fixture = await startRealPiFixture({
        childTermination: true,
        hardDeadlineMs: 20_000,
        transcriptCheckpoint: 'C1.3',
        transcriptCaseId: 'C1.6-forced-approval-recovery'
      })
      st.after(fixture.cleanup)

      await fixture.client.initialize()
      const session = await fixture.client.newSession({ cwd: fixture.cwd, mcpServers: [] })
      const { receipt } = await fixture.readRegistrationReceipt()
      assert.equal(receipt.approveArgPresent, true)
      assert.equal(receipt.projectTrusted, true)
      assertProjectCanaryInvokedOncePerChild(await readProjectCanaryPids(fixture.projectCanaryPath), [receipt.piPid])
      await fixture.client.waitForSessionUpdate(
        notification =>
          notification.sessionId === session.sessionId &&
          notification.update.sessionUpdate === 'agent_message_chunk' &&
          notification.update.content.type === 'text' &&
          notification.update.content.text === `${PROJECT_TRUST_WARNING}\n`,
        { timeoutMs: 10_000 }
      )

      await materializeMappedSession(fixture, session.sessionId)
      await rm(fixture.registrationReceiptPath, { force: true })
      await assert.rejects(
        fixture.client.prompt(
          {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: '/c1-3-terminate-child' }]
          },
          { timeoutMs: 10_000 }
        )
      )
      await fixture.readShutdownReceipt()
      await rm(fixture.shutdownReceiptPath, { force: true })

      const recovered = await fixture.client.prompt(
        {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'Return the deterministic C1.3 recovery response.' }]
        },
        { timeoutMs: 10_000 }
      )
      assert.equal(recovered.stopReason, 'end_turn')

      const sessionStarts = (await fixture.readC1_3SessionStartReceipts()).map(item => item.receipt.piPid)
      assert.equal(sessionStarts.length, 2)
      assertProjectCanaryInvokedOncePerChild(await readProjectCanaryPids(fixture.projectCanaryPath), sessionStarts)
      assert.equal(projectTrustWarningCount(fixture.client.transcript()), 1)
      await assertPathMissing(fixture.trustPath)

      const exit = await fixture.client.close()
      assert.deepEqual({ code: exit.code, signal: exit.signal }, { code: 0, signal: null })
      await assertPathMissing(fixture.trustPath)
    })
  }
)

test(
  'C3.4 default-off /fixture-state refuses before extension execution and real Pi cleanup completes',
  { timeout: TEST_TIMEOUT_MS },
  async t => {
    const fixture = await startRealPiFixture({
      hardDeadlineMs: 20_000,
      clientShutdownTimeoutMs: 5_000,
      transcriptCheckpoint: 'C3.4',
      transcriptCaseId: 'C3.4-default-off-fixture-state'
    })
    t.after(fixture.cleanup)

    await fixture.client.initialize()
    const session = await fixture.client.newSession({ cwd: fixture.cwd, mcpServers: [] })
    await fixture.client.waitForSessionUpdate(
      notification =>
        notification.sessionId === session.sessionId &&
        notification.update.sessionUpdate === 'available_commands_update',
      { timeoutMs: 10_000 }
    )

    const { receipt } = await fixture.readRegistrationReceipt()
    const adapterPid = fixture.client.processId
    assert.ok(adapterPid)
    assert.equal(isProcessRunning(receipt.piPid), true)

    // C3.3 deliberately owns the exact preview command and refuses it while
    // default-off. Patched positive plus post-write cancel/no-replay authority
    // now lives in real-pi-fixture-state-preview.test.ts; this stock-Pi case
    // retains the default-off/no-handler and real shutdown proof.
    const response = await fixture.client.prompt(
      {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: `/${REAL_PI_FIXTURE_COMMAND_ID}` }]
      },
      { timeoutMs: 10_000 }
    )
    assert.equal(response.stopReason, 'refusal')
    const piAcp = record(record(response._meta).piAcp)
    const execution = record(piAcp.executeCommand)
    assert.equal(typeof execution.requestId, 'string')
    assert.deepEqual(execution, {
      requestId: execution.requestId,
      name: REAL_PI_FIXTURE_COMMAND_ID,
      disposition: 'rejected',
      code: 'COMMAND_NOT_FOUND'
    })
    assert.deepEqual(record(piAcp.diagnostic), {
      schemaVersion: 1,
      code: 'COMMAND_NOT_FOUND',
      phase: 'execution',
      source: 'extension',
      command: REAL_PI_FIXTURE_COMMAND_ID,
      summary: 'The experimental /fixture-state preview is disabled; nothing was sent to Pi.',
      truncated: false,
      redacted: false
    })
    assert.deepEqual(record(piAcp.routing), {
      promptForwardedToPi: false,
      sentToModel: false
    })

    const firstClose = fixture.client.close()
    assert.strictEqual(fixture.client.close(), firstClose)
    const exit = await firstClose
    assert.equal(exit.code, 0)
    assert.equal(exit.signal, null)
    await fixture.assertWithinHardDeadline()

    const transcript = fixture.client.transcript()
    const promptEntries = transcript.filter(
      entry =>
        entry.kind === 'message' &&
        entry.direction === 'client_to_agent' &&
        record(entry.message).method === 'session/prompt'
    )
    assert.equal(promptEntries.length, 1)
    const promptEntry = promptEntries[0]!
    if (promptEntry.kind !== 'message') throw new Error('prompt transcript entry was not a message')
    const promptId = record(promptEntry.message).id
    assert.ok(typeof promptId === 'string' || typeof promptId === 'number' || promptId === null)
    const catalogEntries = transcript.filter(entry => {
      if (
        entry.kind !== 'message' ||
        entry.direction !== 'agent_to_client' ||
        record(entry.message).method !== 'session/update'
      ) {
        return false
      }
      const update = record(record(record(entry.message).params).update)
      return update.sessionUpdate === 'available_commands_update'
    })
    assert.equal(catalogEntries.length, 1)
    const catalogEntry = catalogEntries[0]!
    if (catalogEntry.kind !== 'message') throw new Error('catalog transcript entry was not a message')
    const availableCommands = record(record(record(catalogEntry.message).params).update).availableCommands
    assert.equal(Array.isArray(availableCommands), true)
    if (!Array.isArray(availableCommands)) throw new Error('available commands were not an array')
    assert.equal(
      availableCommands.some(command => record(command).name === REAL_PI_FIXTURE_COMMAND_ID),
      false
    )

    const notificationEntries = transcript.filter(entry => {
      if (
        entry.kind !== 'message' ||
        entry.direction !== 'agent_to_client' ||
        record(entry.message).method !== 'session/update'
      ) {
        return false
      }
      const update = record(record(record(entry.message).params).update)
      const content = record(update.content)
      return update.sessionUpdate === 'agent_message_chunk' && content.text === 'Pi ACP fixture loaded'
    })
    assert.equal(notificationEntries.length, 0)

    const promptResponses = transcript.filter(entry => {
      if (entry.kind !== 'message' || entry.direction !== 'agent_to_client') return false
      const message = record(entry.message)
      return message.id === promptId && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))
    })
    assert.equal(promptResponses.length, 1)
    const promptResponse = promptResponses[0]!
    if (promptResponse.kind !== 'message') throw new Error('prompt response transcript entry was not a message')
    assert.deepEqual(record(promptResponse.message).result, response)
    assert.equal(fixture.requests.length, 0)

    const processExit = transcript.at(-1)
    assert.equal(transcript.filter(entry => entry.kind === 'process_exit').length, 1)
    assert.equal(processExit?.kind, 'process_exit')
    if (processExit?.kind === 'process_exit') {
      assert.equal(processExit.code, 0)
      assert.equal(processExit.signal, null)
    }

    await waitForProcessExit(receipt.piPid, 5_000)
    await waitForProcessExit(adapterPid, 5_000)
    const { receipt: shutdownReceipt } = await fixture.readShutdownReceipt()
    assert.deepEqual(shutdownReceipt, {
      schemaVersion: 1,
      checkpoint: 'C0.6',
      fixtureId: 'pi-extension-pack-v1',
      phase: 'session_shutdown',
      reason: 'quit',
      nonce: fixture.nonce,
      piVersion: REAL_PI_VERSION,
      piPid: receipt.piPid
    })
  }
)
