import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent, PROJECT_TRUST_WARNING } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { PiRpcProcess, PiRpcSpawnError } from '../../src/pi-rpc/process.js'

class FakeStore {
  constructor(private readonly sessionFile: string) {}

  get(_sessionId: string) {
    return { sessionId: 's1', cwd: '/tmp/project', sessionFile: this.sessionFile, updatedAt: new Date().toISOString() }
  }
  upsert() {
    // noop
  }
}

test('PiAcpAgent: loadSession emits the mandatory trust disclosure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-startup-load-'))
  const sessionFile = join(root, 's1.jsonl')
  writeFileSync(
    sessionFile,
    `${JSON.stringify({ type: 'session', version: 3, id: 's1', cwd: '/tmp/project' })}\n`,
    'utf8'
  )
  // spy on timers (commands update is scheduled)
  const realSetTimeout = globalThis.setTimeout
  const timeouts: Array<unknown> = []
  ;(globalThis as any).setTimeout = (fn: unknown, ms?: number) => {
    if (ms === 0) timeouts.push(fn)
    return 0 as any
  }

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    const state = { sessionId: 's1', sessionFile, thinkingLevel: 'medium' }
    return {
      onEvent: () => () => {},
      isAlive: () => true,
      stop: async () => {},
      getMessages: async () => ({ messages: [] }),
      getAvailableModels: async () => ({ models: [] }),
      getStartupHandshakeState: () => state,
      getState: async () => state
    } as any
  }

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))

    // Inject store so loadSession resolves without depending on actual filesystem.
    ;(agent as any).store = new FakeStore(sessionFile)

    const res = await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)

    assert.equal((res as any)?._meta?.piAcp?.startupInfo, `${PROJECT_TRUST_WARNING}\n`)

    // Trust disclosure and available_commands_update are both scheduled after the response.
    assert.equal(timeouts.length, 2)
  } finally {
    ;(globalThis as any).setTimeout = realSetTimeout
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: loadSession preserves safe structured Pi startup diagnostics', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-startup-load-error-'))
  const sessionFile = join(root, 's1.jsonl')
  writeFileSync(
    sessionFile,
    `${JSON.stringify({ type: 'session', version: 3, id: 's1', cwd: '/tmp/project' })}\n`,
    'utf8'
  )
  const originalSpawn = PiRpcProcess.spawn
  const diagnostic = {
    schemaVersion: 1 as const,
    code: 'PI_EXTENSION_LOAD_FAILED' as const,
    phase: 'startup' as const,
    source: 'global:extensions/pi-acp-failing-load/index.ts',
    summary: 'Extension load failed (global:extensions/pi-acp-failing-load/index.ts): C1.1_SAFE_LOAD_REASON',
    truncated: true,
    redacted: true,
    stderrLimitBytes: 16_384 as const,
    summaryLimitBytes: 4_096 as const
  }
  ;(PiRpcProcess as any).spawn = async () => {
    throw new PiRpcSpawnError(diagnostic.summary, {
      code: diagnostic.code,
      diagnostic
    })
  }

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore(sessionFile)

    await assert.rejects(
      () => agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any),
      (error: any) => {
        assert.equal(error?.code, -32603)
        assert.match(String(error?.message), /global:extensions\/pi-acp-failing-load\/index\.ts/u)
        assert.match(String(error?.message), /C1\.1_SAFE_LOAD_REASON/u)
        assert.deepEqual(error?.data?.piAcp?.diagnostic, diagnostic)
        return true
      }
    )
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})
