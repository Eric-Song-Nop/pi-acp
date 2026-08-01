import assert from 'node:assert/strict'
import test from 'node:test'
import {
  C1_2_RUNTIME_EXTENSION_RESPONSE_TEXT,
  MAX_LOOPBACK_BODY_BYTES,
  startRealPiFixture
} from '../helpers/real-pi-fixture.js'

const TEST_TIMEOUT_MS = 40_000
const PROMPT_TIMEOUT_MS = 10_000
const USER_TEXT = 'Return the deterministic C1.2 response.'
const RUNTIME_ERROR = 'C1.2_SAFE_EXTENSION_RUNTIME_ERROR'
const RUNTIME_SOURCE = 'global:extensions/pi-acp-runtime-error/index.ts'
const RUNTIME_EVENT = 'before_agent_start'
const RUNTIME_SUMMARY = `Pi extension error (source: ${RUNTIME_SOURCE}; event: ${RUNTIME_EVENT}):\n${RUNTIME_ERROR}`

type Transcript = ReturnType<Awaited<ReturnType<typeof startRealPiFixture>>['client']['transcript']>

function record(value: unknown): Record<string, any> {
  return typeof value === 'object' && value !== null ? (value as Record<string, any>) : {}
}

function runtimeDiagnosticUpdates(transcript: Transcript) {
  return transcript.flatMap((entry, index) => {
    if (entry.kind !== 'message' || entry.direction !== 'agent_to_client') return []
    const message = record(entry.message)
    if (message.method !== 'session/update') return []
    const update = record(record(message.params).update)
    const piAcp = record(record(update._meta).piAcp)
    const diagnostic = piAcp.diagnostic
    if (record(diagnostic).code !== 'PI_EXTENSION_RUNTIME_ERROR') return []
    return [{ index, update, diagnostic: record(diagnostic) }]
  })
}

function promptResponseIndex(transcript: Transcript, promptText: string): number {
  const requestIndex = transcript.findIndex(entry => {
    if (entry.kind !== 'message' || entry.direction !== 'client_to_agent') return false
    const message = record(entry.message)
    if (message.method !== 'session/prompt') return false
    const prompt = record(message.params).prompt
    return (
      Array.isArray(prompt) && prompt.some(block => record(block).type === 'text' && record(block).text === promptText)
    )
  })
  assert.notEqual(requestIndex, -1)
  const request = transcript[requestIndex]
  if (!request || request.kind !== 'message') throw new Error('C1.2 prompt request was not recorded as a message')
  const requestId = record(request.message).id

  const responseIndex = transcript.findIndex((entry, index) => {
    if (index <= requestIndex || entry.kind !== 'message' || entry.direction !== 'agent_to_client') return false
    const message = record(entry.message)
    return message.id === requestId && Object.hasOwn(message, 'result')
  })
  assert.notEqual(responseIndex, -1)
  return responseIndex
}

function visibleTextChunks(transcript: Transcript): string[] {
  return transcript.flatMap(entry => {
    if (entry.kind !== 'message' || entry.direction !== 'agent_to_client') return []
    const message = record(entry.message)
    if (message.method !== 'session/update') return []
    const update = record(record(message.params).update)
    const content = record(update.content)
    return update.sessionUpdate === 'agent_message_chunk' && content.type === 'text' && typeof content.text === 'string'
      ? [content.text]
      : []
  })
}

test(
  'C1.2 real Pi runtime extension error is visible, bounded, ordered, and non-terminal',
  { timeout: TEST_TIMEOUT_MS },
  async t => {
    const fixture = await startRealPiFixture({
      runtimeExtensionError: true,
      hardDeadlineMs: 30_000,
      transcriptCheckpoint: 'C1.2',
      transcriptCaseId: 'C1.2-runtime-extension-error'
    })
    t.after(async () => {
      await fixture.cleanup()
    })

    assert.equal(fixture.packageVersion, '0.83.0')
    assert.equal(typeof fixture.expectedRuntimeErrorExtensionRealpath, 'string')
    assert.equal(typeof fixture.expectedRuntimeErrorExtensionSha256, 'string')

    await fixture.client.initialize()
    const session = await fixture.client.newSession({
      cwd: fixture.cwd,
      mcpServers: []
    })
    assert.ok(session.sessionId.length > 0)

    const response = await fixture.client.prompt(
      {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: USER_TEXT }]
      },
      { timeoutMs: PROMPT_TIMEOUT_MS }
    )
    await fixture.assertWithinHardDeadline()
    assert.equal(response.stopReason, 'end_turn')

    const transcript = fixture.client.transcript()
    const diagnostics = runtimeDiagnosticUpdates(transcript)
    assert.equal(diagnostics.length, 1)
    const { index: diagnosticIndex, update, diagnostic } = diagnostics[0]!
    assert.deepEqual(update, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: RUNTIME_SUMMARY },
      _meta: {
        piAcp: {
          notify: { level: 'error' },
          diagnostic: {
            schemaVersion: 1,
            code: 'PI_EXTENSION_RUNTIME_ERROR',
            phase: 'runtime',
            source: RUNTIME_SOURCE,
            event: RUNTIME_EVENT,
            summary: RUNTIME_SUMMARY,
            truncated: false,
            redacted: true,
            summaryLimitBytes: 4_096
          }
        }
      }
    })
    assert.equal(update.content.text, diagnostic.summary)
    assert.ok(Buffer.byteLength(diagnostic.summary, 'utf8') <= diagnostic.summaryLimitBytes)
    assert.ok(diagnostic.summary.includes(RUNTIME_SOURCE))
    assert.ok(diagnostic.summary.includes(RUNTIME_EVENT))
    assert.ok(diagnostic.summary.includes(RUNTIME_ERROR))
    const serializedDiagnostic = JSON.stringify(update)
    assert.equal(serializedDiagnostic.includes(fixture.rootDir), false)
    assert.equal(serializedDiagnostic.includes(fixture.expectedRuntimeErrorExtensionRealpath!), false)
    assert.equal(serializedDiagnostic.includes('extensionPath'), false)
    assert.equal(serializedDiagnostic.includes('"stack"'), false)

    assert.ok(diagnosticIndex < promptResponseIndex(transcript, USER_TEXT))
    assert.ok(visibleTextChunks(transcript).includes(C1_2_RUNTIME_EXTENSION_RESPONSE_TEXT))

    assert.equal(fixture.requests.length, 1)
    const request = fixture.requests[0]!
    assert.equal(request.method, 'POST')
    assert.equal(request.url, '/v1/chat/completions')
    assert.equal(request.host, `${fixture.loopbackAddress.host}:${String(fixture.loopbackAddress.port)}`)
    assert.equal(request.outcome, 'end')
    assert.equal(request.bodyExceededLimit, false)
    assert.ok(request.body && request.body.length > 0 && request.body.length <= MAX_LOOPBACK_BODY_BYTES)

    const providerBody = JSON.parse(request.body.toString('utf8')) as {
      model?: unknown
      stream?: unknown
      messages?: readonly { role?: unknown; content?: unknown }[]
    }
    assert.equal(providerBody.model, 'fixture-model-v1')
    assert.equal(providerBody.stream, true)
    assert.equal(
      providerBody.messages?.some(
        message => message.role === 'user' && JSON.stringify(message.content).includes(USER_TEXT)
      ),
      true
    )

    const responsive = await fixture.client.prompt(
      {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: '/session' }]
      },
      { timeoutMs: PROMPT_TIMEOUT_MS }
    )
    assert.equal(responsive.stopReason, 'end_turn')
    assert.equal(fixture.requests.length, 1)
    assert.equal(runtimeDiagnosticUpdates(fixture.client.transcript()).length, 1)

    const exit = await fixture.client.close()
    assert.deepEqual({ code: exit.code, signal: exit.signal }, { code: 0, signal: null })
    await fixture.closeLoopback()
    const shutdown = await fixture.readShutdownReceipt()
    assert.equal(shutdown.receipt.phase, 'session_shutdown')
    assert.equal(shutdown.receipt.reason, 'quit')
  }
)
