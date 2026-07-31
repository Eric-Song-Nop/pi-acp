import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { PiRpcProcess, PiRpcSpawnError } from '../../src/pi-rpc/process.js'

class FakeStore {
  get(_sessionId: string) {
    return { sessionId: 's1', cwd: '/tmp/project', sessionFile: '/tmp/s.jsonl', updatedAt: new Date().toISOString() }
  }
  upsert() {
    // noop
  }
}

test('PiAcpAgent: does not emit startup info on loadSession', async () => {
  // spy on timers (commands update is scheduled)
  const realSetTimeout = globalThis.setTimeout
  const timeouts: Array<unknown> = []
  ;(globalThis as any).setTimeout = (fn: unknown, _ms?: number) => {
    timeouts.push(fn)
    return 0 as any
  }

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    return {
      onEvent: () => () => {},
      getMessages: async () => ({ messages: [] }),
      getAvailableModels: async () => ({ models: [] }),
      getState: async () => ({ thinkingLevel: 'medium' })
    } as any
  }

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))

    // Inject store so loadSession resolves without depending on actual filesystem.
    ;(agent as any).store = new FakeStore()

    const res = await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)

    assert.equal((res as any)?._meta?.piAcp?.startupInfo, null)

    // Only available_commands_update should be scheduled.
    assert.equal(timeouts.length, 1)
  } finally {
    ;(globalThis as any).setTimeout = realSetTimeout
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: loadSession preserves safe structured Pi startup diagnostics', async () => {
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
    ;(agent as any).store = new FakeStore()

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
