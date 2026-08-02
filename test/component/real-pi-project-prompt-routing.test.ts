import assert from 'node:assert/strict'
import test from 'node:test'
import {
  C1_4_LF_JSONL_LIVENESS_USER_TEXT,
  C1_4_LF_JSONL_USER_TEXT,
  MAX_LOOPBACK_BODY_BYTES,
  startRealPiFixture
} from '../helpers/real-pi-fixture.js'

const TEST_TIMEOUT_MS = 40_000
const PROMPT_TIMEOUT_MS = 10_000
const COMMAND_NAME = 'c2-router'
const COMMAND_TEXT = `/${COMMAND_NAME} alpha beta gamma`
const PROJECT_TEMPLATE = [C1_4_LF_JSONL_USER_TEXT, 'C2.2 first: ${1:-missing}', 'C2.2 tail: ${@:2}'].join('\n')
const EXPANDED_TEXT = [C1_4_LF_JSONL_USER_TEXT, 'C2.2 first: alpha', 'C2.2 tail: beta gamma'].join('\n')

test('C2.2 real Pi expands a project prompt after exact adapter forwarding', { timeout: TEST_TIMEOUT_MS }, async t => {
  const fixture = await startRealPiFixture({
    projectPrompts: [{ name: COMMAND_NAME, contents: PROJECT_TEMPLATE }],
    lfJsonlResponse: true,
    hardDeadlineMs: 30_000,
    transcriptCheckpoint: 'C2.2',
    transcriptCaseId: 'C2.2-project-prompt-pi-router'
  })
  t.after(fixture.cleanup)

  await fixture.client.initialize()
  const session = await fixture.client.newSession({ cwd: fixture.cwd, mcpServers: [] })
  const response = await fixture.client.prompt(
    {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: COMMAND_TEXT }]
    },
    { timeoutMs: PROMPT_TIMEOUT_MS }
  )
  await fixture.assertWithinHardDeadline()

  assert.equal(response.stopReason, 'end_turn')
  assert.equal(fixture.requests.length, 1)
  const providerRequest = fixture.requests[0]!
  assert.equal(providerRequest.method, 'POST')
  assert.equal(providerRequest.url, '/v1/chat/completions')
  assert.equal(providerRequest.outcome, 'end')
  assert.equal(providerRequest.bodyExceededLimit, false)
  assert.ok(
    providerRequest.body && providerRequest.body.length > 0 && providerRequest.body.length <= MAX_LOOPBACK_BODY_BYTES
  )

  const body = JSON.parse(providerRequest.body.toString('utf8')) as {
    messages?: readonly { role?: unknown; content?: unknown }[]
  }
  const userMessages = (body.messages ?? []).filter(message => message.role === 'user')
  assert.deepEqual(userMessages, [
    {
      role: 'user',
      content: [{ type: 'text', text: EXPANDED_TEXT }]
    }
  ])
  assert.equal(providerRequest.body.includes(Buffer.from(COMMAND_TEXT)), false)
  assert.equal(providerRequest.body.includes(Buffer.from('${1:-missing}')), false)
  assert.equal(providerRequest.body.includes(Buffer.from('${@:2}')), false)

  const liveness = await fixture.client.prompt(
    {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: C1_4_LF_JSONL_LIVENESS_USER_TEXT }]
    },
    { timeoutMs: PROMPT_TIMEOUT_MS }
  )
  await fixture.assertWithinHardDeadline()
  assert.equal(liveness.stopReason, 'end_turn')
  assert.equal(fixture.requests.length, 2)
  assert.equal(fixture.requests[1]!.outcome, 'end')
  assert.equal(fixture.client.isRunning, true)

  const exit = await fixture.client.close()
  assert.deepEqual({ code: exit.code, signal: exit.signal }, { code: 0, signal: null })
})
