import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  constructor(private readonly session: any) {}
  async create(_params: any) {
    return this.session
  }
}

test('PiAcpAgent: returns startup info in session/new metadata without emitting a message', async () => {
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR

  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-startupinfo-'))
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-project-'))
  const contextPath = join(cwd, 'AGENTS.md')

  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ test: 'configured' }), 'utf-8')
  writeFileSync(contextPath, '# Project Context\n', 'utf-8')
  process.env.PI_CODING_AGENT_DIR = dir

  const realSetTimeout = globalThis.setTimeout
  const timeouts: Array<unknown> = []
  ;(globalThis as any).setTimeout = (fn: unknown, _ms?: number) => {
    timeouts.push(fn)
    return 0 as any
  }

  try {
    const conn = new FakeAgentSideConnection()
    const session = {
      sessionId: 's1',
      cwd,
      proc: {
        async getAvailableModels() {
          return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
        },
        async getState() {
          return {
            thinkingLevel: 'medium',
            model: { provider: 'test', id: 'model' }
          }
        }
      }
    }

    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new FakeSessions(session) as any

    const res = await agent.newSession({ cwd, mcpServers: [] } as any)
    const startupInfo = res?._meta?.piAcp?.startupInfo ?? null

    assert.ok(typeof startupInfo === 'string')
    assert.match(startupInfo, /## Context/)
    assert.match(startupInfo, new RegExp(contextPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.equal(conn.updates.length, 0)
    assert.equal(timeouts.length, 1)
  } finally {
    ;(globalThis as any).setTimeout = realSetTimeout
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir
  }
})

test('PiAcpAgent: quietStartup=true suppresses full startup info in session/new metadata', async () => {
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR

  // Force quietStartup in pi settings by pointing PI_CODING_AGENT_DIR at a temp dir.
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-quietstartup-'))
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ quietStartup: true }, null, 2), 'utf-8')
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ test: 'configured' }), 'utf-8')
  process.env.PI_CODING_AGENT_DIR = dir

  // Spy on setTimeout calls (agent schedules available commands).
  const realSetTimeout = globalThis.setTimeout
  const timeouts: Array<unknown> = []
  ;(globalThis as any).setTimeout = (fn: unknown, _ms?: number) => {
    timeouts.push(fn)
    return 0 as any
  }

  try {
    const conn = new FakeAgentSideConnection()

    const session = {
      sessionId: 's1',
      cwd: process.cwd(),
      proc: {
        async getAvailableModels() {
          return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
        },
        async getState() {
          return {
            thinkingLevel: 'medium',
            model: { provider: 'test', id: 'model' }
          }
        }
      }
    }

    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new FakeSessions(session) as any

    const res = await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)

    const startupInfo = res?._meta?.piAcp?.startupInfo ?? null

    // When quietStartup=true the full prelude is suppressed. However, an update notice
    // (if one exists) is still surfaced because it's high-signal and actionable.
    // The test must tolerate both cases since the live npm check may or may not find an update.
    if (startupInfo) {
      assert.match(startupInfo, /New version available/)
    }

    assert.equal(timeouts.length, 1)
  } finally {
    ;(globalThis as any).setTimeout = realSetTimeout
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir
  }
})
