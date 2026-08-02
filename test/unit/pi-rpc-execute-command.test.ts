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

test('validatePiRpcExecuteCommandResponse accepts exact handled and rejected identities', () => {
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
          disposition: 'agent_run'
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
    writeStdoutRecord: record => stdout.write(`${JSON.stringify(record)}\n`)
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

test('PiRpcProcess keeps a live execute_command request pending until an exact response is accepted', async () => {
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
      name: 'fixture-state',
      source: 'extension',
      sourceInfo: {},
      disposition: 'handled'
    }
  }
  let settlementCount = 0
  const resultPromise = proc.executeCommand('live-request', 'fixture-state', '').then(result => {
    settlementCount += 1
    return result
  })
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(requests, [
    {
      id: 'live-request',
      type: 'execute_command',
      name: 'fixture-state',
      args: ''
    }
  ])

  writeStdoutRecord({ ...validResponse, command: 'prompt' })
  writeStdoutRecord({
    ...validResponse,
    data: {
      requestId: 'other-request',
      name: 'fixture-state',
      source: 'extension',
      disposition: 'handled'
    }
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(settlementCount, 0)

  writeStdoutRecord(validResponse)
  assert.deepEqual(await resultPromise, {
    success: true,
    data: {
      requestId: 'live-request',
      name: 'fixture-state',
      source: 'extension',
      sourceInfo: {},
      disposition: 'handled'
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
