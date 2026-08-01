import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RequestError } from '@agentclientprotocol/sdk'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { SessionCreateRollbackError, SessionManager } from '../../src/acp/session.js'
import { SessionStore } from '../../src/acp/session-store.js'
import { PiRpcProcess, PiRpcProcessTerminatedError, PiRpcSpawnError } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function identity(sessionId: string) {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-create-owned-'))
  const sessionFile = join(cwd, `${sessionId}.jsonl`)
  writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd })}\n`, 'utf8')
  return { cwd, sessionFile }
}

function configureNewCandidate(proc: FakePiRpcProcess, sessionId: string, sessionFile: string): void {
  const state = Object.freeze({
    sessionId,
    sessionFile,
    thinkingLevel: 'medium',
    model: { provider: 'test', id: 'model' }
  })
  proc.getState = async () => state
  ;(proc as any).getStartupHandshakeState = () => state
}

function isolateManagerStore(t: TestContext, manager: SessionManager): SessionStore {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-manager-store-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new SessionStore(join(root, 'session-map.json'))
  ;(manager as any).store = store
  return store
}

function isolateAgentStores(t: TestContext, agent: PiAcpAgent): SessionStore {
  const manager = (agent as any).sessions as SessionManager
  const store = isolateManagerStore(t, manager)
  ;(agent as any).store = store
  return store
}

test('PiAcpAgent: initial spawn candidate is retained and a rejected dispose is retryable', async t => {
  const candidate = new FakePiRpcProcess()
  let stopAttempts = 0
  candidate.stop = async () => {
    candidate.stopCount += 1
    stopAttempts += 1
    if (stopAttempts === 1) throw new Error('cleanup still unconfirmed')
    candidate.terminate()
  }
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    throw new PiRpcSpawnError('Initial handshake failed.', {
      code: 'PI_RPC_HANDSHAKE_TIMEOUT',
      candidate: candidate as any
    })
  }
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()), {} as any)
  isolateAgentStores(t, agent)

  try {
    await assert.rejects(() => agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any))
    assert.equal(stopAttempts, 0, 'manager repeated spawn cleanup in the same transaction')
    await assert.rejects(() => agent.dispose(), /cleanup still unconfirmed/)
    assert.equal(stopAttempts, 1)
    await agent.dispose()
    assert.equal(stopAttempts, 2)
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: dispose fences an in-flight session create and stops its late process', async t => {
  const sessionId = 'late-create-session'
  const stored = identity(sessionId)
  const candidate = new FakePiRpcProcess()
  configureNewCandidate(candidate, sessionId, stored.sessionFile)
  let releaseSpawn!: () => void
  const spawnGate = new Promise<void>(resolve => {
    releaseSpawn = resolve
  })
  let markSpawnStarted!: () => void
  const spawnStarted = new Promise<void>(resolve => {
    markSpawnStarted = resolve
  })
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    markSpawnStarted()
    await spawnGate
    return candidate as any
  }
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()), {} as any)
  isolateAgentStores(t, agent)

  try {
    const creating = agent.newSession({ cwd: stored.cwd, mcpServers: [] } as any).then(
      () => null,
      error => error
    )
    await spawnStarted
    const disposing = agent.dispose()
    releaseSpawn()
    const createError = await creating
    await disposing

    assert.ok(createError instanceof RequestError)
    assert.equal(candidate.stopCount, 1)
    assert.equal((agent as any).sessions.maybeGet(sessionId), undefined)
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: dispose during the post-spawn identity probe stops the unpublished child once', async t => {
  const sessionId = 'identity-probe-dispose-session'
  const stored = identity(sessionId)
  const candidate = new FakePiRpcProcess()
  let markProbeStarted!: () => void
  const probeStarted = new Promise<void>(resolve => {
    markProbeStarted = resolve
  })
  let releaseProbe!: () => void
  const probeGate = new Promise<void>(resolve => {
    releaseProbe = resolve
  })
  candidate.getState = async () => {
    markProbeStarted()
    await probeGate
    return { sessionId, sessionFile: stored.sessionFile, thinkingLevel: 'medium' }
  }
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => candidate as any
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()), {} as any)
  isolateAgentStores(t, agent)

  try {
    const creating = agent.newSession({ cwd: stored.cwd, mcpServers: [] } as any).then(
      () => null,
      error => error
    )
    await probeStarted
    const disposing = agent.dispose()
    releaseProbe()
    const error = await creating
    await disposing

    assert.ok(error instanceof RequestError)
    assert.equal(candidate.stopCount, 1)
    assert.equal((agent as any).sessions.maybeGet(sessionId), undefined)
  } finally {
    releaseProbe()
    PiRpcProcess.spawn = originalSpawn
    await agent.dispose()
  }
})

test('SessionManager: authoritative identity probe terminal maps exact data and cleans the candidate', async t => {
  const candidate = new FakePiRpcProcess()
  const causal = new PiRpcProcessTerminatedError('Identity probe lost the child.', undefined, {
    kind: 'exit',
    code: 51
  })
  candidate.getState = async () => {
    candidate.terminate(causal)
    throw causal
  }
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => candidate as any
  const manager = new SessionManager()
  isolateManagerStore(t, manager)

  try {
    const error = await manager
      .create({
        cwd: process.cwd(),
        mcpServers: [],
        conn: asAgentConn(new FakeAgentSideConnection()),
        proc: candidate as any
      } as any)
      .then(
        () => null,
        failure => failure
      )
    assert.ok(error instanceof RequestError)
    assert.equal(error.code, -32603)
    assert.equal(error.data, causal.data)
    assert.equal(candidate.stopCount, 1)
  } finally {
    PiRpcProcess.spawn = originalSpawn
    await manager.disposeAll()
  }
})

test('PiAcpAgent: manager mapping failure stops once, removes exact artifacts, and preserves the public error', async t => {
  const sessionId = 'store-failure-session'
  const stored = identity(sessionId)
  const candidate = new FakePiRpcProcess()
  configureNewCandidate(candidate, sessionId, stored.sessionFile)
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => candidate as any
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()), {} as any)
  const store = isolateAgentStores(t, agent)
  const manager = (agent as any).sessions as SessionManager
  const mappingError = new Error('mapping write failed')
  const managerCreate = manager.create.bind(manager)
  let observedHandoff: unknown = null
  ;(manager as any).create = async (params: any) => {
    try {
      return await managerCreate(params)
    } catch (error) {
      observedHandoff = error
      throw error
    }
  }
  ;(manager as any).store = {
    get(id: string) {
      return store.get(id)
    },
    upsert() {
      throw mappingError
    }
  }

  try {
    const error = await agent.newSession({ cwd: stored.cwd, mcpServers: [] } as any).then(
      () => null,
      failure => failure
    )
    assert.equal(error, mappingError)
    assert.ok(observedHandoff instanceof SessionCreateRollbackError)
    assert.deepEqual(
      Object.keys(observedHandoff).filter(key => ['session', 'originalError', 'cleanupStatus'].includes(key)),
      []
    )
    assert.doesNotMatch(JSON.stringify(observedHandoff), /session|originalError|cleanupStatus/)
    assert.equal(candidate.stopCount, 1)
    assert.equal(manager.maybeGet(sessionId), undefined)
    assert.equal(manager.currentGeneration(sessionId), 0)
    assert.equal(existsSync(stored.sessionFile), false)
    assert.equal(store.get(sessionId), null)
  } finally {
    PiRpcProcess.spawn = originalSpawn
    await agent.dispose()
  }
})

test('SessionManager: live and tombstoned ID collisions never overwrite the existing lineage', async t => {
  await t.test('live collision', async st => {
    const sessionId = 'live-collision-session'
    const stored = identity(sessionId)
    const conn = new FakeAgentSideConnection()
    const manager = new SessionManager()
    isolateManagerStore(st, manager)
    const existing = new FakePiRpcProcess()
    manager.getOrCreate(sessionId, {
      cwd: stored.cwd,
      mcpServers: [],
      conn: asAgentConn(conn),
      proc: existing as any,
      fileCommands: []
    })
    const losing = new FakePiRpcProcess()
    configureNewCandidate(losing, sessionId, stored.sessionFile)
    const originalSpawn = PiRpcProcess.spawn
    ;(PiRpcProcess as any).spawn = async () => losing as any
    try {
      await assert.rejects(() => manager.create({ cwd: stored.cwd, mcpServers: [], conn: asAgentConn(conn) } as any))
      assert.equal(manager.maybeGet(sessionId)?.proc, existing)
      assert.equal(existing.stopCount, 0)
      assert.equal(losing.stopCount, 1)
    } finally {
      PiRpcProcess.spawn = originalSpawn
      await manager.disposeAll()
    }
  })

  await t.test('tombstone collision', async st => {
    const sessionId = 'tombstone-collision-session'
    const stored = identity(sessionId)
    const conn = new FakeAgentSideConnection()
    const manager = new SessionManager()
    isolateManagerStore(st, manager)
    const old = new FakePiRpcProcess()
    manager.getOrCreate(sessionId, {
      cwd: stored.cwd,
      mcpServers: [],
      conn: asAgentConn(conn),
      proc: old as any,
      fileCommands: []
    })
    await manager.close(sessionId)
    const losing = new FakePiRpcProcess()
    configureNewCandidate(losing, sessionId, stored.sessionFile)
    const originalSpawn = PiRpcProcess.spawn
    ;(PiRpcProcess as any).spawn = async () => losing as any
    try {
      await assert.rejects(() => manager.create({ cwd: stored.cwd, mcpServers: [], conn: asAgentConn(conn) } as any))
      assert.equal(manager.maybeGet(sessionId), undefined)
      assert.equal(manager.currentGeneration(sessionId), 1)
      assert.equal(losing.stopCount, 1)
    } finally {
      PiRpcProcess.spawn = originalSpawn
      await manager.disposeAll()
    }
  })

  await t.test('durable mapping collision', async st => {
    const sessionId = 'durable-collision-session'
    const stored = identity(sessionId)
    const conn = new FakeAgentSideConnection()
    const manager = new SessionManager()
    const store = isolateManagerStore(st, manager)
    store.upsert({ sessionId, cwd: stored.cwd, sessionFile: stored.sessionFile })
    const losing = new FakePiRpcProcess()
    configureNewCandidate(losing, sessionId, stored.sessionFile)
    const originalSpawn = PiRpcProcess.spawn
    ;(PiRpcProcess as any).spawn = async () => losing as any
    try {
      await assert.rejects(() => manager.create({ cwd: stored.cwd, mcpServers: [], conn: asAgentConn(conn) } as any))
      assert.equal(manager.maybeGet(sessionId), undefined)
      assert.equal(manager.currentGeneration(sessionId), 0)
      assert.equal(losing.stopCount, 1)
      assert.equal(store.get(sessionId)?.sessionFile, stored.sessionFile)
    } finally {
      PiRpcProcess.spawn = originalSpawn
      await manager.disposeAll()
    }
  })
})

test('SessionManager: a pending close fences later spawn admission until stop proof settles', async t => {
  const oldId = 'pending-close-old'
  const oldStored = identity(oldId)
  const nextId = 'pending-close-next'
  const nextStored = identity(nextId)
  const conn = new FakeAgentSideConnection()
  const manager = new SessionManager()
  isolateManagerStore(t, manager)
  const old = new FakePiRpcProcess()
  let stopStarted!: () => void
  const started = new Promise<void>(resolve => {
    stopStarted = resolve
  })
  let releaseStop!: () => void
  const stopGate = new Promise<void>(resolve => {
    releaseStop = resolve
  })
  old.stop = async () => {
    old.stopCount += 1
    stopStarted()
    await stopGate
    old.terminate()
  }
  manager.getOrCreate(oldId, {
    cwd: oldStored.cwd,
    mcpServers: [],
    conn: asAgentConn(conn),
    proc: old as any,
    fileCommands: []
  })

  const next = new FakePiRpcProcess()
  configureNewCandidate(next, nextId, nextStored.sessionFile)
  let spawnCount = 0
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    spawnCount += 1
    return next as any
  }

  try {
    const closing = manager.close(oldId)
    await started
    const creating = manager.create({ cwd: nextStored.cwd, mcpServers: [], conn: asAgentConn(conn) } as any)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(spawnCount, 0)
    releaseStop()
    assert.equal(await closing, true)
    const created = await creating
    assert.equal(created.sessionId, nextId)
    assert.equal(spawnCount, 1)
  } finally {
    releaseStop()
    PiRpcProcess.spawn = originalSpawn
    await manager.disposeAll()
  }
})

test('SessionManager: closeAll waits for every sibling teardown after an earlier failure', async t => {
  const conn = new FakeAgentSideConnection()
  const manager = new SessionManager()
  isolateManagerStore(t, manager)
  const first = new FakePiRpcProcess()
  let firstAttempts = 0
  first.stop = async () => {
    first.stopCount += 1
    firstAttempts += 1
    if (firstAttempts === 1) throw new Error('first close unconfirmed')
    first.terminate()
  }
  const second = new FakePiRpcProcess()
  let secondStarted!: () => void
  const started = new Promise<void>(resolve => {
    secondStarted = resolve
  })
  let releaseSecond!: () => void
  const secondGate = new Promise<void>(resolve => {
    releaseSecond = resolve
  })
  second.stop = async () => {
    second.stopCount += 1
    secondStarted()
    await secondGate
    second.terminate()
  }
  for (const [id, proc] of [
    ['close-all-first', first],
    ['close-all-second', second]
  ] as const) {
    manager.getOrCreate(id, {
      cwd: process.cwd(),
      mcpServers: [],
      conn: asAgentConn(conn),
      proc: proc as any,
      fileCommands: []
    })
  }

  try {
    let settled = false
    const closing = manager
      .closeAll()
      .then(
        () => null,
        error => error
      )
      .finally(() => {
        settled = true
      })
    await started
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false)
    releaseSecond()
    assert.match(String((await closing)?.message), /first close unconfirmed/)
    assert.equal(second.stopCount, 1)
  } finally {
    releaseSecond()
    await manager.disposeAll()
  }
})

test('PiAcpAgent: unconfirmed manager rollback is pending without a second same-transaction stop', async t => {
  const previousPath = process.env.PATH
  process.env.PATH = ''
  const sessionId = 'rollback-stop-retry'
  const stored = identity(sessionId)
  const candidate = new FakePiRpcProcess()
  configureNewCandidate(candidate, sessionId, stored.sessionFile)
  let stopAttempts = 0
  candidate.stop = async () => {
    candidate.stopCount += 1
    stopAttempts += 1
    if (stopAttempts === 1) throw new Error('rollback stop unconfirmed')
    candidate.terminate()
  }
  const replacementId = 'rollback-stop-retry-successor'
  const replacementStored = identity(replacementId)
  const replacement = new FakePiRpcProcess()
  configureNewCandidate(replacement, replacementId, replacementStored.sessionFile)
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()), {} as any)
  const store = isolateAgentStores(t, agent)
  const manager = (agent as any).sessions as SessionManager
  const mappingError = new Error('mapping write failed')
  let failWrites = true
  ;(manager as any).store = {
    get(id: string) {
      return store.get(id)
    },
    upsert(entry: { sessionId: string; cwd: string; sessionFile: string }) {
      if (failWrites) throw mappingError
      store.upsert(entry)
    }
  }
  let spawnCount = 0
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    spawnCount += 1
    return spawnCount === 1 ? (candidate as any) : (replacement as any)
  }

  try {
    const error = await agent.newSession({ cwd: stored.cwd, mcpServers: [] } as any).then(
      () => null,
      failure => failure
    )
    assert.equal(error, mappingError)
    assert.equal(stopAttempts, 1)
    assert.equal(manager.maybeGet(sessionId)?.proc, candidate)
    assert.equal(manager.currentGeneration(sessionId), 1)
    assert.equal(existsSync(stored.sessionFile), true)
    assert.equal(store.get(sessionId), null)
    assert.equal(spawnCount, 1)

    failWrites = false
    const response = await agent.newSession({ cwd: replacementStored.cwd, mcpServers: [] } as any)

    assert.equal(stopAttempts, 2)
    assert.equal(manager.maybeGet(sessionId), undefined)
    assert.equal(manager.currentGeneration(sessionId), 0)
    assert.equal(existsSync(stored.sessionFile), false)
    assert.equal(store.get(sessionId), null)
    assert.equal(spawnCount, 2)
    assert.equal(response.sessionId, replacementId)
    assert.equal(manager.maybeGet(replacementId)?.proc, replacement)
    assert.equal(store.get(replacementId)?.sessionFile, replacementStored.sessionFile)
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    PiRpcProcess.spawn = originalSpawn
    await agent.dispose()
  }
})

test('PiAcpAgent: same-ID recovery completes failed-new cleanup and never spawns from stale mapping', async t => {
  const previousPath = process.env.PATH
  process.env.PATH = ''
  const sessionId = 'failed-new-same-id-recovery'
  const stored = identity(sessionId)
  const candidate = new FakePiRpcProcess()
  configureNewCandidate(candidate, sessionId, stored.sessionFile)
  candidate.getAvailableModels = async () => ({ models: [] })
  let stopAttempts = 0
  candidate.stop = async () => {
    candidate.stopCount += 1
    stopAttempts += 1
    if (stopAttempts === 1) throw new Error('failed-new cleanup unconfirmed')
    candidate.terminate()
  }
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  const store = isolateAgentStores(t, agent)
  let spawnCount = 0
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    spawnCount += 1
    return candidate as any
  }

  try {
    await assert.rejects(
      () => agent.newSession({ cwd: stored.cwd, mcpServers: [] } as any),
      (error: any) => error?.code === -32000
    )
    assert.equal(stopAttempts, 1)
    assert.equal(store.get(sessionId)?.sessionFile, stored.sessionFile)

    const recoveryRequest = () =>
      agent
        .prompt({
          sessionId,
          prompt: [{ type: 'text', text: 'must not replay the failed create' }]
        } as any)
        .then(
          () => null,
          error => error
        )
    const [firstRecoveryError, peerRecoveryError] = await Promise.all([recoveryRequest(), recoveryRequest()])
    assert.equal(firstRecoveryError, peerRecoveryError)
    assert.equal(firstRecoveryError?.data?.code, 'PI_ACP_SESSION_RECOVERY_UNAVAILABLE')
    assert.equal(stopAttempts, 2)
    assert.equal(spawnCount, 1)
    assert.equal(store.get(sessionId), null)
    assert.equal(existsSync(stored.sessionFile), false)
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    PiRpcProcess.spawn = originalSpawn
    await agent.dispose()
  }
})

test('PiAcpAgent: failed load cleanup never reuses a half-disposed retained session', async t => {
  const sessionId = 'failed-load-cleanup-session'
  const stored = identity(sessionId)
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  const store = isolateAgentStores(t, agent)
  store.upsert({ sessionId, cwd: stored.cwd, sessionFile: stored.sessionFile })
  const sessions = (agent as any).sessions as SessionManager
  const old = new FakePiRpcProcess()
  let stopAttempts = 0
  old.stop = async () => {
    old.stopCount += 1
    stopAttempts += 1
    if (stopAttempts === 1) throw new Error('load cleanup stop unconfirmed')
    old.terminate()
  }
  const oldSession = sessions.getOrCreate(sessionId, {
    cwd: stored.cwd,
    mcpServers: [],
    conn: asAgentConn(conn),
    proc: old as any,
    fileCommands: []
  })

  await (agent as any).cleanupFailedLoadSession(oldSession)
  assert.equal(old.isAlive(), true)
  assert.equal(oldSession.isAlive(), false)
  assert.equal(sessions.maybeGet(sessionId), oldSession)

  const replacement = new FakePiRpcProcess()
  configureNewCandidate(replacement, sessionId, stored.sessionFile)
  let spawnCount = 0
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    spawnCount += 1
    return replacement as any
  }

  try {
    const restored = await (agent as any).restoreSession(sessionId)
    assert.equal(restored.proc, replacement)
    assert.notEqual(restored, oldSession)
    assert.equal(stopAttempts, 2)
    assert.equal(spawnCount, 1)
  } finally {
    PiRpcProcess.spawn = originalSpawn
    await agent.dispose()
  }
})

test('PiAcpAgent: corrupt failed-new artifact quarantines only its ID and unrelated create proceeds', async t => {
  const previousPath = process.env.PATH
  process.env.PATH = ''
  const badId = 'artifact-quarantine-session'
  const badStored = identity(badId)
  writeFileSync(
    badStored.sessionFile,
    `${JSON.stringify({ type: 'session', version: 3, id: 'wrong-owner', cwd: badStored.cwd })}\n`,
    'utf8'
  )
  const goodId = 'artifact-quarantine-unrelated'
  const goodStored = identity(goodId)
  const bad = new FakePiRpcProcess()
  configureNewCandidate(bad, badId, badStored.sessionFile)
  bad.getAvailableModels = async () => ({ models: [] })
  const good = new FakePiRpcProcess()
  configureNewCandidate(good, goodId, goodStored.sessionFile)
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  isolateAgentStores(t, agent)
  const originalSpawn = PiRpcProcess.spawn
  let spawnCount = 0
  ;(PiRpcProcess as any).spawn = async () => {
    spawnCount += 1
    return (spawnCount === 1 ? bad : good) as any
  }

  try {
    await assert.rejects(() => agent.newSession({ cwd: badStored.cwd, mcpServers: [] } as any))
    assert.equal(existsSync(badStored.sessionFile), true)
    const sameIdError = await agent
      .prompt({ sessionId: badId, prompt: [{ type: 'text', text: 'blocked ID' }] } as any)
      .then(
        () => null,
        error => error
      )
    assert.equal(sameIdError?.data?.code, 'PI_ACP_SESSION_RECOVERY_UNAVAILABLE')
    assert.equal(spawnCount, 1)

    const created = await agent.newSession({ cwd: goodStored.cwd, mcpServers: [] } as any)
    assert.equal(created.sessionId, goodId)
    assert.equal(spawnCount, 2)
    await agent.dispose()
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: new-session commit failure cleans the inaccessible candidate and retries old proof before respawn', async t => {
  const previousPath = process.env.PATH
  process.env.PATH = ''
  const oldId = 'old-commit-session'
  const oldStored = identity(oldId)
  const firstId = 'first-candidate-session'
  const firstStored = identity(firstId)
  const secondId = 'second-candidate-session'
  const secondStored = identity(secondId)
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  isolateAgentStores(t, agent)
  const sessions = (agent as any).sessions as SessionManager
  const old = new FakePiRpcProcess()
  let oldStopAttempts = 0
  old.stop = async () => {
    old.stopCount += 1
    oldStopAttempts += 1
    if (oldStopAttempts === 1) throw new Error('old cleanup unconfirmed')
    old.terminate()
  }
  sessions.getOrCreate(oldId, {
    cwd: oldStored.cwd,
    mcpServers: [],
    conn: asAgentConn(conn),
    proc: old as any,
    fileCommands: []
  })

  const firstCandidate = new FakePiRpcProcess()
  configureNewCandidate(firstCandidate, firstId, firstStored.sessionFile)
  const secondCandidate = new FakePiRpcProcess()
  configureNewCandidate(secondCandidate, secondId, secondStored.sessionFile)
  let spawnCount = 0
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    spawnCount += 1
    return (spawnCount === 1 ? firstCandidate : secondCandidate) as any
  }

  try {
    const firstError = await agent.newSession({ cwd: firstStored.cwd, mcpServers: [] } as any).then(
      () => null,
      error => error
    )
    assert.equal(firstError?.data?.code, 'PI_ACP_SESSION_RECOVERY_UNAVAILABLE')
    assert.equal(firstCandidate.stopCount, 1)
    assert.equal(sessions.maybeGet(firstId), undefined)
    assert.equal(sessions.maybeGet(oldId)?.proc, old)
    assert.equal(spawnCount, 1)

    const second = await agent.newSession({ cwd: secondStored.cwd, mcpServers: [] } as any)
    assert.equal(second.sessionId, secondId)
    assert.equal(oldStopAttempts, 2)
    assert.equal(spawnCount, 2)
    assert.equal(sessions.maybeGet(oldId), undefined)
    assert.equal(sessions.maybeGet(secondId)?.proc, secondCandidate)
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    PiRpcProcess.spawn = originalSpawn
    await agent.dispose()
  }
})

test('PiAcpAgent: dispose overtaking the new-session commit cannot return a dead published child', async t => {
  const previousPath = process.env.PATH
  process.env.PATH = ''
  const oldId = 'dispose-commit-old'
  const oldStored = identity(oldId)
  const candidateId = 'dispose-commit-candidate'
  const candidateStored = identity(candidateId)
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  const store = isolateAgentStores(t, agent)
  const sessions = (agent as any).sessions as SessionManager
  const old = new FakePiRpcProcess()
  let markOldStopStarted!: () => void
  const oldStopStarted = new Promise<void>(resolve => {
    markOldStopStarted = resolve
  })
  let releaseOldStop!: () => void
  const oldStopGate = new Promise<void>(resolve => {
    releaseOldStop = resolve
  })
  old.stop = async () => {
    old.stopCount += 1
    markOldStopStarted()
    await oldStopGate
    old.terminate()
  }
  sessions.getOrCreate(oldId, {
    cwd: oldStored.cwd,
    mcpServers: [],
    conn: asAgentConn(conn),
    proc: old as any,
    fileCommands: []
  })
  const candidate = new FakePiRpcProcess()
  configureNewCandidate(candidate, candidateId, candidateStored.sessionFile)
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => candidate as any

  try {
    const creating = agent.newSession({ cwd: candidateStored.cwd, mcpServers: [] } as any).then(
      () => null,
      error => error
    )
    await oldStopStarted
    const disposing = agent.dispose()
    releaseOldStop()
    const error = await creating
    await disposing

    assert.equal(error?.data?.code, 'PI_ACP_SESSION_RECOVERY_UNAVAILABLE')
    assert.equal(candidate.stopCount, 1)
    assert.equal(sessions.maybeGet(candidateId), undefined)
    assert.equal(store.get(candidateId), null)
    assert.equal(existsSync(candidateStored.sessionFile), false)
  } finally {
    releaseOldStop()
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    PiRpcProcess.spawn = originalSpawn
    await agent.dispose()
  }
})

test('PiAcpAgent: dispose overtaking load commit rejects and preserves the durable transcript', async t => {
  const oldId = 'dispose-load-old'
  const oldStored = identity(oldId)
  const targetId = 'dispose-load-target'
  const targetStored = identity(targetId)
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  const store = isolateAgentStores(t, agent)
  store.upsert({ sessionId: targetId, cwd: targetStored.cwd, sessionFile: targetStored.sessionFile })
  const sessions = (agent as any).sessions as SessionManager
  const old = new FakePiRpcProcess()
  let markOldStopStarted!: () => void
  const oldStopStarted = new Promise<void>(resolve => {
    markOldStopStarted = resolve
  })
  let releaseOldStop!: () => void
  const oldStopGate = new Promise<void>(resolve => {
    releaseOldStop = resolve
  })
  old.stop = async () => {
    old.stopCount += 1
    markOldStopStarted()
    await oldStopGate
    old.terminate()
  }
  sessions.getOrCreate(oldId, {
    cwd: oldStored.cwd,
    mcpServers: [],
    conn: asAgentConn(conn),
    proc: old as any,
    fileCommands: []
  })
  const target = new FakePiRpcProcess()
  configureNewCandidate(target, targetId, targetStored.sessionFile)
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => target as any

  try {
    const loading = agent.loadSession({ sessionId: targetId, cwd: targetStored.cwd, mcpServers: [] } as any).then(
      () => null,
      error => error
    )
    await oldStopStarted
    const disposing = agent.dispose()
    releaseOldStop()
    const error = await loading
    await disposing

    assert.equal(error?.data?.code, 'PI_ACP_SESSION_RECOVERY_UNAVAILABLE')
    assert.equal(target.stopCount, 1)
    assert.equal(sessions.maybeGet(targetId), undefined)
    assert.equal(store.get(targetId)?.sessionFile, targetStored.sessionFile)
    assert.equal(existsSync(targetStored.sessionFile), true)
  } finally {
    releaseOldStop()
    PiRpcProcess.spawn = originalSpawn
    await agent.dispose()
  }
})

test('PiAcpAgent: explicit new/new and new/load transactions share one response-order tail', async t => {
  await t.test('new then new', async () => {
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()), {} as any)
    const events: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    let invocation = 0
    ;(agent as any).newSessionOwned = async () => {
      invocation += 1
      const current = invocation
      events.push(`start-${String(current)}`)
      if (current === 1) await firstGate
      events.push(`end-${String(current)}`)
      return { sessionId: `session-${String(current)}` }
    }

    const first = agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)
    await new Promise(resolve => setImmediate(resolve))
    const second = agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(events, ['start-1'])
    releaseFirst()
    await Promise.all([first, second])
    assert.deepEqual(events, ['start-1', 'end-1', 'start-2', 'end-2'])
  })

  await t.test('new then load', async () => {
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()), {} as any)
    const events: string[] = []
    let releaseNew!: () => void
    const newGate = new Promise<void>(resolve => {
      releaseNew = resolve
    })
    ;(agent as any).newSessionOwned = async () => {
      events.push('new-start')
      await newGate
      events.push('new-end')
      return { sessionId: 'new-session' }
    }
    ;(agent as any).loadSessionOwned = async () => {
      events.push('load-start')
      return { _meta: {} }
    }

    const creating = agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)
    await new Promise(resolve => setImmediate(resolve))
    const loading = agent.loadSession({ sessionId: 'stored', cwd: process.cwd(), mcpServers: [] } as any)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(events, ['new-start'])
    releaseNew()
    await Promise.all([creating, loading])
    assert.deepEqual(events, ['new-start', 'new-end', 'load-start'])
  })
})
