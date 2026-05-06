import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  constructor(private readonly session: any) {}

  async create(_params: any) {
    return this.session
  }

  get(sessionId: string) {
    if (sessionId !== this.session.sessionId) throw new Error(`Unknown sessionId: ${sessionId}`)
    return this.session
  }

  closeAllExcept(_sessionId: string) {
    // noop
  }
}

function createThinkingProc(initial = 'medium') {
  let thinkingLevel = initial
  let model = { provider: 'test', id: 'model' }

  return {
    setThinkingCalls: [] as string[],
    setModelCalls: [] as Array<{ provider: string; modelId: string }>,

    async getAvailableModels() {
      return {
        models: [
          {
            provider: 'test',
            id: 'model',
            name: 'Reasoning Model',
            reasoning: true
          },
          {
            provider: 'test',
            id: 'other-model',
            name: 'Other Model',
            reasoning: true
          }
        ]
      }
    },

    async getState() {
      return {
        thinkingLevel,
        model
      }
    },

    async setModel(provider: string, modelId: string) {
      this.setModelCalls.push({ provider, modelId })
      model = { provider, id: modelId }
    },

    async setThinkingLevel(level: string) {
      this.setThinkingCalls.push(level)
      thinkingLevel = level
    }
  }
}

test('PiAcpAgent: newSession exposes thinking as thought_level config option, not mode', async () => {
  const realSetTimeout = globalThis.setTimeout
  const prevOpenAiKey = process.env.OPENAI_API_KEY
  ;(globalThis as any).setTimeout = () => 0 as any
  process.env.OPENAI_API_KEY = 'test-key'

  try {
    const conn = new FakeAgentSideConnection()
    const proc = createThinkingProc('high')
    const session = {
      sessionId: 's1',
      cwd: process.cwd(),
      proc
    }

    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).sessions = new FakeSessions(session) as any

    const res = await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)
    const modelOption = res.configOptions?.find(o => o.id === 'model')
    const option = res.configOptions?.find(o => o.id === 'reasoning_effort')

    assert.equal((res as any).modes, undefined)
    assert.ok(modelOption)
    assert.equal(modelOption.category, 'model')
    assert.equal(modelOption.currentValue, 'test/model')
    assert.deepEqual(
      (modelOption.options as Array<{ value: string }>).map(o => o.value),
      ['test/model', 'test/other-model']
    )
    assert.ok(option)
    assert.equal(option.category, 'thought_level')
    assert.equal(option.name, 'Reasoning Effort')
    assert.equal(option.currentValue, 'high')
    assert.deepEqual(
      (option.options as Array<{ value: string }>).map(o => o.value),
      ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']
    )
  } finally {
    ;(globalThis as any).setTimeout = realSetTimeout
    if (prevOpenAiKey == null) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevOpenAiKey
  }
})

test('PiAcpAgent: setSessionConfigOption maps reasoning_effort to pi setThinkingLevel', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = createThinkingProc('medium')
  const session = { sessionId: 's1', proc }
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions(session) as any

  const res = await agent.setSessionConfigOption({
    sessionId: 's1',
    configId: 'reasoning_effort',
    value: 'high'
  } as any)

  assert.deepEqual(proc.setThinkingCalls, ['high'])
  const option = res.configOptions.find(o => o.id === 'reasoning_effort')
  assert.ok(option)
  assert.equal(option.category, 'thought_level')
  assert.equal(option.currentValue, 'high')
})

test('PiAcpAgent: setSessionConfigOption maps model to pi setModel', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = createThinkingProc('medium')
  const session = { sessionId: 's1', proc }
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions(session) as any

  const res = await agent.setSessionConfigOption({
    sessionId: 's1',
    configId: 'model',
    value: 'test/other-model'
  } as any)

  assert.deepEqual(proc.setModelCalls, [{ provider: 'test', modelId: 'other-model' }])
  const option = res.configOptions.find(o => o.id === 'model')
  assert.ok(option)
  assert.equal(option.category, 'model')
  assert.equal(option.currentValue, 'test/other-model')
})

test('PiAcpAgent: rejects unsupported thinking config values', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = createThinkingProc('medium')
  const session = { sessionId: 's1', proc }
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions(session) as any

  await assert.rejects(
    () =>
      agent.setSessionConfigOption({
        sessionId: 's1',
        configId: 'reasoning_effort',
        value: 'invalid'
      } as any),
    /invalid params/i
  )
})
