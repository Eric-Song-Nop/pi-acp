import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const RUNTIME_EXTENSION_EVENT = {
  type: 'extension_error',
  extensionPath: '/workspace/acme/.pi/extensions/failing.ts',
  event: 'before_agent_start',
  error: 'C1.2_SAFE_REASON'
}
const RUNTIME_EXTENSION_SUMMARY =
  'Pi extension error (source: project:.pi/extensions/failing.ts; event: before_agent_start):\nC1.2_SAFE_REASON'
const RUNTIME_EXTENSION_DIAGNOSTIC = {
  schemaVersion: 1,
  code: 'PI_EXTENSION_RUNTIME_ERROR',
  phase: 'runtime',
  source: 'project:.pi/extensions/failing.ts',
  event: 'before_agent_start',
  summary: RUNTIME_EXTENSION_SUMMARY,
  truncated: false,
  redacted: true,
  summaryLimitBytes: 4096
}

test('PiAcpSession: emits agent_message_chunk for text_delta', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'hi' }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.sessionId, 's1')
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'hi' }
  })
})

test('PiAcpSession: emits agent_thought_chunk for thinking_delta', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking...' }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.sessionId, 's1')
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'thinking...' }
  })
})

test('PiAcpSession: emits the canonical runtime extension diagnostic without an active prompt', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's-runtime',
    cwd: '/workspace/acme',
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit(RUNTIME_EXTENSION_EVENT)

  // Notifications are serialized asynchronously even when no prompt is active.
  assert.equal(conn.updates.length, 0)
  await new Promise(r => setTimeout(r, 0))

  assert.deepEqual(conn.updates, [
    {
      sessionId: 's-runtime',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: RUNTIME_EXTENSION_SUMMARY },
        _meta: {
          piAcp: {
            notify: { level: 'error' },
            diagnostic: RUNTIME_EXTENSION_DIAGNOSTIC
          }
        }
      }
    }
  ])
  assert.equal(proc.prompts.length, 0)
})

test('PiAcpSession: preserves repeated runtime extension errors in event order exactly once each', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's-runtime-order',
    cwd: '/workspace/acme',
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'before' } })
  proc.emit(RUNTIME_EXTENSION_EVENT)
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'between' } })
  proc.emit(RUNTIME_EXTENSION_EVENT)
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'after' } })

  await new Promise(r => setTimeout(r, 0))

  assert.deepEqual(
    conn.updates.map(entry => (entry.update as any).content?.text),
    ['before', RUNTIME_EXTENSION_SUMMARY, 'between', RUNTIME_EXTENSION_SUMMARY, 'after']
  )
  assert.equal(
    conn.updates.filter(entry => (entry.update as any)._meta?.piAcp?.diagnostic?.code === 'PI_EXTENSION_RUNTIME_ERROR')
      .length,
    2
  )
  assert.deepEqual((conn.updates[1]!.update as any)._meta, (conn.updates[3]!.update as any)._meta)
})

test('PiAcpSession: runtime extension errors flush before end_turn and leave the queued prompt intact', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const timeline: string[] = []
  const originalSessionUpdate = conn.sessionUpdate.bind(conn)
  let markExtensionUpdateStarted!: () => void
  let releaseExtensionUpdate!: () => void
  const extensionUpdateStarted = new Promise<void>(resolve => {
    markExtensionUpdateStarted = resolve
  })
  const extensionUpdateGate = new Promise<void>(resolve => {
    releaseExtensionUpdate = resolve
  })

  conn.sessionUpdate = async message => {
    await originalSessionUpdate(message)
    if ((message.update as any)._meta?.piAcp?.diagnostic?.code === 'PI_EXTENSION_RUNTIME_ERROR') {
      timeline.push('extension_update_started')
      markExtensionUpdateStarted()
      await extensionUpdateGate
      timeline.push('extension_update_flushed')
    }
  }

  const session = new PiAcpSession({
    sessionId: 's-runtime-turn',
    cwd: '/workspace/acme',
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  let firstResolutionCount = 0
  const first = session.prompt('one').then(reason => {
    firstResolutionCount += 1
    timeline.push(`first_${reason}`)
    return reason
  })
  const second = session.prompt('two')

  proc.emit(RUNTIME_EXTENSION_EVENT)
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end' })

  await extensionUpdateStarted
  assert.equal(firstResolutionCount, 0)
  assert.deepEqual(
    proc.prompts.map(prompt => prompt.message),
    ['one']
  )

  proc.emit({ type: 'agent_settled' })
  await new Promise(r => setTimeout(r, 0))
  assert.equal(firstResolutionCount, 0)

  releaseExtensionUpdate()
  assert.equal(await first, 'end_turn')
  assert.equal(firstResolutionCount, 1)
  assert.deepEqual(timeline, ['extension_update_started', 'extension_update_flushed', 'first_end_turn'])
  assert.deepEqual(
    proc.prompts.map(prompt => prompt.message),
    ['one', 'two']
  )
  assert.equal(
    conn.updates.filter(entry => (entry.update as any)._meta?.piAcp?.diagnostic?.code === 'PI_EXTENSION_RUNTIME_ERROR')
      .length,
    1
  )

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await second, 'end_turn')
  assert.equal(firstResolutionCount, 1)
})

test('PiAcpSession: snapshots the parent environment and Pi agent directory for runtime diagnostics', async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  const previousApiKey = process.env.C1_2_SNAPSHOT_API_KEY
  const originalAgentDir = '/home/tester/.pi/agent-snapshot'
  const originalSecret = 'C1_2_ORIGINAL_INHERITED_SECRET'
  const replacementSecret = 'C1_2_LATER_PROCESS_VALUE'

  try {
    process.env.PI_CODING_AGENT_DIR = originalAgentDir
    process.env.C1_2_SNAPSHOT_API_KEY = originalSecret

    const conn = new FakeAgentSideConnection()
    const proc = new FakePiRpcProcess()

    new PiAcpSession({
      sessionId: 's-runtime-env',
      cwd: '/workspace/acme',
      mcpServers: [],
      proc: proc as any,
      conn: asAgentConn(conn),
      fileCommands: []
    })

    process.env.PI_CODING_AGENT_DIR = '/home/tester/.pi/different-agent'
    process.env.C1_2_SNAPSHOT_API_KEY = replacementSecret

    proc.emit({
      type: 'extension_error',
      extensionPath: `${originalAgentDir}/extensions/failing.ts`,
      event: 'before_agent_start',
      error: `failed with ${originalSecret}; later value ${replacementSecret}`
    })

    await new Promise(r => setTimeout(r, 0))

    const diagnostic = (conn.updates[0]!.update as any)._meta.piAcp.diagnostic
    assert.equal(diagnostic.source, 'global:extensions/failing.ts')
    assert.equal(diagnostic.summary.includes(originalAgentDir), false)
    assert.equal(diagnostic.summary.includes(originalSecret), false)
    assert.equal(diagnostic.summary.includes('[REDACTED]'), true)
    assert.equal(diagnostic.summary.includes(replacementSecret), true)
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir

    if (previousApiKey === undefined) delete process.env.C1_2_SNAPSHOT_API_KEY
    else process.env.C1_2_SNAPSHOT_API_KEY = previousApiKey
  }
})

test('PiAcpSession: malformed runtime extension errors never throw and use safe fallbacks', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's-runtime-malformed',
    cwd: '/workspace/acme',
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  assert.doesNotThrow(() => {
    proc.emit({
      type: 'extension_error',
      extensionPath: 42,
      event: null,
      error: { message: 'nested raw error must be ignored' },
      stack: 'internal stack must be ignored'
    })
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  const update = conn.updates[0]!.update as any
  assert.deepEqual(
    {
      sessionUpdate: update.sessionUpdate,
      text: update.content.text,
      notify: update._meta.piAcp.notify,
      source: update._meta.piAcp.diagnostic.source,
      event: update._meta.piAcp.diagnostic.event
    },
    {
      sessionUpdate: 'agent_message_chunk',
      text: 'Pi extension error (source: unknown; event: unknown):\nPi reported an extension runtime error.',
      notify: { level: 'error' },
      source: 'unknown',
      event: 'unknown'
    }
  )
  assert.equal(update.content.text.includes('nested raw error'), false)
  assert.equal(update.content.text.includes('internal stack'), false)
})

test('PiAcpSession: emits tool_call + tool_call_update + completes', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } })
  proc.emit({
    type: 'tool_execution_update',
    toolCallId: 't1',
    partialResult: { content: [{ type: 'text', text: 'running' }] }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    isError: false,
    result: { content: [{ type: 'text', text: 'done' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 3)

  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.equal((conn.updates[0]!.update as any).toolCallId, 't1')
  assert.equal((conn.updates[0]!.update as any).title, 'ls')
  assert.equal((conn.updates[0]!.update as any).kind, 'execute')
  assert.equal((conn.updates[0]!.update as any).status, 'in_progress')
  assert.equal((conn.updates[0]!.update as any).locations, undefined)
  assert.deepEqual((conn.updates[0]!.update as any).content, [{ type: 'terminal', terminalId: 't1' }])
  assert.deepEqual((conn.updates[0]!.update as any)._meta, {
    terminal_info: { terminal_id: 't1', cwd: process.cwd() }
  })
  assert.equal((conn.updates[0]!.update as any).rawInput, undefined)

  assert.equal(conn.updates[1]!.update.sessionUpdate, 'tool_call_update')
  assert.equal((conn.updates[1]!.update as any).toolCallId, 't1')
  assert.equal((conn.updates[1]!.update as any).status, 'in_progress')
  assert.equal((conn.updates[1]!.update as any).content, undefined)
  assert.deepEqual((conn.updates[1]!.update as any)._meta, {
    terminal_output: { terminal_id: 't1', data: 'running' }
  })
  assert.equal((conn.updates[1]!.update as any).rawOutput, undefined)

  assert.equal(conn.updates[2]!.update.sessionUpdate, 'tool_call_update')
  assert.equal((conn.updates[2]!.update as any).toolCallId, 't1')
  assert.equal((conn.updates[2]!.update as any).status, 'completed')
  assert.equal((conn.updates[2]!.update as any).content, undefined)
  assert.deepEqual((conn.updates[2]!.update as any)._meta, {
    terminal_output: { terminal_id: 't1', data: 'done' },
    terminal_exit: { terminal_id: 't1', exit_code: 0, signal: null }
  })
  assert.equal((conn.updates[2]!.update as any).rawOutput, undefined)
})

test('PiAcpSession: emits tool locations from pi path args', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: 'src/acp/session.ts' } })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: `${process.cwd()}/src/acp/session.ts` }])
})

test('PiAcpSession: handles extension select via ACP permission request', async () => {
  const conn = new FakeAgentSideConnection()
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'choice-1' } }
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-1',
    method: 'select',
    title: 'Pick one',
    options: ['Alpha', 'Beta']
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.permissionRequests.length, 1)
  assert.deepEqual(conn.permissionRequests[0], {
    sessionId: 's1',
    toolCall: {
      toolCallId: 'pi-ui-ui-1',
      title: 'Pick one',
      kind: 'other',
      status: 'pending',
      rawInput: { method: 'select', title: 'Pick one', options: ['Alpha', 'Beta'] }
    },
    options: [
      { optionId: 'choice-0', name: 'Alpha', kind: 'allow_once' },
      { optionId: 'choice-1', name: 'Beta', kind: 'allow_once' }
    ]
  })
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-1', value: 'Beta' }])
})

test('PiAcpSession: handles extension confirm via ACP permission request', async () => {
  const conn = new FakeAgentSideConnection()
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'no' } }
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-2',
    method: 'confirm',
    title: 'Clear session?',
    message: 'All messages will be lost.'
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.permissionRequests.length, 1)
  assert.deepEqual((conn.permissionRequests[0] as any).options, [
    { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
    { optionId: 'no', name: 'No', kind: 'reject_once' }
  ])
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-2', confirmed: false }])
})

test('PiAcpSession: sends cancelled response when ACP confirm is cancelled', async () => {
  const conn = new FakeAgentSideConnection()
  conn.nextPermissionResponse = { outcome: { outcome: 'cancelled' } }
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'extension_ui_request', id: 'ui-5', method: 'confirm', title: 'Continue?' })

  await new Promise(r => setTimeout(r, 0))

  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-5', cancelled: true }])
})

test('PiAcpSession: cancels unsupported input and editor extension UI requests with visible fallback', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'extension_ui_request', id: 'ui-3', method: 'input', title: 'Enter name' })
  proc.emit({ type: 'extension_ui_request', id: 'ui-4', method: 'editor', title: 'Edit text' })

  await new Promise(r => setTimeout(r, 0))

  assert.deepEqual(proc.extensionUiResponses, [
    { id: 'ui-3', cancelled: true },
    { id: 'ui-4', cancelled: true }
  ])
  assert.equal(conn.updates.length, 2)
  assert.match((conn.updates[0]!.update as any).content.text, /input UI request is not supported/)
  assert.match((conn.updates[1]!.update as any).content.text, /editor UI request is not supported/)
})

test('PiAcpSession: emits agent_message_chunk for auto_retry_start with attempt/maxAttempts and rounded delay', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_retry_start', attempt: 2, maxAttempts: 5, delayMs: 2400 })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Retrying (attempt 2/5, waiting 2s)...' }
  })
})

test('PiAcpSession: formats a positive sub-second auto_retry_start delay as waiting 1s', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 1 })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Retrying (attempt 1/3, waiting 1s)...' }
  })
})

test('PiAcpSession: falls back to a generic retry message when auto_retry_start fields are missing or malformed', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_retry_start', attempt: 'oops', maxAttempts: null, delayMs: 'bad' } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Retrying...' }
  })
})

test('PiAcpSession: omits raw errorMessage content from surfaced auto_retry_start status text', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'auto_retry_start',
    attempt: 1,
    maxAttempts: 4,
    delayMs: 1500,
    errorMessage: 'provider overloaded: 529'
  } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'agent_message_chunk')
  assert.equal((conn.updates[0]!.update as any).content.text, 'Retrying (attempt 1/4, waiting 2s)...')
  assert.equal((conn.updates[0]!.update as any).content.text.includes('provider overloaded'), false)
})

test('PiAcpSession: emits agent_message_chunk for auto_retry_end', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_retry_end' } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Retry finished, resuming.' }
  })
})

test('PiAcpSession: emits agent_message_chunk for auto_compaction_start', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_compaction_start' } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Context nearing limit, running automatic compaction...' }
  })
})

test('PiAcpSession: emits agent_message_chunk for auto_compaction_end', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'auto_compaction_end' } as any)

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: {
      type: 'text',
      text: 'Automatic compaction finished; context was summarized to continue the session.'
    }
  })
})

test('PiAcpSession: preserves ordering when auto_retry_start is interleaved with text_delta events', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'before ' } })
  proc.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 2, delayMs: 2000 } as any)
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'after' } })

  await new Promise(r => setTimeout(r, 0))

  assert.deepEqual(
    conn.updates.map(u => u.update),
    [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'before ' } },
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Retrying (attempt 1/2, waiting 2s)...' }
      },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after' } }
    ]
  )
})

test('PiAcpSession: emits streamed tool locations from pi path args', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_start',
      toolCall: {
        id: 't1',
        name: 'write',
        arguments: { path: '/tmp/test.txt', content: 'hello' }
      }
    }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: '/tmp/test.txt' }])
})

test('PiAcpSession: emits edit tool line when oldText matches uniquely', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-lines-'))
  const filePath = join(cwd, 'a.txt')

  mkdirSync(cwd, { recursive: true })
  writeFileSync(filePath, 'one\ntwo\nneedle\nthree\n', 'utf8')

  new PiAcpSession({
    sessionId: 's1',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'edit',
    args: { path: 'a.txt', oldText: 'needle' }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: filePath, line: 3 }])
})

test('PiAcpSession: emits edit tool line from edits array when oldText matches uniquely', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-lines-edits-'))
  const filePath = join(cwd, 'a.txt')

  mkdirSync(cwd, { recursive: true })
  writeFileSync(filePath, 'one\ntwo\nneedle\nthree\n', 'utf8')

  new PiAcpSession({
    sessionId: 's1',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'edit',
    args: { path: 'a.txt', edits: [{ oldText: 'needle', newText: 'replacement' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: filePath, line: 3 }])
})

test('PiAcpSession: emits edit tool line from stringified edits array', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-lines-edits-string-'))
  const filePath = join(cwd, 'a.txt')

  mkdirSync(cwd, { recursive: true })
  writeFileSync(filePath, 'one\ntwo\nneedle\nthree\n', 'utf8')

  new PiAcpSession({
    sessionId: 's1',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'edit',
    args: { path: 'a.txt', edits: JSON.stringify([{ oldText: 'needle', newText: 'replacement' }]) }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: filePath, line: 3 }])
})

test('PiAcpSession: omits edit tool line when oldText matches multiple times', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-lines-dup-'))
  const filePath = join(cwd, 'a.txt')

  mkdirSync(cwd, { recursive: true })
  writeFileSync(filePath, 'one\nneedle\ntwo\nneedle\n', 'utf8')

  new PiAcpSession({
    sessionId: 's1',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't2',
    toolName: 'edit',
    args: { path: 'a.txt', oldText: 'needle' }
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.equal(conn.updates[0]!.update.sessionUpdate, 'tool_call')
  assert.deepEqual((conn.updates[0]!.update as any).locations, [{ path: filePath }])
})

test('PiAcpSession: prompt stays open through retry runs until agent_settled', async () => {
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

  let resolved = false
  const p = session.prompt('hello').then(reason => {
    resolved = true
    return reason
  })

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000 })
  proc.emit({ type: 'agent_end', willRetry: true })
  await new Promise(r => setTimeout(r, 0))
  assert.equal(resolved, false)

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end', willRetry: false })
  await new Promise(r => setTimeout(r, 0))
  assert.equal(resolved, false)

  proc.emit({ type: 'agent_settled' })
  const reason = await p
  assert.equal(reason, 'end_turn')
})

test('PiAcpSession: does not re-emit startup info on first prompt after it was already sent', async () => {
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

  const notice = 'New version available: v0.74.0 (installed v0.73.1).'

  session.setStartupInfo(notice)
  session.sendStartupInfoIfPending()
  await new Promise(r => setTimeout(r, 0))

  const p = session.prompt('hello')
  await new Promise(r => setTimeout(r, 0))

  assert.equal(proc.prompts.length, 1)
  assert.equal(proc.prompts[0]!.message, 'hello')
  const startupUpdates = conn.updates.filter(
    entry =>
      entry.update.sessionUpdate === 'agent_message_chunk' &&
      (entry.update as any).content?.type === 'text' &&
      (entry.update as any).content?.text === notice
  )
  assert.equal(startupUpdates.length, 1)

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })

  const reason = await p
  assert.equal(reason, 'end_turn')
})

test('PiAcpSession: cancel flips stopReason to cancelled', async () => {
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

  const p = session.prompt('hello')
  await session.cancel()
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  const reason = await p

  assert.equal(proc.abortCount, 1)
  assert.equal(reason, 'cancelled')
})

test('PiAcpSession: queues concurrent prompt and starts it after agent_settled', async () => {
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

  const first = session.prompt('one')
  const second = session.prompt('two')

  assert.equal(proc.prompts.length, 1)
  assert.equal(proc.prompts[0]!.message, 'one')

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })

  const r1 = await first
  assert.equal(r1, 'end_turn')

  assert.equal(proc.prompts.length, 2)
  assert.equal(proc.prompts[1]!.message, 'two')

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })

  const r2 = await second
  assert.equal(r2, 'end_turn')
})

test('PiAcpSession: cancel clears queued prompts', async () => {
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

  const first = session.prompt('one')
  const second = session.prompt('two')

  assert.equal(proc.prompts.length, 1)

  await session.cancel()
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })

  const r1 = await first
  const r2 = await second

  assert.equal(r1, 'cancelled')
  assert.equal(r2, 'cancelled')
})

test('PiAcpSession: expands /command before sending to pi', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [
      {
        name: 'hello',
        description: 'test',
        content: 'Say hello to $1',
        source: '(project)'
      }
    ]
  })

  const p = session.prompt('/hello world')
  assert.equal(proc.prompts.length, 1)
  assert.equal(proc.prompts[0]!.message, 'Say hello to world')

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })

  const reason = await p
  assert.equal(reason, 'end_turn')
})

test('PiAcpSession: tags extension notify chunks with severity in _meta', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'extension_ui_request',
    id: 'n1',
    method: 'notify',
    message: 'MCP: connection failed',
    notifyType: 'error'
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'MCP: connection failed' },
    _meta: { piAcp: { notify: { level: 'error' } } }
  })
  assert.deepEqual(proc.extensionUiResponses[0], { id: 'n1', cancelled: true })
})

test('PiAcpSession: defaults notify severity to info when notifyType is absent', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'extension_ui_request',
    id: 'n2',
    method: 'notify',
    message: 'heads up'
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual((conn.updates[0]!.update as any)._meta, {
    piAcp: { notify: { level: 'info' } }
  })
})
