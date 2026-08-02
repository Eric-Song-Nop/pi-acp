import test from 'node:test'
import assert from 'node:assert/strict'
import { RequestError } from '@agentclientprotocol/sdk'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const UNSUPPORTED_PI_BUILTINS = [
  'settings',
  'model',
  'scoped-models',
  'import',
  'share',
  'copy',
  'hotkeys',
  'fork',
  'clone',
  'tree',
  'trust',
  'login',
  'logout',
  'new',
  'resume',
  'reload',
  'quit'
] as const

const ECMASCRIPT_WHITESPACE_AND_LINE_TERMINATOR_CODE_POINTS = [
  0x0009, 0x000b, 0x000c, 0x0020, 0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff, 0x000a, 0x000d
] as const

type Dispatch = {
  message: string
  images: unknown[]
}

class FakeSessions {
  constructor(private readonly session: any) {}
  maybeGet(_id: string) {
    return this.session
  }
  get(_id: string) {
    return this.session
  }
}

function refusalResponse(command: (typeof UNSUPPORTED_PI_BUILTINS)[number]) {
  const summary = `Pi built-in /${command} is not supported over ACP; it was not sent to Pi or the model.`
  return {
    stopReason: 'refusal',
    _meta: {
      piAcp: {
        diagnostic: {
          schemaVersion: 1,
          code: 'PI_ACP_UNSUPPORTED_PI_BUILTIN',
          phase: 'routing',
          source: 'pi-builtin',
          command,
          summary,
          summaryLimitBytes: 256,
          truncated: false,
          redacted: false
        },
        routing: {
          promptForwardedToPi: false,
          sentToModel: false
        }
      }
    }
  }
}

function createPromptHarness() {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const dispatches: Dispatch[] = []
  const session = {
    sessionId: 's1',
    proc,
    fileCommands: [],
    async prompt(message: string, images: unknown[] = []) {
      dispatches.push({ message, images })
      return 'end_turn' as const
    }
  }
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions(session) as any
  return { agent, conn, proc, dispatches }
}

function withImmediateDeadline<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const immediate = setImmediate(() => reject(new Error(message)))
    void promise.then(
      result => {
        clearImmediate(immediate)
        resolve(result)
      },
      error => {
        clearImmediate(immediate)
        reject(error)
      }
    )
  })
}

test('PiAcpAgent: /steering is handled adapter-side', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  proc.getState = async () => ({ steeringMode: 'one-at-a-time' })

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc, fileCommands: [] }) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/steering' }]
  } as any)

  assert.equal(res.stopReason, 'end_turn')
  assert.equal(proc.prompts.length, 0)
  const last = conn.updates.at(-1)
  assert.match((last as any).update.content.text, /Steering mode: one-at-a-time/)
})

test('PiAcpAgent: /name sets session display name adapter-side', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any

  let setTo: string | null = null
  proc.setSessionName = async (name: string) => {
    setTo = name
  }

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc, fileCommands: [] }) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/name My Session' }]
  } as any)

  assert.equal(res.stopReason, 'end_turn')
  assert.equal(proc.prompts.length, 0)
  assert.equal(setTo, 'My Session')
  const info = conn.updates.find(u => (u as any).update?.sessionUpdate === 'session_info_update')
  assert.equal((info as any)?.update?.title, 'My Session')

  const last = conn.updates.at(-1)
  assert.match((last as any).update.content.text, /Session name set: My Session/)
})

test('PiAcpAgent: every known unsupported Pi built-in returns one refusal without dispatch or updates', async () => {
  assert.equal(new Set(UNSUPPORTED_PI_BUILTINS).size, 17)
  const { agent, conn, proc, dispatches } = createPromptHarness()

  for (const command of UNSUPPORTED_PI_BUILTINS) {
    const updatesBefore = conn.updates.length
    const dispatchesBefore = dispatches.length
    const result = await agent.prompt({
      sessionId: 's1',
      prompt: [{ type: 'text', text: `/${command} c1.5-argument` }]
    } as any)

    assert.deepEqual(result, refusalResponse(command))
    assert.equal(JSON.stringify(result).includes('c1.5-argument'), false)
    assert.equal(conn.updates.length, updatesBefore, `/${command} must not emit a rejection session/update`)
    assert.equal(dispatches.length, dispatchesBefore, `/${command} must not reach PiAcpSession.prompt`)
    assert.equal(proc.prompts.length, 0, `/${command} must not reach the nested Pi process`)
  }

  assert.equal(dispatches.length, 0)
  assert.equal(conn.updates.length, 0)
})

test('PiAcpAgent: unsupported built-in routing handles whitespace, split blocks, resources, and images', async () => {
  const { agent, conn, proc, dispatches } = createPromptHarness()
  const imageData = Buffer.from('c1.5-image', 'utf8').toString('base64')
  const cases = [
    {
      label: 'tab argument and Unicode leading whitespace',
      prompt: [{ type: 'text', text: '\u2003/trust\targument' }]
    },
    {
      label: 'newline argument and leading newline',
      prompt: [{ type: 'text', text: '\n/trust\nargument' }]
    },
    {
      label: 'command split across text blocks',
      prompt: [
        { type: 'text', text: '/tr' },
        { type: 'text', text: 'ust' },
        { type: 'text', text: '\targument' }
      ]
    },
    {
      label: 'resource link after the command',
      prompt: [
        { type: 'text', text: '/trust' },
        { type: 'resource_link', uri: 'file:///c1.5/context.txt', name: 'context' }
      ]
    },
    {
      label: 'embedded resource after the command',
      prompt: [
        { type: 'text', text: '/trust' },
        {
          type: 'resource',
          resource: { uri: 'file:///c1.5/context.txt', mimeType: 'text/plain', text: 'context' }
        }
      ]
    },
    {
      label: 'image attached to the command',
      prompt: [
        { type: 'text', text: '/trust' },
        { type: 'image', mimeType: 'image/png', data: imageData }
      ]
    }
  ]

  for (const item of cases) {
    const updatesBefore = conn.updates.length
    const result = await agent.prompt({ sessionId: 's1', prompt: item.prompt } as any)
    assert.deepEqual(result, refusalResponse('trust'), item.label)
    assert.equal(JSON.stringify(result).includes('argument'), false, item.label)
    assert.equal(JSON.stringify(result).includes(imageData), false, item.label)
    assert.equal(JSON.stringify(result).includes('file:///c1.5/context.txt'), false, item.label)
    assert.equal(conn.updates.length, updatesBefore, item.label)
    assert.equal(dispatches.length, 0, item.label)
    assert.equal(proc.prompts.length, 0, item.label)
  }
})

test('PiAcpAgent: unsupported built-in grammar uses exact ECMAScript whitespace boundaries', async () => {
  const { agent, conn, proc, dispatches } = createPromptHarness()

  for (const codePoint of ECMASCRIPT_WHITESPACE_AND_LINE_TERMINATOR_CODE_POINTS) {
    const whitespace = String.fromCodePoint(codePoint)
    const label = `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`
    for (const message of [`${whitespace}/trust`, `/trust${whitespace}ARGUMENT`]) {
      const updatesBefore = conn.updates.length
      const dispatchesBefore = dispatches.length
      const result = await agent.prompt({
        sessionId: 's1',
        prompt: [{ type: 'text', text: message }]
      } as any)

      assert.deepEqual(result, refusalResponse('trust'), label)
      assert.equal(conn.updates.length, updatesBefore, label)
      assert.equal(dispatches.length, dispatchesBefore, label)
      assert.equal(proc.prompts.length, 0, label)
    }
  }

  for (const codePoint of [0x0085, 0x200b, 0x2060] as const) {
    const separator = String.fromCodePoint(codePoint)
    const message = `/trust${separator}ARGUMENT`
    const result = await agent.prompt({
      sessionId: 's1',
      prompt: [{ type: 'text', text: message }]
    } as any)

    assert.deepEqual(result, { stopReason: 'end_turn' })
    assert.deepEqual(dispatches.at(-1), { message, images: [] })
  }

  assert.equal(dispatches.length, 3)
  assert.equal(conn.updates.length, 0)
  assert.equal(proc.prompts.length, 0)
})

test('PiAcpAgent: non-colliding extension, prompt, skill, and unknown text preserve ordinary routing', async () => {
  const { agent, conn, proc, dispatches } = createPromptHarness()
  const imageData = Buffer.from('ordinary-image', 'utf8').toString('base64')
  const cases = [
    {
      label: 'non-colliding extension command',
      prompt: [{ type: 'text', text: '/fixture-state' }],
      expected: { message: '/fixture-state', images: [] }
    },
    {
      label: 'non-colliding prompt command',
      prompt: [{ type: 'text', text: '/project-prompt argument' }],
      expected: { message: '/project-prompt argument', images: [] }
    },
    {
      label: 'multi-block resource and image slash command',
      prompt: [
        { type: 'text', text: '/project-' },
        { type: 'text', text: 'prompt argument' },
        { type: 'resource_link', uri: 'file:///c2.2/context.txt', name: 'context' },
        { type: 'image', mimeType: 'image/png', data: imageData }
      ],
      expected: {
        message: '/project-prompt argument\n[Context] file:///c2.2/context.txt',
        images: [{ type: 'image', mimeType: 'image/png', data: imageData }]
      }
    },
    {
      label: 'non-colliding skill command',
      prompt: [{ type: 'text', text: '/skill:fixture argument' }],
      expected: { message: '/skill:fixture argument', images: [] }
    },
    {
      label: 'unknown slash command',
      prompt: [{ type: 'text', text: '/unknown argument' }],
      expected: { message: '/unknown argument', images: [] }
    },
    {
      label: 'ordinary text',
      prompt: [{ type: 'text', text: 'explain /trust without invoking it' }],
      expected: { message: 'explain /trust without invoking it', images: [] }
    },
    {
      label: 'case-sensitive name',
      prompt: [{ type: 'text', text: '/Trust' }],
      expected: { message: '/Trust', images: [] }
    },
    {
      label: 'built-in prefix only',
      prompt: [{ type: 'text', text: '/trustworthy' }],
      expected: { message: '/trustworthy', images: [] }
    },
    {
      label: 'built-in path suffix',
      prompt: [{ type: 'text', text: '/trust/foo' }],
      expected: { message: '/trust/foo', images: [] }
    },
    {
      label: 'double slash prefix',
      prompt: [{ type: 'text', text: '//trust' }],
      expected: { message: '//trust', images: [] }
    },
    {
      label: 'stale clear name',
      prompt: [{ type: 'text', text: '/clear' }],
      expected: { message: '/clear', images: [] }
    },
    {
      label: 'stale thinking name',
      prompt: [{ type: 'text', text: '/thinking' }],
      expected: { message: '/thinking', images: [] }
    },
    {
      label: 'stale queue name',
      prompt: [{ type: 'text', text: '/queue all' }],
      expected: { message: '/queue all', images: [] }
    },
    {
      label: 'command text after a resource link',
      prompt: [
        { type: 'resource_link', uri: 'file:///c1.5/context.txt', name: 'context' },
        { type: 'text', text: '/trust' }
      ],
      expected: { message: '\n[Context] file:///c1.5/context.txt/trust', images: [] }
    },
    {
      label: 'ordinary image prompt',
      prompt: [
        { type: 'text', text: 'describe this image' },
        { type: 'image', mimeType: 'image/png', data: imageData }
      ],
      expected: {
        message: 'describe this image',
        images: [{ type: 'image', mimeType: 'image/png', data: imageData }]
      }
    }
  ]

  for (const item of cases) {
    const updatesBefore = conn.updates.length
    const dispatchesBefore = dispatches.length
    const result = await agent.prompt({ sessionId: 's1', prompt: item.prompt } as any)
    assert.deepEqual(result, { stopReason: 'end_turn' }, item.label)
    assert.equal(conn.updates.length, updatesBefore, item.label)
    assert.equal(dispatches.length, dispatchesBefore + 1, item.label)
    assert.deepEqual(dispatches.at(-1), item.expected, item.label)
    assert.equal(proc.prompts.length, 0, item.label)
  }

  assert.equal(dispatches.length, cases.length)
  assert.deepEqual(dispatches.at(-1)?.images, [{ type: 'image', mimeType: 'image/png', data: imageData }])
})

test('PiAcpAgent: session restoration errors take precedence over unsupported built-in refusal', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = {
    maybeGet() {
      return undefined
    },
    currentGeneration() {
      return 0
    }
  }

  await assert.rejects(
    agent.prompt({
      sessionId: 'c1.5-missing-session-for-refusal-ordering',
      prompt: [{ type: 'text', text: '/trust C1_5_PRE_RESTORE_SECRET' }]
    } as any),
    (error: unknown) => {
      assert.ok(error instanceof RequestError)
      assert.equal(error.code, -32602)
      assert.equal(error.message, 'Invalid params')
      return true
    }
  )
})

test('PiAcpAgent: unsupported built-in refusal is isolated from an active ordinary turn', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const dispatches: Dispatch[] = []
  let releaseActiveTurn!: () => void
  let markActiveTurnStarted!: () => void
  const activeTurnRelease = new Promise<void>(resolve => {
    releaseActiveTurn = resolve
  })
  const activeTurnStarted = new Promise<void>(resolve => {
    markActiveTurnStarted = resolve
  })
  const session = {
    sessionId: 's1',
    proc,
    fileCommands: [],
    async prompt(message: string, images: unknown[] = []) {
      dispatches.push({ message, images })
      markActiveTurnStarted()
      await activeTurnRelease
      return 'end_turn' as const
    }
  }
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions(session) as any

  let activeTurnSettled = false
  const activeTurn = agent
    .prompt({
      sessionId: 's1',
      prompt: [{ type: 'text', text: 'ordinary active turn' }]
    } as any)
    .then(result => {
      activeTurnSettled = true
      return result
    })
  await activeTurnStarted
  assert.equal(activeTurnSettled, false)
  assert.deepEqual(dispatches, [{ message: 'ordinary active turn', images: [] }])

  const updatesBeforeRefusal = conn.updates.length
  try {
    const refusal = await withImmediateDeadline(
      agent.prompt({
        sessionId: 's1',
        prompt: [{ type: 'text', text: '/trust secret' }]
      } as any),
      'unsupported built-in refusal waited behind the active turn'
    )

    assert.deepEqual(refusal, refusalResponse('trust'))
    assert.equal(activeTurnSettled, false)
    assert.deepEqual(dispatches, [{ message: 'ordinary active turn', images: [] }])
    assert.equal(conn.updates.length, updatesBeforeRefusal)
    assert.equal(proc.abortCount, 0)
    assert.equal(proc.prompts.length, 0)
  } finally {
    releaseActiveTurn()
  }

  assert.deepEqual(await activeTurn, { stopReason: 'end_turn' })
  assert.equal(activeTurnSettled, true)
  assert.deepEqual(dispatches, [{ message: 'ordinary active turn', images: [] }])
  assert.equal(proc.abortCount, 0)
})

test('PiAcpAgent: unsupported refusal preserves a real active and queued PiAcpSession FIFO', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions(session) as any

  const first = agent.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: 'first ordinary turn' }] } as any)
  const second = agent.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: 'second ordinary turn' }] } as any)
  const third = agent.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: 'third ordinary turn' }] } as any)
  const ordinaryTurns = [first, second, third]

  const waitForPromptCount = async (expected: number): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (proc.prompts.length === expected) return
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    assert.fail(`expected ${String(expected)} Pi prompt dispatches, received ${String(proc.prompts.length)}`)
  }

  try {
    await waitForPromptCount(1)
    await new Promise(resolve => setImmediate(resolve))
    const updatesBeforeRefusal = conn.updates.length

    const refusal = await withImmediateDeadline(
      agent.prompt({
        sessionId: 's1',
        prompt: [{ type: 'text', text: '/trust C1_5_QUEUED_REFUSAL_SECRET' }]
      } as any),
      'unsupported built-in refusal joined the real PiAcpSession queue'
    )
    await new Promise(resolve => setImmediate(resolve))

    assert.deepEqual(refusal, refusalResponse('trust'))
    assert.equal(proc.prompts.length, 1)
    assert.equal(conn.updates.length, updatesBeforeRefusal)
    assert.equal(proc.abortCount, 0)

    proc.emit({ type: 'agent_settled' })
    assert.deepEqual(await first, { stopReason: 'end_turn' })
    await waitForPromptCount(2)
    assert.equal(proc.prompts[1]?.message, 'second ordinary turn')

    proc.emit({ type: 'agent_start' })
    proc.emit({ type: 'agent_settled' })
    assert.deepEqual(await second, { stopReason: 'end_turn' })
    await waitForPromptCount(3)
    assert.equal(proc.prompts[2]?.message, 'third ordinary turn')

    proc.emit({ type: 'agent_start' })
    proc.emit({ type: 'agent_settled' })
    assert.deepEqual(await third, { stopReason: 'end_turn' })
    assert.deepEqual(
      proc.prompts.map(prompt => prompt.message),
      ['first ordinary turn', 'second ordinary turn', 'third ordinary turn']
    )
    assert.equal(proc.abortCount, 0)
  } finally {
    await session.dispose()
    await Promise.allSettled(ordinaryTurns)
  }
})
