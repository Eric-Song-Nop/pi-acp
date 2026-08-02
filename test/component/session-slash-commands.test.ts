import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

test('PiAcpSession: forwards slash text and images to Pi unchanged exactly once', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const images = [{ type: 'image', mimeType: 'image/png', data: 'c2.2-image' }]

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [
      {
        name: 'hello',
        description: '(user)',
        content: 'ADAPTER_MUST_NOT_EXPAND_$1',
        source: '(user)'
      }
    ]
  })

  const p = session.prompt('/hello world', images)

  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  const reason = await p

  assert.equal(reason, 'end_turn')
  assert.equal(proc.prompts.length, 1)
  assert.deepEqual(proc.prompts[0], {
    message: '/hello world',
    attachments: images
  })
})
