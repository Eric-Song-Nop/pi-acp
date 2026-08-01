import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent, SESSION_RECOVERY_HANDSHAKE_TIMEOUT_MS } from '../../src/acp/agent.js'
import { SessionManager } from '../../src/acp/session.js'
import { PiRpcProcess, PiRpcProcessTerminatedError, PiRpcSpawnError } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const RECOVERY_CODE = 'PI_ACP_SESSION_RECOVERY_UNAVAILABLE'

function makeDurableSession(sessionId: string): { cwd: string; sessionFile: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-session-recovery-'))
  const sessionFile = join(cwd, `${sessionId}.jsonl`)
  writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: 'session',
      version: 3,
      id: sessionId,
      timestamp: '2026-08-01T00:00:00.000Z',
      cwd
    })}\n`,
    'utf8'
  )
  return { cwd, sessionFile }
}

function installStore(agent: PiAcpAgent, sessionId: string, stored: { cwd: string; sessionFile: string } | null) {
  ;(agent as any).store = {
    get(id: string) {
      return id === sessionId && stored ? { sessionId, ...stored, updatedAt: new Date(0).toISOString() } : null
    },
    upsert() {},
    delete() {}
  }
}

function registerDeadSession(
  agent: PiAcpAgent,
  conn: FakeAgentSideConnection,
  sessionId: string,
  cwd: string,
  configure?: (proc: FakePiRpcProcess) => void
): { proc: FakePiRpcProcess; session: any } {
  const proc = new FakePiRpcProcess()
  configure?.(proc)
  const session = (agent as any).sessions.getOrCreate(sessionId, {
    cwd,
    mcpServers: [],
    conn: asAgentConn(conn),
    proc,
    fileCommands: []
  })
  proc.terminate(
    new PiRpcProcessTerminatedError('The original Pi process exited.', undefined, { kind: 'exit', code: 9 })
  )
  return { proc, session }
}

function configureCandidate(proc: FakePiRpcProcess, sessionId: string, sessionFile: string): void {
  const state = Object.freeze({ sessionId, sessionFile })
  proc.getState = async () => state
  ;(proc as any).getStartupHandshakeState = () => state
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  assert.fail(message)
}

test('PiAcpAgent: C1.5 dead-session recovery completes before unsupported built-in refusal', async () => {
  const sessionId = 'c1.5-recovered-refusal-session'
  const stored = makeDurableSession(sessionId)
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  installStore(agent, sessionId, stored)
  const old = registerDeadSession(agent, conn, sessionId, stored.cwd)
  const candidate = new FakePiRpcProcess()
  configureCandidate(candidate, sessionId, stored.sessionFile)
  let spawnCount = 0
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    spawnCount += 1
    return candidate as any
  }

  try {
    const result = await agent.prompt({
      sessionId,
      prompt: [{ type: 'text', text: '/trust C1_5_RECOVERED_REFUSAL_SECRET' }]
    } as any)

    assert.equal(result.stopReason, 'refusal')
    assert.equal((result._meta as any)?.piAcp?.diagnostic?.code, 'PI_ACP_UNSUPPORTED_PI_BUILTIN')
    assert.equal((result._meta as any)?.piAcp?.diagnostic?.command, 'trust')
    assert.equal(spawnCount, 1)
    assert.equal(old.proc.stopCount, 1)
    assert.equal(candidate.prompts.length, 0)
    assert.equal((agent as any).sessions.maybeGet(sessionId)?.proc, candidate)
  } finally {
    PiRpcProcess.spawn = originalSpawn
    await agent.dispose()
  }
})

test('PiAcpAgent: C1.5 dead-session recovery failure wins over unsupported built-in refusal', async () => {
  const sessionId = 'c1.5-recovery-failure-refusal-session'
  const stored = makeDurableSession(sessionId)
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  installStore(agent, sessionId, stored)
  const old = registerDeadSession(agent, conn, sessionId, stored.cwd, proc => {
    proc.stop = async () => {
      proc.stopCount += 1
      throw new Error('C1.5 old-generation cleanup remains unconfirmed')
    }
  })
  let spawnCount = 0
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    spawnCount += 1
    throw new Error('C1.5 must not spawn after unconfirmed old-generation cleanup')
  }

  try {
    const error = await agent
      .prompt({
        sessionId,
        prompt: [{ type: 'text', text: '/trust C1_5_RECOVERY_FAILURE_SECRET' }]
      } as any)
      .then(
        () => null,
        failure => failure
      )

    assert.equal(error?.code, -32603)
    assert.equal(error?.data?.code, RECOVERY_CODE)
    assert.equal(spawnCount, 0)
    assert.equal((agent as any).sessions.maybeGet(sessionId), old.session)
  } finally {
    PiRpcProcess.spawn = originalSpawn
    await agent.dispose().catch(() => undefined)
  }
})

test('PiAcpAgent: concurrent post-terminal requests coalesce one validated generation restore', async () => {
  const sessionId = 'coalesced-session'
  const stored = makeDurableSession(sessionId)
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  installStore(agent, sessionId, stored)
  const old = registerDeadSession(agent, conn, sessionId, stored.cwd)
  const candidate = new FakePiRpcProcess()
  configureCandidate(candidate, sessionId, stored.sessionFile)
  let spawnCount = 0
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    spawnCount += 1
    return candidate as any
  }

  try {
    const first = agent.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'first fresh request' }]
    } as any)
    const second = agent.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'second fresh request' }]
    } as any)

    await waitUntil(() => candidate.prompts.length === 1, 'restored session did not start the first request')
    candidate.emit({ type: 'agent_settled' })
    await waitUntil(() => candidate.prompts.length === 2, 'restored session did not hand off the queued request')
    // Pi starts the successor's own loop before its authoritative settled event.
    candidate.emit({ type: 'agent_start' })
    candidate.emit({ type: 'agent_settled' })

    assert.deepEqual(await Promise.all([first, second]), [{ stopReason: 'end_turn' }, { stopReason: 'end_turn' }])
    assert.equal(spawnCount, 1)
    assert.equal(old.proc.stopCount, 1)
    assert.equal((agent as any).sessions.snapshot(sessionId).generation, 2)
    assert.equal((agent as any).sessions.maybeGet(sessionId).proc, candidate)
    old.proc.emit({ type: 'agent_settled' })
    assert.equal((agent as any).sessions.maybeGet(sessionId).proc, candidate)
  } finally {
    PiRpcProcess.spawn = originalSpawn
    await agent.dispose()
  }
})

test('PiAcpAgent: automatic dead-session recovery leaves a healthy sibling registered and untouched', async () => {
  const deadId = 'dead-session-with-healthy-sibling'
  const healthyId = 'healthy-sibling-session'
  const stored = makeDurableSession(deadId)
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  installStore(agent, deadId, stored)
  registerDeadSession(agent, conn, deadId, stored.cwd)

  const healthyProc = new FakePiRpcProcess()
  ;(agent as any).sessions.getOrCreate(healthyId, {
    cwd: stored.cwd,
    mcpServers: [],
    conn: asAgentConn(conn),
    proc: healthyProc,
    fileCommands: []
  })
  const replacement = new FakePiRpcProcess()
  configureCandidate(replacement, deadId, stored.sessionFile)
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => replacement as any

  try {
    const prompt = agent.prompt({
      sessionId: deadId,
      prompt: [{ type: 'text', text: 'restore only the dead session' }]
    } as any)
    await waitUntil(() => replacement.prompts.length === 1, 'dead session did not restore')
    replacement.emit({ type: 'agent_settled' })

    assert.deepEqual(await prompt, { stopReason: 'end_turn' })
    assert.equal(healthyProc.stopCount, 0)
    assert.equal((agent as any).sessions.maybeGet(healthyId)?.proc, healthyProc)
    assert.equal((agent as any).sessions.maybeGet(deadId)?.proc, replacement)
  } finally {
    PiRpcProcess.spawn = originalSpawn
    await agent.dispose()
  }
})

test('PiAcpAgent: superseded failed-new cleanup returns a live CAS winner to the recovery leader', async () => {
  const sessionId = 'superseded-cleanup-live-winner'
  const stored = makeDurableSession(sessionId)
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  let mappingDeletes = 0
  ;(agent as any).store = {
    get(id: string) {
      return id === sessionId ? { sessionId, ...stored, updatedAt: new Date(0).toISOString() } : null
    },
    upsert() {},
    delete() {
      mappingDeletes += 1
    }
  }

  const sessions = (agent as any).sessions as SessionManager
  const staleProc = new FakePiRpcProcess()
  const stale = sessions.getOrCreate(sessionId, {
    cwd: stored.cwd,
    mcpServers: [],
    conn: asAgentConn(conn),
    proc: staleProc as any,
    fileCommands: []
  })
  await sessions.close(sessionId, stale)
  ;(agent as any).pendingFailedNewSessionCleanups.add(stale)

  const winnerProc = new FakePiRpcProcess()
  const winner = sessions.createDetached(sessionId, {
    cwd: stored.cwd,
    mcpServers: [],
    conn: asAgentConn(conn),
    proc: winnerProc as any,
    fileCommands: []
  })
  let spawnCount = 0
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    spawnCount += 1
    throw new Error('a live CAS winner must bypass replacement spawn')
  }

  try {
    const prompt = agent.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'use the concurrent winner' }]
    } as any)
    assert.equal(sessions.publishReplacement(sessionId, 1, winner), true)
    await waitUntil(() => winnerProc.prompts.length === 1, 'recovery leader did not use the live CAS winner')
    winnerProc.emit({ type: 'agent_settled' })

    assert.deepEqual(await prompt, { stopReason: 'end_turn' })
    assert.equal(spawnCount, 0)
    assert.equal(mappingDeletes, 0)
    assert.equal(existsSync(stored.sessionFile), true)
    assert.equal(sessions.maybeGet(sessionId), winner)
    assert.equal((agent as any).pendingFailedNewSessionCleanups.size, 0)
  } finally {
    PiRpcProcess.spawn = originalSpawn
    await agent.dispose()
  }
})

test('PiAcpAgent: recovery preserves exact ID/file when the mutable load cwd differs from the JSONL header cwd', async () => {
  const sessionId = 'relocated-cwd-session'
  const durable = makeDurableSession(sessionId)
  const loadedCwd = mkdtempSync(join(tmpdir(), 'pi-acp-relocated-cwd-'))
  const stored = { cwd: loadedCwd, sessionFile: durable.sessionFile }
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  installStore(agent, sessionId, stored)
  registerDeadSession(agent, conn, sessionId, loadedCwd)
  const candidate = new FakePiRpcProcess()
  configureCandidate(candidate, sessionId, durable.sessionFile)
  let spawnCwd: string | undefined
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    spawnCwd = params.cwd
    return candidate as any
  }

  try {
    const prompt = agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'fresh' }] } as any)
    await waitUntil(() => candidate.prompts.length === 1, 'relocated session did not restore')
    candidate.emit({ type: 'agent_settled' })

    assert.deepEqual(await prompt, { stopReason: 'end_turn' })
    assert.equal(spawnCwd, loadedCwd)
    assert.equal((agent as any).sessions.maybeGet(sessionId).proc, candidate)
  } finally {
    PiRpcProcess.spawn = originalSpawn
    await agent.dispose()
  }
})

test('PiAcpAgent: replacement publication waits for the settled old-turn barrier', async () => {
  const sessionId = 'turn-barrier-session'
  const stored = makeDurableSession(sessionId)
  let releaseUpdate!: () => void
  const updateGate = new Promise<void>(resolve => {
    releaseUpdate = resolve
  })
  let blockNextUpdate = true

  class GatedConnection extends FakeAgentSideConnection {
    override async sessionUpdate(msg: Parameters<FakeAgentSideConnection['sessionUpdate']>[0]): Promise<void> {
      this.updates.push(msg)
      if (blockNextUpdate) {
        blockNextUpdate = false
        await updateGate
      }
    }
  }

  const conn = new GatedConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  installStore(agent, sessionId, stored)
  const oldProc = new FakePiRpcProcess()
  const oldSession = (agent as any).sessions.getOrCreate(sessionId, {
    cwd: stored.cwd,
    mcpServers: [],
    conn: asAgentConn(conn),
    proc: oldProc,
    fileCommands: []
  })
  const oldPrompt = oldSession.prompt('already accepted')
  oldProc.emit({ type: 'agent_settled' })
  oldProc.terminate(
    new PiRpcProcessTerminatedError('The old process exited after settling.', undefined, { kind: 'exit' })
  )

  const candidate = new FakePiRpcProcess()
  configureCandidate(candidate, sessionId, stored.sessionFile)
  let spawnCount = 0
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    spawnCount += 1
    return candidate as any
  }

  try {
    const fresh = agent.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'fresh request' }]
    } as any)
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(spawnCount, 0)

    releaseUpdate()
    assert.equal(await oldPrompt, 'end_turn')
    await waitUntil(() => candidate.prompts.length === 1, 'replacement was not published after the old turn barrier')
    candidate.emit({ type: 'agent_settled' })

    assert.deepEqual(await fresh, { stopReason: 'end_turn' })
    assert.equal(spawnCount, 1)
  } finally {
    PiRpcProcess.spawn = originalSpawn
    await agent.dispose()
  }
})

test('PiAcpAgent: unconfirmed old-generation teardown rejects peers and publishes no replacement', async () => {
  const sessionId = 'unclean-session'
  const stored = makeDurableSession(sessionId)
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  installStore(agent, sessionId, stored)
  const old = registerDeadSession(agent, conn, sessionId, stored.cwd, proc => {
    proc.stop = async () => {
      proc.stopCount += 1
      throw new Error('cleanup unconfirmed')
    }
  })
  let spawnCount = 0
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    spawnCount += 1
    throw new Error('must not spawn')
  }

  try {
    const observe = () =>
      agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'fresh' }] } as any).then(
        () => null,
        error => error
      )
    const [firstError, secondError] = await Promise.all([observe(), observe()])

    assert.equal(firstError, secondError)
    assert.equal(firstError?.code, -32603)
    assert.equal(firstError?.data?.code, RECOVERY_CODE)
    assert.equal(spawnCount, 0)
    assert.equal((agent as any).sessions.maybeGet(sessionId), old.session)
  } finally {
    PiRpcProcess.spawn = originalSpawn
    await agent.dispose().catch(() => undefined)
  }
})

test('PiAcpAgent: a later request retries old teardown and restores only after cleanup becomes proven', async () => {
  const sessionId = 'retry-old-cleanup-session'
  const stored = makeDurableSession(sessionId)
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  installStore(agent, sessionId, stored)
  let stopAttempts = 0
  registerDeadSession(agent, conn, sessionId, stored.cwd, proc => {
    proc.stop = async () => {
      proc.stopCount += 1
      stopAttempts += 1
      if (stopAttempts === 1) throw new Error('first cleanup unconfirmed')
    }
  })
  const candidate = new FakePiRpcProcess()
  configureCandidate(candidate, sessionId, stored.sessionFile)
  let spawnCount = 0
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    spawnCount += 1
    return candidate as any
  }

  try {
    const firstError = await agent
      .prompt({ sessionId, prompt: [{ type: 'text', text: 'first fresh request' }] } as any)
      .then(
        () => null,
        error => error
      )
    assert.equal(firstError?.data?.code, RECOVERY_CODE)
    assert.equal(spawnCount, 0)

    const second = agent.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'second fresh request' }]
    } as any)
    await waitUntil(() => candidate.prompts.length === 1, 'second request did not restore after proven cleanup')
    candidate.emit({ type: 'agent_settled' })

    assert.deepEqual(await second, { stopReason: 'end_turn' })
    assert.equal(stopAttempts, 2)
    assert.equal(spawnCount, 1)
    assert.equal((agent as any).sessions.snapshot(sessionId).generation, 2)
  } finally {
    PiRpcProcess.spawn = originalSpawn
    await agent.dispose()
  }
})

test('PiAcpAgent: a candidate with the wrong restored identity is stopped and never published', async () => {
  const sessionId = 'identity-session'
  const stored = makeDurableSession(sessionId)
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  installStore(agent, sessionId, stored)
  registerDeadSession(agent, conn, sessionId, stored.cwd)
  const candidate = new FakePiRpcProcess()
  configureCandidate(candidate, 'wrong-session', stored.sessionFile)
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => candidate as any

  try {
    const error = await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'fresh' }] } as any).then(
      () => null,
      failure => failure
    )

    assert.equal(error?.code, -32603)
    assert.equal(error?.data?.code, RECOVERY_CODE)
    assert.equal(candidate.stopCount, 1)
    assert.equal((agent as any).sessions.maybeGet(sessionId), undefined)
    assert.equal((agent as any).sessions.currentGeneration(sessionId), 1)
  } finally {
    PiRpcProcess.spawn = originalSpawn
    await agent.dispose()
  }
})

test('PiAcpAgent: dead-generation tombstone retries keep the stable recovery envelope on later spawn failure', async () => {
  const sessionId = 'dead-lineage-spawn-failure-session'
  const stored = makeDurableSession(sessionId)
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  installStore(agent, sessionId, stored)
  registerDeadSession(agent, conn, sessionId, stored.cwd)
  const firstCandidate = new FakePiRpcProcess()
  configureCandidate(firstCandidate, 'wrong-session', stored.sessionFile)
  let spawnCount = 0
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    spawnCount += 1
    if (spawnCount === 1) return firstCandidate as any
    throw new PiRpcSpawnError('Later recovery spawn failed.', { code: 'PI_RPC_SPAWN_FAILED' })
  }

  try {
    const observe = () =>
      agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'fresh' }] } as any).then(
        () => null,
        error => error
      )
    const firstError = await observe()
    const secondError = await observe()

    assert.equal(firstError?.code, -32603)
    assert.equal(firstError?.data?.code, RECOVERY_CODE)
    assert.equal(secondError?.code, -32603)
    assert.equal(secondError?.data?.code, RECOVERY_CODE)
    assert.equal(spawnCount, 2)
    assert.equal(firstCandidate.stopCount, 1)
  } finally {
    PiRpcProcess.spawn = originalSpawn
    await agent.dispose()
  }
})

test('PiAcpAgent: a candidate with the right ID but wrong restored file is stopped and never published', async () => {
  const sessionId = 'wrong-file-session'
  const stored = makeDurableSession(sessionId)
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  installStore(agent, sessionId, stored)
  registerDeadSession(agent, conn, sessionId, stored.cwd)
  const candidate = new FakePiRpcProcess()
  configureCandidate(candidate, sessionId, join(stored.cwd, 'different.jsonl'))
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => candidate as any

  try {
    const error = await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'fresh' }] } as any).then(
      () => null,
      failure => failure
    )

    assert.equal(error?.code, -32603)
    assert.equal(error?.data?.code, RECOVERY_CODE)
    assert.equal(candidate.stopCount, 1)
    assert.equal((agent as any).sessions.maybeGet(sessionId), undefined)
  } finally {
    PiRpcProcess.spawn = originalSpawn
    await agent.dispose()
  }
})

test('PiAcpAgent: a candidate that dies after exact identity handshake is stopped and never published', async () => {
  const sessionId = 'dead-before-publish-session'
  const stored = makeDurableSession(sessionId)
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  installStore(agent, sessionId, stored)
  registerDeadSession(agent, conn, sessionId, stored.cwd)
  const candidate = new FakePiRpcProcess()
  configureCandidate(candidate, sessionId, stored.sessionFile)
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    candidate.terminate(
      new PiRpcProcessTerminatedError('Candidate exited after identity response.', undefined, {
        kind: 'exit',
        code: 41
      })
    )
    return candidate as any
  }

  try {
    const error = await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'fresh' }] } as any).then(
      () => null,
      failure => failure
    )

    assert.equal(error?.code, -32603)
    assert.equal(error?.data?.code, RECOVERY_CODE)
    assert.equal(candidate.stopCount, 1)
    assert.equal((agent as any).sessions.maybeGet(sessionId), undefined)
  } finally {
    PiRpcProcess.spawn = originalSpawn
    await agent.dispose()
  }
})

test('PiAcpAgent: unconfirmed losing-candidate cleanup blocks later requests from spawning around it', async () => {
  const sessionId = 'blocked-candidate-session'
  const stored = makeDurableSession(sessionId)
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  installStore(agent, sessionId, stored)
  registerDeadSession(agent, conn, sessionId, stored.cwd)
  const candidate = new FakePiRpcProcess()
  configureCandidate(candidate, 'wrong-session', stored.sessionFile)
  candidate.stop = async () => {
    candidate.stopCount += 1
    throw new Error('candidate cleanup unconfirmed')
  }
  let spawnCount = 0
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    spawnCount += 1
    return candidate as any
  }

  try {
    const observe = () =>
      agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'fresh' }] } as any).then(
        () => null,
        error => error
      )
    const firstError = await observe()
    const secondError = await observe()

    assert.equal(firstError, secondError)
    assert.equal(firstError?.data?.code, RECOVERY_CODE)
    assert.equal(spawnCount, 1)
    assert.equal((agent as any).sessions.maybeGet(sessionId), undefined)
    assert.equal((agent as any).restoringSessions.get(sessionId).candidate, candidate)
  } finally {
    PiRpcProcess.spawn = originalSpawn
    await agent.dispose().catch(() => undefined)
  }
})

test('PiAcpAgent: CAS-loser cleanup is retained and concurrent retry peers coalesce the next restore', async () => {
  const sessionId = 'cas-loser-cleanup-session'
  const stored = makeDurableSession(sessionId)
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  installStore(agent, sessionId, stored)
  registerDeadSession(agent, conn, sessionId, stored.cwd)

  const losingCandidate = new FakePiRpcProcess()
  configureCandidate(losingCandidate, sessionId, stored.sessionFile)
  let losingStopAttempts = 0
  losingCandidate.stop = async () => {
    losingCandidate.stopCount += 1
    losingStopAttempts += 1
    if (losingStopAttempts === 1) throw new Error('CAS loser cleanup unconfirmed')
    losingCandidate.terminate()
  }
  const replacement = new FakePiRpcProcess()
  configureCandidate(replacement, sessionId, stored.sessionFile)
  let spawnCount = 0
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    spawnCount += 1
    return (spawnCount === 1 ? losingCandidate : replacement) as any
  }

  const sessions = (agent as any).sessions
  const originalPublish = sessions.publishReplacement.bind(sessions)
  let publishAttempts = 0
  sessions.publishReplacement = (...args: any[]) => {
    publishAttempts += 1
    if (publishAttempts === 1) return false
    return originalPublish(...args)
  }

  try {
    const firstError = await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'first' }] } as any).then(
      () => null,
      error => error
    )
    assert.equal(firstError?.data?.code, RECOVERY_CODE)
    assert.equal(spawnCount, 1)
    assert.equal(losingStopAttempts, 1)
    assert.equal((agent as any).restoringSessions.get(sessionId).candidate, losingCandidate)

    const retryOne = agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'retry one' }] } as any)
    const retryTwo = agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'retry two' }] } as any)
    await waitUntil(() => replacement.prompts.length === 1, 'retry peers did not coalesce the replacement')
    replacement.emit({ type: 'agent_settled' })
    await waitUntil(() => replacement.prompts.length === 2, 'second retry peer was not queued on the replacement')
    replacement.emit({ type: 'agent_start' })
    replacement.emit({ type: 'agent_settled' })

    assert.deepEqual(await Promise.all([retryOne, retryTwo]), [{ stopReason: 'end_turn' }, { stopReason: 'end_turn' }])
    assert.equal(losingStopAttempts, 2)
    assert.equal(spawnCount, 2)
    assert.equal(publishAttempts, 2)
    assert.equal((agent as any).sessions.maybeGet(sessionId).proc, replacement)
  } finally {
    sessions.publishReplacement = originalPublish
    PiRpcProcess.spawn = originalSpawn
    await agent.dispose()
  }
})

test('PiAcpAgent: a CAS loser cannot clobber the winner mapping and later recovery uses the winner file', async () => {
  const sessionId = 'cas-winner-mapping-session'
  const originalStored = makeDurableSession(sessionId)
  const winnerStored = makeDurableSession(sessionId)
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  let currentStored = { ...originalStored }
  ;(agent as any).store = {
    get(id: string) {
      return id === sessionId ? { sessionId, ...currentStored, updatedAt: new Date(0).toISOString() } : null
    },
    upsert(value: { cwd: string; sessionFile: string }) {
      currentStored = { cwd: value.cwd, sessionFile: value.sessionFile }
    },
    delete() {}
  }
  registerDeadSession(agent, conn, sessionId, originalStored.cwd)

  const losingCandidate = new FakePiRpcProcess()
  configureCandidate(losingCandidate, sessionId, originalStored.sessionFile)
  const winnerProc = new FakePiRpcProcess()
  const laterCandidate = new FakePiRpcProcess()
  configureCandidate(laterCandidate, sessionId, winnerStored.sessionFile)
  const spawnPaths: string[] = []
  let spawnCount = 0
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    spawnCount += 1
    spawnPaths.push(params.sessionPath)
    return (spawnCount === 1 ? losingCandidate : laterCandidate) as any
  }

  const sessions = (agent as any).sessions
  const originalPublish = sessions.publishReplacement.bind(sessions)
  let publishAttempts = 0
  sessions.publishReplacement = (...args: any[]) => {
    publishAttempts += 1
    if (publishAttempts === 1) {
      currentStored = { ...winnerStored }
      sessions.getOrCreate(sessionId, {
        cwd: winnerStored.cwd,
        mcpServers: [],
        conn: asAgentConn(conn),
        proc: winnerProc,
        fileCommands: []
      })
      return false
    }
    return originalPublish(...args)
  }

  try {
    const first = agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'winner request' }] } as any)
    await waitUntil(() => winnerProc.prompts.length === 1, 'CAS winner did not receive the request')
    winnerProc.emit({ type: 'agent_settled' })
    assert.deepEqual(await first, { stopReason: 'end_turn' })
    assert.equal(losingCandidate.stopCount, 1)
    assert.equal(currentStored.sessionFile, winnerStored.sessionFile)

    winnerProc.terminate(new PiRpcProcessTerminatedError('Winner later exited.', undefined, { kind: 'exit', code: 44 }))
    const second = agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'recover winner' }] } as any)
    await waitUntil(() => laterCandidate.prompts.length === 1, 'winner mapping was not used for later recovery')
    laterCandidate.emit({ type: 'agent_settled' })
    assert.deepEqual(await second, { stopReason: 'end_turn' })
    assert.deepEqual(spawnPaths, [originalStored.sessionFile, winnerStored.sessionFile])
    assert.equal(currentStored.sessionFile, winnerStored.sessionFile)
  } finally {
    sessions.publishReplacement = originalPublish
    PiRpcProcess.spawn = originalSpawn
    await agent.dispose()
  }
})

test('PiAcpAgent: delete during blocked-cleanup retry prevents any successor spawn', async () => {
  const sessionId = 'delete-during-cleanup-retry-session'
  const stored = makeDurableSession(sessionId)
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  installStore(agent, sessionId, stored)
  registerDeadSession(agent, conn, sessionId, stored.cwd)
  const candidate = new FakePiRpcProcess()
  configureCandidate(candidate, 'wrong-session', stored.sessionFile)
  let releaseCleanup!: () => void
  const cleanupGate = new Promise<void>(resolve => {
    releaseCleanup = resolve
  })
  let markRetryStarted!: () => void
  const retryStarted = new Promise<void>(resolve => {
    markRetryStarted = resolve
  })
  let stopAttempts = 0
  candidate.stop = async () => {
    candidate.stopCount += 1
    stopAttempts += 1
    if (stopAttempts === 1) throw new Error('initial candidate cleanup unconfirmed')
    markRetryStarted()
    await cleanupGate
    candidate.terminate()
  }
  let spawnCount = 0
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    spawnCount += 1
    return candidate as any
  }

  try {
    const firstError = await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'first' }] } as any).then(
      () => null,
      error => error
    )
    assert.equal(firstError?.data?.code, RECOVERY_CODE)

    const retry = agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'retry' }] } as any).then(
      () => null,
      error => error
    )
    await retryStarted
    const deleting = agent.deleteSession({ sessionId } as any)
    releaseCleanup()
    const retryError = await retry
    await deleting

    assert.equal(retryError?.data?.code, RECOVERY_CODE)
    assert.equal(spawnCount, 1)
    assert.equal((agent as any).sessions.maybeGet(sessionId), undefined)
    assert.equal((agent as any).sessions.currentGeneration(sessionId), 0)
  } finally {
    PiRpcProcess.spawn = originalSpawn
    await agent.dispose()
  }
})

test('PiAcpAgent: hidden handshake-timeout candidate is retried before any later replacement spawn', async () => {
  const sessionId = 'hidden-timeout-candidate-session'
  const stored = makeDurableSession(sessionId)
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  installStore(agent, sessionId, stored)
  registerDeadSession(agent, conn, sessionId, stored.cwd)

  const hiddenCandidate = new FakePiRpcProcess()
  // PiRpcSpawnError.candidate means spawn already made one bounded cleanup
  // attempt internally; the recovery layer must not repeat it immediately.
  let hiddenStopAttempts = 1
  hiddenCandidate.stop = async () => {
    hiddenCandidate.stopCount += 1
    hiddenStopAttempts += 1
    if (hiddenStopAttempts < 3) throw new Error('hidden candidate still live')
  }
  const replacement = new FakePiRpcProcess()
  configureCandidate(replacement, sessionId, stored.sessionFile)
  let spawnCount = 0
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    spawnCount += 1
    if (spawnCount === 1) {
      throw new PiRpcSpawnError('Recovery handshake timed out.', {
        code: 'PI_RPC_HANDSHAKE_TIMEOUT',
        candidate: hiddenCandidate as any
      })
    }
    return replacement as any
  }

  try {
    const observe = () =>
      agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'fresh' }] } as any).then(
        () => null,
        error => error
      )
    const firstError = await observe()
    const secondError = await observe()

    assert.equal(firstError, secondError)
    assert.equal(firstError?.data?.code, RECOVERY_CODE)
    assert.equal(spawnCount, 1)
    assert.equal(hiddenStopAttempts, 2)

    const third = agent.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'after proven cleanup' }]
    } as any)
    await waitUntil(() => replacement.prompts.length === 1, 'replacement did not start after hidden cleanup')
    replacement.emit({ type: 'agent_settled' })

    assert.deepEqual(await third, { stopReason: 'end_turn' })
    assert.equal(hiddenStopAttempts, 3)
    assert.equal(spawnCount, 2)
  } finally {
    PiRpcProcess.spawn = originalSpawn
    await agent.dispose()
  }
})

test('PiAcpAgent: unregistered spawn failure with unconfirmed candidate cleanup uses the stable recovery envelope', async () => {
  const sessionId = 'unregistered-hidden-candidate-session'
  const stored = makeDurableSession(sessionId)
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  installStore(agent, sessionId, stored)
  const hiddenCandidate = new FakePiRpcProcess()
  hiddenCandidate.stop = async () => {
    hiddenCandidate.stopCount += 1
    throw new Error('hidden candidate cleanup unconfirmed')
  }
  let spawnCount = 0
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    spawnCount += 1
    throw new PiRpcSpawnError('Recovery handshake failed.', {
      code: 'PI_RPC_HANDSHAKE_TIMEOUT',
      candidate: hiddenCandidate as any
    })
  }

  try {
    const observe = () =>
      agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'fresh' }] } as any).then(
        () => null,
        error => error
      )
    const firstError = await observe()
    const secondError = await observe()

    assert.equal(firstError, secondError)
    assert.equal(firstError?.code, -32603)
    assert.equal(firstError?.data?.code, RECOVERY_CODE)
    assert.equal(spawnCount, 1)
    assert.equal(hiddenCandidate.stopCount, 1)
    assert.equal((agent as any).restoringSessions.get(sessionId).candidate, hiddenCandidate)
    assert.deepEqual((agent as any).store.get(sessionId)?.sessionFile, stored.sessionFile)
  } finally {
    PiRpcProcess.spawn = originalSpawn
    await agent.dispose().catch(() => undefined)
  }
})

test('PiAcpAgent: missing, corrupt, and stale dead-generation mappings fail before replacement spawn', async t => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  const emptyAgentDir = mkdtempSync(join(tmpdir(), 'pi-acp-empty-agent-dir-'))
  mkdirSync(join(emptyAgentDir, 'sessions'), { recursive: true })
  process.env.PI_CODING_AGENT_DIR = emptyAgentDir

  const cases: Array<{ name: string; stored: (sessionId: string) => { cwd: string; sessionFile: string } | null }> = [
    { name: 'missing', stored: () => null },
    {
      name: 'corrupt',
      stored: sessionId => {
        const entry = makeDurableSession(sessionId)
        writeFileSync(entry.sessionFile, '{not-json}\n', 'utf8')
        return entry
      }
    },
    {
      name: 'stale',
      stored: sessionId => {
        const entry = makeDurableSession(sessionId)
        return { ...entry, sessionFile: join(entry.cwd, 'missing.jsonl') }
      }
    }
  ]

  try {
    for (const item of cases) {
      await t.test(item.name, async () => {
        const sessionId = `${item.name}-mapping-session`
        const stored = item.stored(sessionId)
        const cwd = stored?.cwd ?? mkdtempSync(join(tmpdir(), 'pi-acp-missing-mapping-'))
        const conn = new FakeAgentSideConnection()
        const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
        installStore(agent, sessionId, stored)
        registerDeadSession(agent, conn, sessionId, cwd)
        let spawnCount = 0
        const originalSpawn = PiRpcProcess.spawn
        ;(PiRpcProcess as any).spawn = async () => {
          spawnCount += 1
          throw new Error('must not spawn')
        }

        try {
          const error = await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'fresh' }] } as any).then(
            () => null,
            failure => failure
          )
          assert.equal(error?.code, -32603)
          assert.equal(error?.data?.code, RECOVERY_CODE)
          if (item.name === 'missing') {
            const retryError = await agent
              .prompt({ sessionId, prompt: [{ type: 'text', text: 'fresh retry' }] } as any)
              .then(
                () => null,
                failure => failure
              )
            assert.equal(retryError?.code, -32603)
            assert.equal(retryError?.data?.code, RECOVERY_CODE)

            await agent.deleteSession({ sessionId } as any)
            const deletedError = await agent
              .prompt({ sessionId, prompt: [{ type: 'text', text: 'after explicit delete' }] } as any)
              .then(
                () => null,
                failure => failure
              )
            assert.equal(deletedError?.code, -32602)
          }
          assert.equal(spawnCount, 0)
          assert.equal((agent as any).sessions.maybeGet(sessionId), undefined)
        } finally {
          PiRpcProcess.spawn = originalSpawn
          await agent.dispose()
        }
      })
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
  }
})

test('PiAcpAgent: corrupt, stale, and wrong-header stored mappings fail with no registered generation', async t => {
  const cases: Array<{
    name: string
    stored: (sessionId: string) => { cwd: string; sessionFile: string }
  }> = [
    {
      name: 'corrupt',
      stored: sessionId => {
        const entry = makeDurableSession(sessionId)
        writeFileSync(entry.sessionFile, '{not-json}\n', 'utf8')
        return entry
      }
    },
    {
      name: 'stale',
      stored: sessionId => {
        const entry = makeDurableSession(sessionId)
        return { ...entry, sessionFile: join(entry.cwd, 'missing.jsonl') }
      }
    },
    {
      name: 'wrong-header',
      stored: sessionId => {
        const entry = makeDurableSession(sessionId)
        writeFileSync(
          entry.sessionFile,
          `${JSON.stringify({ type: 'session', version: 3, id: 'different-session', cwd: entry.cwd })}\n`,
          'utf8'
        )
        return entry
      }
    },
    {
      name: 'malformed-header',
      stored: sessionId => {
        const entry = makeDurableSession(sessionId)
        writeFileSync(
          entry.sessionFile,
          `${JSON.stringify({ type: 'session', version: '3', id: sessionId })}\n`,
          'utf8'
        )
        return entry
      }
    }
  ]

  for (const item of cases) {
    await t.test(item.name, async () => {
      const sessionId = `unregistered-${item.name}`
      const stored = item.stored(sessionId)
      const conn = new FakeAgentSideConnection()
      const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
      installStore(agent, sessionId, stored)
      let spawnCount = 0
      const originalSpawn = PiRpcProcess.spawn
      ;(PiRpcProcess as any).spawn = async () => {
        spawnCount += 1
        throw new Error('must not spawn')
      }

      try {
        const error = await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'fresh' }] } as any).then(
          () => null,
          failure => failure
        )
        assert.equal(error?.code, -32603)
        assert.equal(error?.data?.code, RECOVERY_CODE)
        assert.equal(spawnCount, 0)
      } finally {
        PiRpcProcess.spawn = originalSpawn
        await agent.dispose()
      }
    })
  }
})

test('PiAcpAgent: dispose during restore stops the candidate, rejects the request, and publishes nothing', async () => {
  const sessionId = 'dispose-recovery-session'
  const stored = makeDurableSession(sessionId)
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  installStore(agent, sessionId, stored)
  registerDeadSession(agent, conn, sessionId, stored.cwd)
  const candidate = new FakePiRpcProcess()
  configureCandidate(candidate, sessionId, stored.sessionFile)
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

  try {
    const prompt = agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'fresh' }] } as any).then(
      () => null,
      error => error
    )
    await spawnStarted
    const disposing = agent.dispose()
    releaseSpawn()

    const error = await prompt
    await disposing
    assert.equal(error?.code, -32603)
    assert.equal(error?.data?.code, RECOVERY_CODE)
    assert.equal(candidate.stopCount, 1)
    assert.equal((agent as any).sessions.maybeGet(sessionId), undefined)
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test(
  'PiAcpAgent: a near-budget spawn handshake is reused and never starts a second stuck identity probe',
  { timeout: SESSION_RECOVERY_HANDSHAKE_TIMEOUT_MS + 3_000 },
  async () => {
    const sessionId = 'stuck-handshake-session'
    const stored = makeDurableSession(sessionId)
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    installStore(agent, sessionId, stored)
    registerDeadSession(agent, conn, sessionId, stored.cwd)
    const candidate = new FakePiRpcProcess()
    configureCandidate(candidate, sessionId, stored.sessionFile)
    let secondProbeCount = 0
    candidate.getState = async () => {
      secondProbeCount += 1
      return new Promise<any>(() => {})
    }
    let markSpawnReturned!: () => void
    const spawnReturned = new Promise<void>(resolve => {
      markSpawnReturned = resolve
    })
    const originalSpawn = PiRpcProcess.spawn
    ;(PiRpcProcess as any).spawn = async () => {
      await new Promise(resolve => setTimeout(resolve, SESSION_RECOVERY_HANDSHAKE_TIMEOUT_MS - 150))
      markSpawnReturned()
      return candidate as any
    }

    try {
      const startedAt = Date.now()
      const prompt = agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'fresh' }] } as any)
      await spawnReturned
      await waitUntil(() => candidate.prompts.length === 1, 'cached recovery handshake was not published')
      candidate.emit({ type: 'agent_settled' })
      assert.deepEqual(await prompt, { stopReason: 'end_turn' })
      const elapsedMs = Date.now() - startedAt

      assert.equal(secondProbeCount, 0)
      assert.ok(
        elapsedMs < SESSION_RECOVERY_HANDSHAKE_TIMEOUT_MS + 750,
        `recovery exceeded its single handshake budget: ${elapsedMs}ms`
      )
      assert.equal((agent as any).sessions.maybeGet(sessionId)?.proc, candidate)
    } finally {
      PiRpcProcess.spawn = originalSpawn
      await agent.dispose()
    }
  }
)

test('PiAcpAgent: delete never unlinks a cached file whose header belongs to another session', async () => {
  const sessionId = 'safe-delete-session'
  const unrelatedId = 'unrelated-session'
  const unrelated = makeDurableSession(unrelatedId)
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  let deleted = false
  ;(agent as any).store = {
    get(id: string) {
      return id === sessionId && !deleted
        ? { sessionId, cwd: unrelated.cwd, sessionFile: unrelated.sessionFile, updatedAt: new Date(0).toISOString() }
        : null
    },
    upsert() {},
    delete(id: string) {
      assert.equal(id, sessionId)
      deleted = true
    }
  }

  await agent.deleteSession({ sessionId } as any)
  assert.equal(deleted, true)
  assert.equal(statSync(unrelated.sessionFile).isFile(), true)
  await agent.dispose()
})

test('PiAcpAgent: delete admission latch blocks a concurrent recovery until exact close and unlink complete', async () => {
  const sessionId = 'delete-latch-session'
  const stored = makeDurableSession(sessionId)
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  let deleted = false
  ;(agent as any).store = {
    get(id: string) {
      return id === sessionId && !deleted ? { sessionId, ...stored, updatedAt: new Date(0).toISOString() } : null
    },
    upsert() {},
    delete() {
      deleted = true
    }
  }
  let releaseStop!: () => void
  const stopGate = new Promise<void>(resolve => {
    releaseStop = resolve
  })
  let markStopStarted!: () => void
  const stopStarted = new Promise<void>(resolve => {
    markStopStarted = resolve
  })
  registerDeadSession(agent, conn, sessionId, stored.cwd, proc => {
    proc.stop = async () => {
      proc.stopCount += 1
      markStopStarted()
      await stopGate
      proc.terminate()
    }
  })
  let spawnCount = 0
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    spawnCount += 1
    throw new Error('must not spawn during delete')
  }

  try {
    const deleting = agent.deleteSession({ sessionId } as any)
    await stopStarted
    const promptError = await agent
      .prompt({ sessionId, prompt: [{ type: 'text', text: 'concurrent prompt' }] } as any)
      .then(
        () => null,
        error => error
      )
    assert.equal(promptError?.data?.code, RECOVERY_CODE)
    assert.equal(spawnCount, 0)
    releaseStop()
    await deleting
    assert.equal(deleted, true)
    assert.equal((agent as any).sessions.currentGeneration(sessionId), 0)
  } finally {
    PiRpcProcess.spawn = originalSpawn
    await agent.dispose()
  }
})

test('PiAcpAgent: load teardown failure is stable and a later load retries proof before replacement', async () => {
  const sessionId = 'load-close-retry-session'
  const stored = makeDurableSession(sessionId)
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  installStore(agent, sessionId, stored)
  let stopAttempts = 0
  registerDeadSession(agent, conn, sessionId, stored.cwd, proc => {
    proc.stop = async () => {
      proc.stopCount += 1
      stopAttempts += 1
      if (stopAttempts === 1) throw new Error('load close unconfirmed')
      proc.terminate()
    }
  })
  const candidate = new FakePiRpcProcess()
  configureCandidate(candidate, sessionId, stored.sessionFile)
  let spawnCount = 0
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    spawnCount += 1
    return candidate as any
  }

  try {
    const firstError = await agent.loadSession({ sessionId, cwd: stored.cwd, mcpServers: [] } as any).then(
      () => null,
      error => error
    )
    assert.equal(firstError?.data?.code, RECOVERY_CODE)
    assert.equal(spawnCount, 0)

    const loaded = await agent.loadSession({ sessionId, cwd: stored.cwd, mcpServers: [] } as any)
    assert.ok(Array.isArray(loaded.configOptions))
    assert.equal(stopAttempts, 2)
    assert.equal(spawnCount, 1)
    assert.equal((agent as any).sessions.maybeGet(sessionId).proc, candidate)
  } finally {
    PiRpcProcess.spawn = originalSpawn
    await agent.dispose()
  }
})
