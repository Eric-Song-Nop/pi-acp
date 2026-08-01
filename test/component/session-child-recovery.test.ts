import test from 'node:test'
import assert from 'node:assert/strict'
import { RequestError } from '@agentclientprotocol/sdk'
import { PI_RPC_PROCESS_TERMINATED_CODE, PiRpcProcessTerminatedError } from '../../src/pi-rpc/process.js'
import { PiAcpSession, TERMINAL_UPDATE_FLUSH_TIMEOUT_MS } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function terminalError(exitCode = 9): PiRpcProcessTerminatedError {
  return new PiRpcProcessTerminatedError(
    `Pi RPC process exited before completing the request (code=${exitCode}).`,
    undefined,
    {
      kind: 'exit',
      code: exitCode
    }
  )
}

function createSession(proc: FakePiRpcProcess, conn: FakeAgentSideConnection): PiAcpSession {
  return new PiAcpSession({
    sessionId: 'recovery-session',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
}

test('PiAcpSession: disposing an active prompt publishes one stopped terminal cut before one rejection', async () => {
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

  const conn = new TimelineConnection()
  const proc = new FakePiRpcProcess()
  const causal = new PiRpcProcessTerminatedError('The Pi RPC process was stopped.', undefined, {
    kind: 'stopped'
  })
  proc.stop = async () => {
    proc.stopCount += 1
    proc.terminate(causal)
  }
  const session = createSession(proc, conn)
  let rejectionCount = 0
  let successCount = 0
  const promptOutcome = session.prompt('one').then(
    value => {
      successCount += 1
      return value
    },
    error => {
      rejectionCount += 1
      timeline.push('prompt-rejected')
      return error
    }
  )

  for (let attempt = 0; attempt < 100 && proc.prompts.length === 0; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  assert.equal(proc.prompts.length, 1, 'prompt was not admitted before disposal')

  await Promise.all([session.dispose(), session.dispose()])
  const error = await promptOutcome

  assert.ok(error instanceof RequestError)
  assert.equal(error.code, -32603)
  assert.equal(error.data, causal.data)
  assert.equal((error.data as any).code, PI_RPC_PROCESS_TERMINATED_CODE)
  assert.equal((error.data as any).piAcp.process.cause, 'stopped')
  assert.equal(proc.stopCount, 1)
  assert.equal(rejectionCount, 1)
  assert.equal(successCount, 0)
  assert.deepEqual(timeline, ['terminal-idle', 'prompt-rejected'])
  assert.equal(
    conn.updates.filter(
      entry =>
        (entry.update as any).sessionUpdate === 'session_info_update' &&
        (entry.update as any)._meta?.piAcp?.running === false
    ).length,
    1
  )
})

test('PiAcpSession: terminal-first flushes a fixed idle cut then rejects active and queued FIFO with one error', async () => {
  const timeline: string[] = []
  let releaseBlockedUpdate!: () => void
  const blockedUpdate = new Promise<void>(resolve => {
    releaseBlockedUpdate = resolve
  })
  let blockedUpdateStarted!: () => void
  const updateStarted = new Promise<void>(resolve => {
    blockedUpdateStarted = resolve
  })
  const proc = new FakePiRpcProcess()

  class GatedConnection extends FakeAgentSideConnection {
    override async sessionUpdate(msg: Parameters<FakeAgentSideConnection['sessionUpdate']>[0]): Promise<void> {
      this.updates.push(msg)
      const update = msg.update as any
      const text = update.content?.text
      if (text === 'before exit') {
        timeline.push('prior-update-started')
        blockedUpdateStarted()
        await blockedUpdate
        // Reentrant producer after the terminal cut must be quarantined.
        proc.emit({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'too late' }
        })
        timeline.push('prior-update-flushed')
      } else if (update.sessionUpdate === 'session_info_update' && update._meta?.piAcp?.running === false) {
        timeline.push('idle-flushed')
      }
    }
  }

  const conn = new GatedConnection()
  const session = createSession(proc, conn)
  const observe = (label: string, promise: Promise<unknown>) =>
    promise.then(
      value => value,
      error => {
        timeline.push(label)
        return error
      }
    )

  const first = observe('active-rejected', session.prompt('one'))
  const second = observe('queued-1-rejected', session.prompt('two'))
  const third = observe('queued-2-rejected', session.prompt('three'))

  proc.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'before exit' }
  })
  await updateStarted

  const causal = terminalError()
  proc.terminate(causal)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(timeline.includes('active-rejected'), false)

  releaseBlockedUpdate()
  const [activeError, queuedError1, queuedError2] = await Promise.all([first, second, third])

  assert.ok(activeError instanceof RequestError)
  assert.equal((activeError as RequestError).code, -32603)
  assert.equal((activeError as RequestError).data, causal.data)
  assert.equal(queuedError1, activeError)
  assert.equal(queuedError2, activeError)
  assert.equal(proc.prompts.length, 1)
  assert.deepEqual(timeline, [
    'prior-update-started',
    'prior-update-flushed',
    'idle-flushed',
    'active-rejected',
    'queued-1-rejected',
    'queued-2-rejected'
  ])
  assert.equal(
    conn.updates.some(entry => (entry.update as any).content?.text === 'too late'),
    false
  )
})

test('PiAcpSession: terminal cut bounds a permanently stuck notification sink', async () => {
  class StuckConnection extends FakeAgentSideConnection {
    override async sessionUpdate(msg: Parameters<FakeAgentSideConnection['sessionUpdate']>[0]): Promise<void> {
      this.updates.push(msg)
      await new Promise<void>(() => {})
    }
  }

  const conn = new StuckConnection()
  const proc = new FakePiRpcProcess()
  const session = createSession(proc, conn)
  const startedAt = Date.now()
  const prompt = session.prompt('one').then(
    () => null,
    error => error
  )

  proc.terminate(terminalError())
  const error = await prompt
  const elapsedMs = Date.now() - startedAt

  assert.ok(error instanceof RequestError)
  assert.equal(error.code, -32603)
  assert.ok(elapsedMs >= TERMINAL_UPDATE_FLUSH_TIMEOUT_MS - 75, `terminal settled too early: ${elapsedMs}ms`)
  assert.ok(elapsedMs < TERMINAL_UPDATE_FLUSH_TIMEOUT_MS + 750, `terminal settled too late: ${elapsedMs}ms`)
})

test('PiAcpSession: terminal cut bounds a settled-first active success while failing its frozen queue', async () => {
  class StuckConnection extends FakeAgentSideConnection {
    override async sessionUpdate(msg: Parameters<FakeAgentSideConnection['sessionUpdate']>[0]): Promise<void> {
      this.updates.push(msg)
      await new Promise<void>(() => {})
    }
  }

  const conn = new StuckConnection()
  const proc = new FakePiRpcProcess()
  const session = createSession(proc, conn)
  const first = session.prompt('one')
  const second = session.prompt('two').then(
    () => null,
    error => error
  )
  const startedAt = Date.now()

  proc.emit({ type: 'agent_settled' })
  proc.terminate(terminalError(19))

  assert.equal(await first, 'end_turn')
  const queuedError = await second
  const elapsedMs = Date.now() - startedAt
  assert.ok(queuedError instanceof RequestError)
  assert.equal(queuedError.code, -32603)
  assert.equal(proc.prompts.length, 1)
  assert.ok(elapsedMs >= TERMINAL_UPDATE_FLUSH_TIMEOUT_MS - 75, `terminal settled too early: ${elapsedMs}ms`)
  assert.ok(elapsedMs < TERMINAL_UPDATE_FLUSH_TIMEOUT_MS + 750, `terminal settled too late: ${elapsedMs}ms`)

  const disposeStartedAt = Date.now()
  await session.dispose()
  assert.ok(Date.now() - disposeStartedAt < 250, 'dispose waited on the superseded stable-tail notification')
})

test('PiAcpSession: settled-first completes only the active turn and terminal rejects the queue', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = createSession(proc, conn)
  const first = session.prompt('one')
  const second = session.prompt('two').then(
    () => null,
    error => error
  )

  proc.emit({ type: 'agent_settled' })
  proc.terminate(terminalError(17))

  assert.equal(await first, 'end_turn')
  const queuedError = await second
  assert.ok(queuedError instanceof RequestError)
  assert.equal(queuedError.code, -32603)
  assert.equal((queuedError.data as any).code, PI_RPC_PROCESS_TERMINATED_CODE)
  assert.equal(proc.prompts.length, 1)
})

test('PiAcpSession: committed handoff isolates successor from stale catch and duplicate settled', async () => {
  let releaseOldFlush!: () => void
  const oldFlush = new Promise<void>(resolve => {
    releaseOldFlush = resolve
  })
  let oldFlushStarted!: () => void
  const oldFlushStart = new Promise<void>(resolve => {
    oldFlushStarted = resolve
  })
  let gated = false
  class GatedConnection extends FakeAgentSideConnection {
    override async sessionUpdate(msg: Parameters<FakeAgentSideConnection['sessionUpdate']>[0]): Promise<void> {
      this.updates.push(msg)
      if (!gated) {
        gated = true
        oldFlushStarted()
        await oldFlush
      }
    }
  }

  const conn = new GatedConnection()
  const proc = new FakePiRpcProcess()
  let rejectFirstAck!: (error: unknown) => void
  const firstAck = new Promise<void>((_resolve, reject) => {
    rejectFirstAck = reject
  })
  let promptNumber = 0
  proc.prompt = async (message: string, attachments: unknown[] = []) => {
    proc.prompts.push({ message, attachments })
    promptNumber += 1
    if (promptNumber === 1) await firstAck
  }
  const session = createSession(proc, conn)
  const first = session.prompt('one')
  let secondSettled = false
  const second = session.prompt('two').then(
    value => {
      secondSettled = true
      return value
    },
    error => {
      secondSettled = true
      return error
    }
  )

  await oldFlushStart
  proc.emit({ type: 'agent_settled' })

  // Cancellation observed after the immutable old-turn completion claim but
  // before its notification barrier/handoff must not abort either generation.
  await session.cancel()
  assert.equal(proc.abortCount, 0)
  releaseOldFlush()
  assert.equal(await first, 'end_turn')
  assert.equal(proc.prompts.length, 2)

  // A duplicate terminal marker from the prior turn cannot claim a handed-off
  // successor before that successor begins its own agent loop.
  proc.emit({ type: 'agent_settled' })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(secondSettled, false)

  // The old prompt RPC rejection is tied to the immutable first-turn identity.
  rejectFirstAck(new Error('late first-turn acknowledgement failure'))
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(secondSettled, false)

  proc.terminate(terminalError(23))
  const successorError = await second

  assert.ok(successorError instanceof RequestError)
  assert.equal(successorError.code, -32603)
  assert.equal(proc.abortCount, 0)
  assert.equal(proc.prompts.length, 2)
})

test('PiAcpSession: cancellation recorded before terminal wins and idle cancel writes no abort', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = createSession(proc, conn)

  await session.cancel()
  assert.equal(proc.abortCount, 0)

  const prompt = session.prompt('one')
  await session.cancel()
  proc.terminate(terminalError())

  assert.equal(await prompt, 'cancelled')
  assert.equal(proc.abortCount, 1)
})

test('PiAcpSession: abort terminal failure keeps the prior cancel claim and maps the same causal envelope', async () => {
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

  const conn = new TimelineConnection()
  const proc = new FakePiRpcProcess()
  const causal = terminalError(29)
  proc.abort = async () => {
    proc.abortCount += 1
    proc.terminate(causal)
    throw causal
  }
  const session = createSession(proc, conn)
  const prompt = session.prompt('one')
  const cancelError = session.cancel().then(
    () => null,
    error => {
      timeline.push('cancel-rejected')
      return error
    }
  )

  assert.equal(await prompt, 'cancelled')
  const error = await cancelError
  assert.ok(error instanceof RequestError)
  assert.equal(error.code, -32603)
  assert.equal(error.data, causal.data)
  assert.equal((error.data as any).piAcp.recovery.automaticReplay, false)
  assert.deepEqual(timeline, ['terminal-idle', 'cancel-rejected'])
  assert.equal(proc.abortCount, 1)
})

test('PiAcpSession: prompt acknowledgement failures reject active and queue without empty end_turn or replay', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.prompt = async (message: string, attachments: unknown[] = []) => {
    proc.prompts.push({ message, attachments })
    throw new Error('synthetic acknowledgement failure')
  }
  const session = createSession(proc, conn)

  const first = session.prompt('one').then(
    () => null,
    error => error
  )
  const second = session.prompt('two').then(
    () => null,
    error => error
  )
  const [firstError, secondError] = await Promise.all([first, second])

  assert.ok(firstError instanceof RequestError)
  assert.equal(firstError.code, -32603)
  assert.deepEqual(firstError.data, { code: 'PI_PROMPT_FAILED' })
  assert.equal(secondError, firstError)
  assert.equal(proc.prompts.length, 1)
})

test('PiAcpSession: a fresh prompt arriving behind a claimed acknowledgement failure is handed off', async () => {
  let releaseFailureFlush!: () => void
  const failureFlush = new Promise<void>(resolve => {
    releaseFailureFlush = resolve
  })
  let markFailureFlushStarted!: () => void
  const failureFlushStarted = new Promise<void>(resolve => {
    markFailureFlushStarted = resolve
  })
  let gated = false
  class GatedConnection extends FakeAgentSideConnection {
    override async sessionUpdate(msg: Parameters<FakeAgentSideConnection['sessionUpdate']>[0]): Promise<void> {
      this.updates.push(msg)
      if (!gated) {
        gated = true
        markFailureFlushStarted()
        await failureFlush
      }
    }
  }

  const conn = new GatedConnection()
  const proc = new FakePiRpcProcess()
  let promptNumber = 0
  proc.prompt = async (message: string, attachments: unknown[] = []) => {
    proc.prompts.push({ message, attachments })
    promptNumber += 1
    if (promptNumber === 1) throw new Error('synthetic acknowledgement failure')
  }
  const session = createSession(proc, conn)
  const observeFailure = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      error => error
    )
  const first = observeFailure(session.prompt('one'))
  const frozenQueue = observeFailure(session.prompt('two'))

  await failureFlushStarted
  for (let attempt = 0; attempt < 100 && !(session as any).pendingTurn?.claim; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  assert.ok((session as any).pendingTurn?.claim, 'prompt failure did not claim the frozen batch')

  const fresh = session.prompt('fresh')
  releaseFailureFlush()
  const [firstError, queuedError] = await Promise.all([first, frozenQueue])
  assert.ok(firstError instanceof RequestError)
  assert.equal(queuedError, firstError)

  for (let attempt = 0; attempt < 100 && proc.prompts.length < 2; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  assert.deepEqual(
    proc.prompts.map(entry => entry.message),
    ['one', 'fresh']
  )
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await fresh, 'end_turn')
})

test('PiAcpSession: terminal fixed cut settles the full frozen acknowledgement-failure batch', async () => {
  class StuckConnection extends FakeAgentSideConnection {
    override async sessionUpdate(msg: Parameters<FakeAgentSideConnection['sessionUpdate']>[0]): Promise<void> {
      this.updates.push(msg)
      await new Promise<void>(() => {})
    }
  }

  const conn = new StuckConnection()
  const proc = new FakePiRpcProcess()
  proc.prompt = async (message: string, attachments: unknown[] = []) => {
    proc.prompts.push({ message, attachments })
    throw new Error('synthetic acknowledgement failure')
  }
  const session = createSession(proc, conn)
  const observe = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      error => error
    )
  const active = observe(session.prompt('one'))
  const queued = observe(session.prompt('two'))

  for (let attempt = 0; attempt < 100 && !(session as any).pendingTurn?.completionBatch; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  assert.equal((session as any).pendingTurn?.completionBatch?.length, 2)
  const startedAt = Date.now()
  proc.terminate(terminalError(47))
  const [activeError, queuedError] = await Promise.all([active, queued])
  const elapsedMs = Date.now() - startedAt

  assert.ok(activeError instanceof RequestError)
  assert.deepEqual(activeError.data, { code: 'PI_PROMPT_FAILED' })
  assert.equal(queuedError, activeError)
  assert.ok(elapsedMs >= TERMINAL_UPDATE_FLUSH_TIMEOUT_MS - 75, `terminal settled too early: ${elapsedMs}ms`)
  assert.ok(elapsedMs < TERMINAL_UPDATE_FLUSH_TIMEOUT_MS + 750, `terminal settled too late: ${elapsedMs}ms`)
  assert.equal(proc.prompts.length, 1)
})
