import test from 'node:test'
import assert from 'node:assert/strict'
import { RequestError } from '@agentclientprotocol/sdk'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiRpcProcessTerminatedError } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function terminalError(exitCode: number): PiRpcProcessTerminatedError {
  return new PiRpcProcessTerminatedError(
    `Pi RPC process exited before completing the request (code=${exitCode}).`,
    undefined,
    { kind: 'exit', code: exitCode }
  )
}

async function exerciseTerminalMapping(
  exitCode: number,
  configure: (proc: FakePiRpcProcess, causal: PiRpcProcessTerminatedError) => void,
  invoke: (agent: PiAcpAgent, sessionId: string) => Promise<unknown>
): Promise<void> {
  const timeline: string[] = []
  class TimelineConnection extends FakeAgentSideConnection {
    override async sessionUpdate(msg: Parameters<FakeAgentSideConnection['sessionUpdate']>[0]): Promise<void> {
      this.updates.push(msg)
      const update = msg.update as any
      if (update.sessionUpdate === 'session_info_update' && update._meta?.piAcp?.running === false) {
        timeline.push('terminal-idle')
      }
    }
  }

  const sessionId = `terminal-mapping-${exitCode}`
  const conn = new TimelineConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  const proc = new FakePiRpcProcess()
  const causal = terminalError(exitCode)
  configure(proc, causal)
  ;(agent as any).sessions.getOrCreate(sessionId, {
    cwd: process.cwd(),
    mcpServers: [],
    conn: asAgentConn(conn),
    proc,
    fileCommands: []
  })

  try {
    const result = await invoke(agent, sessionId).then(
      value => value,
      error => {
        timeline.push('request-rejected')
        return error
      }
    )

    assert.ok(result instanceof RequestError)
    assert.equal(result.code, -32603)
    assert.equal(result.data, causal.data)
    assert.equal((result.data as any).piAcp.recovery.automaticReplay, false)
    assert.deepEqual(timeline, ['terminal-idle', 'request-rejected'])
    assert.equal(proc.prompts.length, 0)
  } finally {
    await agent.dispose()
  }
}

test('PiAcpAgent: native slash RPC failures preserve terminal data and cannot fall through to end_turn', async t => {
  await t.test('/name catch-to-success guard', async () => {
    await exerciseTerminalMapping(
      31,
      (proc, causal) => {
        ;(proc as any).setSessionName = async () => {
          proc.terminate(causal)
          throw causal
        }
      },
      (agent, sessionId) => agent.prompt({ sessionId, prompt: [{ type: 'text', text: '/name replacement' }] } as any)
    )
  })

  await t.test('/session query', async () => {
    await exerciseTerminalMapping(
      32,
      (proc, causal) => {
        ;(proc as any).getSessionStats = async () => {
          proc.terminate(causal)
          throw causal
        }
      },
      (agent, sessionId) => agent.prompt({ sessionId, prompt: [{ type: 'text', text: '/session' }] } as any)
    )
  })
})

test('PiAcpAgent: native mode/config RPC failures await the same terminal idle barrier', async t => {
  await t.test('setSessionMode mutation', async () => {
    await exerciseTerminalMapping(
      33,
      (proc, causal) => {
        ;(proc as any).setThinkingLevel = async () => {
          proc.terminate(causal)
          throw causal
        }
      },
      (agent, sessionId) => agent.setSessionMode({ sessionId, modeId: 'high' } as any)
    )
  })

  await t.test('setSessionConfigOption post-set refresh', async () => {
    await exerciseTerminalMapping(
      34,
      (proc, causal) => {
        ;(proc as any).setThinkingLevel = async () => undefined
        proc.getAvailableModels = async () => {
          proc.terminate(causal)
          throw causal
        }
      },
      (agent, sessionId) => agent.setSessionConfigOption({ sessionId, configId: 'thought_level', value: 'high' } as any)
    )
  })
})
