import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  PiRpcExecuteCommandProtocolError,
  PiRpcProcess,
  validatePiRpcExecuteCommandResponse
} from '../../src/pi-rpc/process.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

function successResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'request-1',
    type: 'response',
    command: 'execute_command',
    success: true,
    data: {
      requestId: 'request-1',
      name: 'fixture-state',
      source: 'extension',
      sourceInfo: {},
      disposition: 'handled'
    },
    ...overrides
  }
}

test('validatePiRpcExecuteCommandResponse accepts exact handled, agent_run, and rejected identities', () => {
  assert.deepEqual(validatePiRpcExecuteCommandResponse(successResponse(), 'request-1', 'fixture-state'), {
    success: true,
    data: {
      requestId: 'request-1',
      name: 'fixture-state',
      source: 'extension',
      sourceInfo: {},
      disposition: 'handled'
    }
  })

  assert.deepEqual(
    validatePiRpcExecuteCommandResponse(
      successResponse({
        data: {
          requestId: 'request-1',
          name: 'fixture-agent',
          source: 'extension',
          sourceInfo: {},
          disposition: 'agent_run'
        }
      }),
      'request-1',
      'fixture-agent'
    ),
    {
      success: true,
      data: {
        requestId: 'request-1',
        name: 'fixture-agent',
        source: 'extension',
        sourceInfo: {},
        disposition: 'agent_run'
      }
    }
  )

  assert.deepEqual(
    validatePiRpcExecuteCommandResponse(
      {
        id: 'request-1',
        type: 'response',
        command: 'execute_command',
        success: false,
        error: 'private Pi detail retained inside the adapter',
        data: {
          requestId: 'request-1',
          name: 'fixture-state',
          disposition: 'rejected',
          code: 'COMMAND_HANDLER_FAILED'
        }
      },
      'request-1',
      'fixture-state'
    ),
    {
      success: false,
      error: 'private Pi detail retained inside the adapter',
      data: {
        requestId: 'request-1',
        name: 'fixture-state',
        disposition: 'rejected',
        code: 'COMMAND_HANDLER_FAILED'
      }
    }
  )
})

test('validatePiRpcExecuteCommandResponse rejects identity, disposition, sourceInfo, and error drift', async t => {
  const malformed: Array<[string, unknown]> = [
    ['response id', successResponse({ id: 'other-request' })],
    ['command', successResponse({ command: 'prompt' })],
    [
      'requestId',
      successResponse({
        data: {
          requestId: 'other-request',
          name: 'fixture-state',
          source: 'extension',
          sourceInfo: {},
          disposition: 'handled'
        }
      })
    ],
    [
      'name',
      successResponse({
        data: {
          requestId: 'request-1',
          name: 'Fixture-State',
          source: 'extension',
          sourceInfo: {},
          disposition: 'handled'
        }
      })
    ],
    [
      'source',
      successResponse({
        data: {
          requestId: 'request-1',
          name: 'fixture-state',
          source: 'prompt',
          sourceInfo: {},
          disposition: 'handled'
        }
      })
    ],
    [
      'sourceInfo',
      successResponse({
        data: {
          requestId: 'request-1',
          name: 'fixture-state',
          source: 'extension',
          sourceInfo: { path: '/private/extension.ts' },
          disposition: 'handled'
        }
      })
    ],
    [
      'disposition',
      successResponse({
        data: {
          requestId: 'request-1',
          name: 'fixture-state',
          source: 'extension',
          sourceInfo: {},
          disposition: 'queued'
        }
      })
    ],
    [
      'failure error',
      {
        id: 'request-1',
        type: 'response',
        command: 'execute_command',
        success: false,
        error: '',
        data: {
          requestId: 'request-1',
          name: 'fixture-state',
          disposition: 'rejected',
          code: 'COMMAND_BUSY'
        }
      }
    ],
    [
      'failure code',
      {
        id: 'request-1',
        type: 'response',
        command: 'execute_command',
        success: false,
        error: 'rejected',
        data: {
          requestId: 'request-1',
          name: 'fixture-state',
          disposition: 'rejected',
          code: 'UNKNOWN_CODE'
        }
      }
    ]
  ]

  for (const [label, response] of malformed) {
    await t.test(label, () => {
      assert.throws(
        () => validatePiRpcExecuteCommandResponse(response, 'request-1', 'fixture-state'),
        PiRpcExecuteCommandProtocolError
      )
    })
  }
})

function createWireProcess(onRequest: (request: Record<string, unknown>) => Record<string, unknown> | undefined): {
  proc: PiRpcProcess
  requests: Record<string, unknown>[]
  writeStdoutRecord: (record: unknown) => void
  terminate: (code?: number) => void
} {
  const events = new EventEmitter()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const requests: Record<string, unknown>[] = []
  let buffered = ''
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      buffered += chunk.toString()
      const newline = buffered.indexOf('\n')
      if (newline >= 0) {
        const request = JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>
        buffered = buffered.slice(newline + 1)
        requests.push(request)
        const response = onRequest(request)
        if (response) queueMicrotask(() => stdout.write(`${JSON.stringify(response)}\n`))
      }
      callback()
    }
  })
  const child = Object.assign(events, {
    stdin,
    stdout,
    stderr,
    pid: 12345,
    exitCode: null,
    signalCode: null,
    killed: false,
    kill: () => true
  }) as unknown as ChildProcessWithoutNullStreams
  const ProcessForTest = PiRpcProcess as unknown as new (
    child: ChildProcessWithoutNullStreams,
    options: { cwd: string; agentDir: string; env: Readonly<NodeJS.ProcessEnv> }
  ) => PiRpcProcess
  const proc = new ProcessForTest(child, { cwd: '/tmp', agentDir: '/tmp/.pi', env: {} })
  ;(proc as unknown as { startupComplete: boolean }).startupComplete = true
  return {
    proc,
    requests,
    writeStdoutRecord: record => stdout.write(`${JSON.stringify(record)}\n`),
    terminate: (code = 1) => {
      ;(child as unknown as { exitCode: number | null }).exitCode = code
      events.emit('exit', code, null)
    }
  }
}

function validWireSuccess(requestId: string, name = 'fixture-state'): Record<string, unknown> {
  return {
    id: requestId,
    type: 'response',
    command: 'execute_command',
    success: true,
    data: {
      requestId,
      name,
      source: 'extension',
      sourceInfo: {},
      disposition: 'handled'
    }
  }
}

function validWireFailure(requestId: string, name = 'fixture-state'): Record<string, unknown> {
  return {
    id: requestId,
    type: 'response',
    command: 'execute_command',
    success: false,
    error: 'handler failed',
    data: {
      requestId,
      name,
      disposition: 'rejected',
      code: 'COMMAND_HANDLER_FAILED'
    }
  }
}

test('PiRpcProcess.executeCommand writes exact request identity/name/args and validates its response', async () => {
  const { proc, requests } = createWireProcess(request => ({
    id: request.id,
    type: 'response',
    command: 'execute_command',
    success: true,
    data: {
      requestId: request.id,
      name: request.name,
      source: 'extension',
      sourceInfo: {},
      disposition: 'handled'
    }
  }))

  const args = '  preserve\tall bytes\n'
  const result = await proc.executeCommand('request-wire-1', 'fixture-state', args)

  assert.equal(result.success, true)
  assert.deepEqual(requests, [
    {
      id: 'request-wire-1',
      type: 'execute_command',
      name: 'fixture-state',
      args
    }
  ])
})

test('PiRpcProcess invokes the accepted-response hook synchronously once for full valid success and failure', async () => {
  for (const success of [true, false]) {
    const { proc, writeStdoutRecord } = createWireProcess(() => undefined)
    const order: string[] = []
    const requestId = success ? 'accepted-success' : 'accepted-failure'
    const resultPromise = proc
      .executeCommand(requestId, 'fixture-state', '', () => {
        order.push('accepted')
      })
      .then(result => {
        order.push('resolved')
        return result
      })
    await new Promise(resolve => setImmediate(resolve))

    writeStdoutRecord(
      success
        ? {
            id: requestId,
            type: 'response',
            command: 'execute_command',
            success: true,
            data: {
              requestId,
              name: 'fixture-state',
              source: 'extension',
              sourceInfo: {},
              disposition: 'handled'
            }
          }
        : {
            id: requestId,
            type: 'response',
            command: 'execute_command',
            success: false,
            error: 'handler failed',
            data: {
              requestId,
              name: 'fixture-state',
              disposition: 'rejected',
              code: 'COMMAND_HANDLER_FAILED'
            }
          }
    )

    assert.deepEqual(order, ['accepted'])
    assert.equal((await resultPromise).success, success)
    assert.deepEqual(order, ['accepted', 'resolved'])
  }
})

test('PiRpcProcess converts an accepted-response hook throw into one owning rejection without stdout escape or hang', async () => {
  const { proc, writeStdoutRecord } = createWireProcess(() => undefined)
  const hookFailure = new Error('accepted-response hook failed')
  let hookCount = 0
  const resultPromise = proc.executeCommand('hook-throws', 'fixture-state', '', () => {
    hookCount += 1
    throw hookFailure
  })
  await new Promise(resolve => setImmediate(resolve))

  assert.doesNotThrow(() => writeStdoutRecord(validWireSuccess('hook-throws')))
  await assert.rejects(resultPromise, error => error === hookFailure)
  assert.equal(hookCount, 1)

  // The accepted raw identity was retired before the hook ran. A duplicate is
  // quarantined and cannot invoke the hook or settle the request again.
  assert.doesNotThrow(() => writeStdoutRecord(validWireSuccess('hook-throws')))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(hookCount, 1)
})

test('PiRpcProcess never invokes the accepted-response hook for invalid, unknown, or duplicate frames', async () => {
  const { proc, writeStdoutRecord } = createWireProcess(() => undefined)
  let hookCount = 0
  const resultPromise = proc.executeCommand('hook-live', 'fixture-state', '', () => {
    hookCount += 1
  })
  await new Promise(resolve => setImmediate(resolve))

  writeStdoutRecord({
    id: 'hook-unknown',
    type: 'response',
    command: 'execute_command',
    success: true,
    data: {
      requestId: 'hook-unknown',
      name: 'fixture-state',
      source: 'extension',
      sourceInfo: {},
      disposition: 'handled'
    }
  })
  writeStdoutRecord(successResponse({ id: 'hook-live', command: 'prompt' }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(hookCount, 0)

  const accepted = {
    id: 'hook-live',
    type: 'response',
    command: 'execute_command',
    success: true,
    data: {
      requestId: 'hook-live',
      name: 'fixture-state',
      source: 'extension',
      sourceInfo: {},
      disposition: 'handled'
    }
  }
  writeStdoutRecord(accepted)
  await resultPromise
  assert.equal(hookCount, 1)

  writeStdoutRecord(accepted)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(hookCount, 1)
})

test('PiRpcProcess terminal-first ordering rejects execute without invoking a later valid response hook', async () => {
  const { proc, writeStdoutRecord, terminate } = createWireProcess(() => undefined)
  let hookCount = 0
  const resultPromise = proc.executeCommand('terminal-first', 'fixture-state', '', () => {
    hookCount += 1
  })
  await new Promise(resolve => setImmediate(resolve))

  terminate(23)
  writeStdoutRecord({
    id: 'terminal-first',
    type: 'response',
    command: 'execute_command',
    success: true,
    data: {
      requestId: 'terminal-first',
      name: 'fixture-state',
      source: 'extension',
      sourceInfo: {},
      disposition: 'handled'
    }
  })

  await assert.rejects(resultPromise, error => error instanceof Error && error.name === 'PiRpcProcessTerminatedError')
  assert.equal(hookCount, 0)
})

test('PiRpcProcess malformed same-ID response loses to exit without invoking the accepted hook', async () => {
  const { proc, writeStdoutRecord, terminate } = createWireProcess(() => undefined)
  let hookCount = 0
  const resultPromise = proc.executeCommand('malformed-then-exit', 'fixture-state', '', () => {
    hookCount += 1
  })
  await new Promise(resolve => setImmediate(resolve))

  writeStdoutRecord({ ...validWireSuccess('malformed-then-exit'), command: 'prompt' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(hookCount, 0)

  terminate(24)
  await assert.rejects(resultPromise, error => error instanceof Error && error.name === 'PiRpcProcessTerminatedError')
  assert.equal(hookCount, 0)
})

test('PiRpcProcess suppresses the accepted hook for every invalid execute response validator branch', async t => {
  const requestId = 'invalid-hook'
  const success = validWireSuccess(requestId)
  const successData = success.data as Record<string, unknown>
  const failure = validWireFailure(requestId)
  const failureData = failure.data as Record<string, unknown>
  const invalid: Array<[string, unknown]> = [
    ['non-record', null],
    ['type', { ...success, type: 'event' }],
    ['id type', { ...success, id: 7 }],
    ['command', { ...success, command: 'prompt' }],
    ['success type', { ...success, success: 'true' }],
    ['data record', { ...success, data: [] }],
    ['request identity', { ...success, data: { ...successData, requestId: 'other' } }],
    ['command identity', { ...success, data: { ...successData, name: 'Fixture-State' } }],
    ['success exact keys', { ...success, data: { ...successData, extra: true } }],
    ['success error', { ...success, error: 'must be absent' }],
    ['success source', { ...success, data: { ...successData, source: 'prompt' } }],
    ['success disposition', { ...success, data: { ...successData, disposition: 'queued' } }],
    ['success sourceInfo record', { ...success, data: { ...successData, sourceInfo: [] } }],
    ['success sourceInfo empty', { ...success, data: { ...successData, sourceInfo: { path: '/private/x' } } }],
    ['failure exact keys', { ...failure, data: { ...failureData, extra: true } }],
    ['failure error type', { ...failure, error: 7 }],
    ['failure error nonempty', { ...failure, error: '   ' }],
    ['failure disposition', { ...failure, data: { ...failureData, disposition: 'handled' } }],
    ['failure code type', { ...failure, data: { ...failureData, code: 7 } }],
    ['failure code membership', { ...failure, data: { ...failureData, code: 'UNKNOWN_CODE' } }]
  ]

  for (const [label, frame] of invalid) {
    await t.test(label, async () => {
      const { proc, writeStdoutRecord, terminate } = createWireProcess(() => undefined)
      let hookCount = 0
      const resultPromise = proc.executeCommand(requestId, 'fixture-state', '', () => {
        hookCount += 1
      })
      await new Promise(resolve => setImmediate(resolve))

      writeStdoutRecord(frame)
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(hookCount, 0)

      terminate(25)
      await assert.rejects(
        resultPromise,
        error => error instanceof Error && error.name === 'PiRpcProcessTerminatedError'
      )
      assert.equal(hookCount, 0)
    })
  }
})

test('PiAcpSession response claim beats a same-tick child terminal after validated pending retirement', async () => {
  const { proc, writeStdoutRecord, terminate } = createWireProcess(() => undefined)
  const session = new PiAcpSession({
    sessionId: 'accepted-response-session',
    cwd: '/tmp',
    mcpServers: [],
    proc,
    conn: asAgentConn(new FakeAgentSideConnection())
  })
  const reservation = session.reserveCommand('fixture-state')
  const outcomePromise = session.executeReservedCommand(reservation, '')
  await new Promise(resolve => setImmediate(resolve))

  writeStdoutRecord({
    id: reservation.requestId,
    type: 'response',
    command: 'execute_command',
    success: true,
    data: {
      requestId: reservation.requestId,
      name: 'fixture-state',
      source: 'extension',
      sourceInfo: {},
      disposition: 'handled'
    }
  })
  terminate(17)

  const outcome = await outcomePromise
  assert.equal(outcome.kind, 'response')
  if (outcome.kind === 'response') assert.equal(outcome.response.success, true)
  session.releaseCommand(reservation)
})

test('PiAcpSession response then cancel preserves the validated response without stopping the child', async () => {
  const { proc, writeStdoutRecord } = createWireProcess(() => undefined)
  let stopCount = 0
  proc.stop = async () => {
    stopCount += 1
  }
  const session = new PiAcpSession({
    sessionId: 'response-then-cancel-session',
    cwd: '/tmp',
    mcpServers: [],
    proc,
    conn: asAgentConn(new FakeAgentSideConnection())
  })
  const reservation = session.reserveCommand('fixture-state')
  const outcomePromise = session.executeReservedCommand(reservation, '')
  await new Promise(resolve => setImmediate(resolve))

  writeStdoutRecord(validWireSuccess(reservation.requestId))
  await session.cancel()
  const outcome = await outcomePromise
  assert.equal(outcome.kind, 'response')
  assert.equal(stopCount, 0)
  session.releaseCommand(reservation)
})

test('PiAcpSession cancel then response preserves cancellation and ignores the later accepted hook claim', async () => {
  const { proc, writeStdoutRecord } = createWireProcess(() => undefined)
  let stopCount = 0
  proc.stop = async () => {
    stopCount += 1
  }
  const session = new PiAcpSession({
    sessionId: 'cancel-then-response-session',
    cwd: '/tmp',
    mcpServers: [],
    proc,
    conn: asAgentConn(new FakeAgentSideConnection())
  })
  const reservation = session.reserveCommand('fixture-state')
  const outcomePromise = session.executeReservedCommand(reservation, '')
  await new Promise(resolve => setImmediate(resolve))

  await session.cancel()
  writeStdoutRecord(validWireSuccess(reservation.requestId))
  const outcome = await outcomePromise
  assert.equal(outcome.kind, 'cancelled')
  assert.equal(stopCount, 1)
  session.releaseCommand(reservation)
})

test('PiAcpSession validated failure then terminal preserves the exact failure response', async () => {
  const { proc, writeStdoutRecord, terminate } = createWireProcess(() => undefined)
  const session = new PiAcpSession({
    sessionId: 'failure-then-terminal-session',
    cwd: '/tmp',
    mcpServers: [],
    proc,
    conn: asAgentConn(new FakeAgentSideConnection())
  })
  const reservation = session.reserveCommand('fixture-state')
  const outcomePromise = session.executeReservedCommand(reservation, '')
  await new Promise(resolve => setImmediate(resolve))

  writeStdoutRecord(validWireFailure(reservation.requestId))
  terminate(26)
  const outcome = await outcomePromise
  assert.equal(outcome.kind, 'response')
  if (outcome.kind === 'response') assert.equal(outcome.response.success, false)
  session.releaseCommand(reservation)
})

test('PiRpcProcess quarantines malformed same-ID frames until exact agent_run settlement and later duplicates', async () => {
  const { proc, requests, writeStdoutRecord } = createWireProcess(() => undefined)
  const events: unknown[] = []
  proc.onEvent(event => events.push(event))

  const validResponse = {
    id: 'live-request',
    type: 'response',
    command: 'execute_command',
    success: true,
    data: {
      requestId: 'live-request',
      name: 'fixture-agent',
      source: 'extension',
      sourceInfo: {},
      disposition: 'agent_run'
    }
  }
  let settlementCount = 0
  const resultPromise = proc.executeCommand('live-request', 'fixture-agent', '').then(result => {
    settlementCount += 1
    return result
  })
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(requests, [
    {
      id: 'live-request',
      type: 'execute_command',
      name: 'fixture-agent',
      args: ''
    }
  ])

  writeStdoutRecord({ ...validResponse, command: 'prompt' })
  writeStdoutRecord({
    ...validResponse,
    data: {
      requestId: 'other-request',
      name: 'fixture-agent',
      source: 'extension',
      sourceInfo: {},
      disposition: 'agent_run'
    }
  })
  writeStdoutRecord({
    ...validResponse,
    data: {
      requestId: 'live-request',
      name: 'fixture-agent',
      source: 'extension',
      sourceInfo: {},
      disposition: 'queued'
    }
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settlementCount, 0)

  writeStdoutRecord(validResponse)
  assert.deepEqual(await resultPromise, {
    success: true,
    data: {
      requestId: 'live-request',
      name: 'fixture-agent',
      source: 'extension',
      sourceInfo: {},
      disposition: 'agent_run'
    }
  })
  assert.equal(settlementCount, 1)

  writeStdoutRecord(validResponse)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settlementCount, 1)
  assert.deepEqual(events, [])
})

test('PiRpcProcess quarantines late, unknown, and malformed responses from ACP event delivery', async () => {
  const { proc, writeStdoutRecord } = createWireProcess(request => ({
    id: request.id,
    type: 'response',
    command: 'execute_command',
    success: true,
    data: {
      requestId: request.id,
      name: request.name,
      source: 'extension',
      sourceInfo: {},
      disposition: 'handled'
    }
  }))
  const conn = new FakeAgentSideConnection()
  const events: unknown[] = []
  proc.onEvent(event => events.push(event))
  new PiAcpSession({
    sessionId: 'response-quarantine-session',
    cwd: '/tmp',
    mcpServers: [],
    proc,
    conn: asAgentConn(conn)
  })

  await proc.executeCommand('completed-request', 'fixture-state', '')
  writeStdoutRecord(successResponse({ id: 'completed-request' }))
  writeStdoutRecord(successResponse({ id: 'unknown-request' }))
  writeStdoutRecord(successResponse({ id: 7 }))
  writeStdoutRecord({ type: 'response', eventLikePayload: 'must-not-reach-session' })
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(events, [])
  assert.deepEqual(conn.updates, [])
})
