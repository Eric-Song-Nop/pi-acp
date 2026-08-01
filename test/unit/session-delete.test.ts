import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

test('PiAcpAgent: deleteSession removes stored session and session file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-delete-test-'))
  const sessionsDir = join(root, 'sessions', '--tmp--delete-project--')
  const sessionFile = join(sessionsDir, '0000_delete_me.jsonl')
  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(
    sessionFile,
    '{"type":"session","version":3,"id":"stored-session","timestamp":"2026-06-16T00:00:00.000Z","cwd":"/tmp/delete-project"}\n',
    'utf-8'
  )

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  const storedSessionId = 'stored-session'
  const storeDeletes: string[] = []

  // Inject a SessionStore that tracks calls.
  ;(agent as any).store = {
    get(sessionId: string) {
      if (sessionId !== storedSessionId) return null
      return { sessionId, cwd: '/tmp/delete-project', sessionFile, updatedAt: new Date().toISOString() }
    },
    delete(sessionId: string) {
      storeDeletes.push(sessionId)
    },
    upsert() {}
  }

  try {
    const response = await agent.deleteSession({ sessionId: storedSessionId } as any)
    assert.deepEqual(response, {})
    assert.deepEqual(storeDeletes, [storedSessionId])
    assert.equal(existsSync(sessionFile), false)
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

test('PiAcpAgent: deleteSession finds session via pi discovery when SessionStore misses', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-delete-discovery-'))
  const sessionsDir = join(root, 'sessions', '--tmp--delete-discovery--')
  const sessionFile = join(sessionsDir, '0000_pi_discovery.jsonl')
  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'pi-discovered-session',
      timestamp: '2026-06-16T00:00:00.000Z',
      cwd: '/tmp/delete-discovery'
    }) + '\n',
    'utf-8'
  )

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  const storeDeletes: string[] = []

  ;(agent as any).store = {
    get() {
      return null
    },
    delete(sessionId: string) {
      storeDeletes.push(sessionId)
    },
    upsert() {}
  }

  try {
    const response = await agent.deleteSession({ sessionId: 'pi-discovered-session' } as any)
    assert.deepEqual(response, {})
    assert.deepEqual(storeDeletes, ['pi-discovered-session'])
    assert.equal(existsSync(sessionFile), false)
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

test('PiAcpAgent: deleteSession succeeds idempotently for unknown sessionId', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-delete-unknown-'))
  const sessionsDir = join(root, 'sessions', '--tmp--delete-unknown--')
  mkdirSync(sessionsDir, { recursive: true })

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  // Per ACP session/delete semantics, deleting a non-existent session
  // should succeed idempotently (return {} without error).
  const storeDeletes: string[] = []
  ;(agent as any).store = {
    get() {
      return null
    },
    delete(sessionId: string) {
      storeDeletes.push(sessionId)
    },
    upsert() {}
  }

  try {
    const response = await agent.deleteSession({ sessionId: 'non-existent-session' } as any)
    assert.deepEqual(response, {})
    assert.deepEqual(storeDeletes, [])
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

test('PiAcpAgent: deleteSession survives missing session file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-delete-missingfile-'))
  const sessionsDir = join(root, 'sessions', '--tmp--delete-missingfile--')
  mkdirSync(sessionsDir, { recursive: true })
  const nonExistentFile = join(sessionsDir, '0000_non_existent.jsonl')

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))

  const storeDeletes: string[] = []

  ;(agent as any).store = {
    get(sessionId: string) {
      if (sessionId !== 'missing-file-session') return null
      return {
        sessionId,
        cwd: '/tmp/delete-missingfile',
        sessionFile: nonExistentFile,
        updatedAt: new Date().toISOString()
      }
    },
    delete(sessionId: string) {
      storeDeletes.push(sessionId)
    },
    upsert() {}
  }

  try {
    const response = await agent.deleteSession({ sessionId: 'missing-file-session' } as any)
    assert.deepEqual(response, {})
    assert.deepEqual(storeDeletes, ['missing-file-session'])
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

test('PiAcpAgent: deleteSession fails closed on duplicate discovered session IDs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-delete-duplicate-'))
  const sessionId = 'duplicate-delete-session'
  const files = [
    join(root, 'sessions', '--tmp--duplicate-a--', '0000_a.jsonl'),
    join(root, 'sessions', '--tmp--duplicate-b--', '0000_b.jsonl')
  ]
  for (const [index, sessionFile] of files.entries()) {
    mkdirSync(join(sessionFile, '..'), { recursive: true })
    writeFileSync(
      sessionFile,
      `${JSON.stringify({
        type: 'session',
        version: 3,
        id: sessionId,
        timestamp: `2026-06-16T00:00:0${String(index)}.000Z`,
        cwd: `/tmp/duplicate-${String(index)}`
      })}\n`,
      'utf8'
    )
  }
  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  let deleteCalls = 0
  ;(agent as any).store = {
    get() {
      return null
    },
    delete() {
      deleteCalls += 1
    },
    upsert() {}
  }

  try {
    const error = await agent.deleteSession({ sessionId } as any).then(
      () => null,
      failure => failure
    )
    assert.equal(error?.data?.code, 'PI_ACP_SESSION_RECOVERY_UNAVAILABLE')
    assert.equal(deleteCalls, 0)
    assert.equal(
      files.every(file => existsSync(file)),
      true
    )
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

test('PiAcpAgent: idempotent explicit delete clears a per-ID artifact quarantine', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-delete-quarantine-'))
  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root
  const sessionId = 'cleared-quarantine-session'
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  ;(agent as any).store = {
    get() {
      return null
    },
    delete() {},
    upsert() {}
  }
  ;(agent as any).quarantinedSessionIds.add(sessionId)

  try {
    assert.deepEqual(await agent.deleteSession({ sessionId } as any), {})
    assert.equal((agent as any).quarantinedSessionIds.has(sessionId), false)
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})
