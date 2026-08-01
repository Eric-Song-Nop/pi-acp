import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

test('PiAcpAgent: failed new-session cleanup retains mapping and file when child stop is unconfirmed', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-new-session-cleanup-'))
  const sessionId = 'unconfirmed-new-session'
  const sessionFile = join(cwd, `${sessionId}.jsonl`)
  writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', id: sessionId, cwd })}\n`, 'utf8')

  const session = {
    sessionId,
    cwd,
    proc: {
      async getState() {
        return { sessionId, sessionFile, thinkingLevel: 'medium', model: null }
      },
      async getAvailableModels() {
        return { models: [] }
      }
    }
  }
  let closeCalls = 0
  const sessions = {
    async create() {
      return session
    },
    async close(id: string) {
      assert.equal(id, sessionId)
      closeCalls += 1
      throw new Error('child cleanup unconfirmed')
    }
  }
  let deleteCalls = 0
  const stored = { sessionId, cwd, sessionFile, updatedAt: new Date(0).toISOString() }
  const store = {
    get(id: string) {
      return id === sessionId ? stored : null
    },
    upsert() {},
    delete(id: string) {
      assert.equal(id, sessionId)
      deleteCalls += 1
    }
  }

  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()), {} as any)
  ;(agent as any).sessions = sessions
  ;(agent as any).store = store

  const error = await agent.newSession({ cwd, mcpServers: [] } as any).then(
    () => null,
    failure => failure
  )

  assert.equal(error?.code, -32000)
  assert.equal(closeCalls, 1)
  assert.equal(deleteCalls, 0)
  assert.equal(existsSync(sessionFile), true)
  assert.equal(store.get(sessionId)?.sessionFile, sessionFile)
})

test('PiAcpAgent: exact failed-new cleanup never closes or deletes a replacement winner', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-new-session-winner-'))
  const sessionId = 'replacement-winner-session'
  const sharedFile = join(cwd, `${sessionId}.jsonl`)
  writeFileSync(sharedFile, `${JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd })}\n`, 'utf8')
  const original = {
    sessionId,
    sessionFile: sharedFile,
    cwd,
    proc: { isAlive: () => false }
  }
  const winner = {
    sessionId,
    sessionFile: sharedFile,
    cwd,
    proc: { isAlive: () => true }
  }
  let deleteCalls = 0
  let forgetCalls = 0
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()), {} as any)
  ;(agent as any).sessions = {
    async close(id: string, expected: unknown) {
      assert.equal(id, sessionId)
      assert.equal(expected, original)
      return false
    },
    maybeGet() {
      return winner
    },
    forget() {
      forgetCalls += 1
    }
  }
  ;(agent as any).store = {
    get() {
      return { sessionId, cwd, sessionFile: sharedFile, updatedAt: new Date(0).toISOString() }
    },
    delete() {
      deleteCalls += 1
    }
  }

  const cleaned = await (agent as any).cleanupFailedNewSession(original)
  assert.equal(cleaned, 'superseded')
  assert.equal(existsSync(sharedFile), true)
  assert.equal(deleteCalls, 0)
  assert.equal(forgetCalls, 0)
})

test('PiAcpAgent: failed-new cleanup retains wrong-header evidence and its tombstone', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-new-session-wrong-header-'))
  const sessionId = 'wrong-header-cleanup-session'
  const sessionFile = join(cwd, `${sessionId}.jsonl`)
  writeFileSync(
    sessionFile,
    `${JSON.stringify({ type: 'session', version: 3, id: 'different-session', cwd })}\n`,
    'utf8'
  )
  const session = { sessionId, sessionFile, cwd, proc: { isAlive: () => false } }
  let deleteCalls = 0
  let forgetCalls = 0
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()), {} as any)
  ;(agent as any).sessions = {
    async close() {
      return true
    },
    forget() {
      forgetCalls += 1
    }
  }
  ;(agent as any).store = {
    get() {
      return { sessionId, cwd, sessionFile, updatedAt: new Date(0).toISOString() }
    },
    delete() {
      deleteCalls += 1
    }
  }

  const cleaned = await (agent as any).cleanupFailedNewSession(session)
  assert.equal(cleaned, 'artifact_quarantined')
  assert.equal(existsSync(sessionFile), true)
  assert.equal(deleteCalls, 0)
  assert.equal(forgetCalls, 0)
})

test('PiAcpAgent: store-delete failure retains the failed-new tombstone for retry', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-new-session-store-delete-'))
  const sessionId = 'store-delete-cleanup-session'
  const sessionFile = join(cwd, `${sessionId}.jsonl`)
  writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', version: 3, id: sessionId, cwd })}\n`, 'utf8')
  const session = { sessionId, sessionFile, cwd, proc: { isAlive: () => false } }
  let forgetCalls = 0
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()), {} as any)
  ;(agent as any).sessions = {
    async close() {
      return true
    },
    forget() {
      forgetCalls += 1
    }
  }
  ;(agent as any).store = {
    get() {
      return { sessionId, cwd, sessionFile, updatedAt: new Date(0).toISOString() }
    },
    delete() {
      throw new Error('store delete failed')
    }
  }

  const cleaned = await (agent as any).cleanupFailedNewSession(session)
  assert.equal(cleaned, 'artifact_quarantined')
  assert.equal(existsSync(sessionFile), false)
  assert.equal(forgetCalls, 0)
})

test('PiAcpAgent: unrelated failed-new process proof does not block an already healthy session', async () => {
  const healthy = {
    sessionId: 'healthy-session',
    cwd: process.cwd(),
    proc: { isAlive: () => true },
    isAlive: () => true
  }
  const failed = {
    sessionId: 'failed-unrelated-session',
    sessionFile: null,
    cwd: process.cwd(),
    proc: { isAlive: () => true },
    isAlive: () => true
  }
  let cleanupCloseCalls = 0
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()), {} as any)
  ;(agent as any).sessions = {
    maybeGet(id: string) {
      return id === healthy.sessionId ? healthy : undefined
    },
    snapshot(id: string) {
      return id === healthy.sessionId ? { generation: 1, session: healthy } : undefined
    },
    async close() {
      cleanupCloseCalls += 1
      throw new Error('must not touch unrelated failed session')
    }
  }
  ;(agent as any).pendingFailedNewSessionCleanups.add(failed)

  const restored = await (agent as any).restoreSession(healthy.sessionId)
  assert.equal(restored, healthy)
  assert.equal(cleanupCloseCalls, 0)
})
