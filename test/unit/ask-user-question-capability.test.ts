import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

test('PiAcpAgent: advertises AskUserQuestion extension support', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))

  const res = await agent.initialize({ protocolVersion: 1 } as any)

  assert.equal((res.agentCapabilities?._meta as any)?.claudeCode?.askUserQuestion, true)
})

test('PiAcpAgent: records AskUserQuestion client capability from initialize', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))

  await agent.initialize({
    protocolVersion: 1,
    clientCapabilities: {
      _meta: {
        claudeCode: {
          askUserQuestion: { enabled: true }
        }
      }
    }
  } as any)

  assert.equal((agent as any).clientSupportsAskUserQuestion, true)
})

test('PiAcpAgent: records boolean AskUserQuestion client capability from initialize', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))

  await agent.initialize({
    protocolVersion: 1,
    clientCapabilities: {
      _meta: {
        claudeCode: {
          askUserQuestion: true
        }
      }
    }
  } as any)

  assert.equal((agent as any).clientSupportsAskUserQuestion, true)
})

test('PiAcpAgent: keeps AskUserQuestion client capability disabled by default', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))

  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} } as any)

  assert.equal((agent as any).clientSupportsAskUserQuestion, false)
})
