import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import assert from 'node:assert/strict'
import { lstat, mkdtemp, readFile, realpath, rename, rm, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import test from 'node:test'
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

test(
  'C0.6 loads the pinned real Pi fixture pack without ambient trust, credentials, or model calls',
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
    assert.equal(receipt.approveArgPresent, false)
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
    assert.equal(receipt.projectTrusted, false)
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
    await assertPathMissing(fixture.projectCanaryPath)
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
