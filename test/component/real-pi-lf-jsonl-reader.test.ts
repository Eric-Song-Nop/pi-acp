import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { PROJECT_TRUST_WARNING } from '../../src/acp/agent.js'
import {
  C1_4_LF_JSONL_LIVENESS_RESPONSE_TEXT,
  C1_4_LF_JSONL_LIVENESS_USER_TEXT,
  C1_4_LF_JSONL_RESPONSE_TEXT,
  C1_4_LF_JSONL_USER_TEXT,
  MAX_LOOPBACK_BODY_BYTES,
  startRealPiFixture
} from '../helpers/real-pi-fixture.js'

const TEST_TIMEOUT_MS = 40_000
const PROMPT_TIMEOUT_MS = 10_000
const RAW_PI_TIMEOUT_MS = 10_000
const RAW_PI_EXIT_TIMEOUT_MS = 5_000

type Fixture = Awaited<ReturnType<typeof startRealPiFixture>>
type Transcript = ReturnType<Fixture['client']['transcript']>
type RawPiRecord = { message: Record<string, any>; bytes: Buffer }

function record(value: unknown): Record<string, any> {
  return typeof value === 'object' && value !== null ? (value as Record<string, any>) : {}
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    timer.unref()
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
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

function promptResponses(transcript: Transcript, promptText: string): Record<string, any>[] {
  const requests = transcript.filter(entry => {
    if (entry.kind !== 'message' || entry.direction !== 'client_to_agent') return false
    const message = record(entry.message)
    const prompt = record(message.params).prompt
    return (
      message.method === 'session/prompt' &&
      Array.isArray(prompt) &&
      prompt.some(block => record(block).type === 'text' && record(block).text === promptText)
    )
  })
  assert.equal(requests.length, 1)
  const request = requests[0]!
  if (request.kind !== 'message') throw new Error('C1.4 prompt request was not retained as a message')
  const requestId = record(request.message).id
  return transcript.flatMap(entry => {
    if (entry.kind !== 'message' || entry.direction !== 'agent_to_client') return []
    const message = record(entry.message)
    return message.id === requestId && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))
      ? [message]
      : []
  })
}

async function runRawPiByteProbe(fixture: Fixture): Promise<RawPiRecord[]> {
  const child = spawn(
    process.execPath,
    [
      fixture.expectedCliRealpath,
      '--mode',
      'rpc',
      '--no-themes',
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
      '--no-session'
    ],
    {
      cwd: fixture.cwd,
      env: fixture.createRawPiProbeEnvironment(),
      stdio: 'pipe',
      shell: false
    }
  )
  child.stdin.on('error', () => undefined)

  const stderrChunks: Buffer[] = []
  const records: RawPiRecord[] = []
  let pending = Buffer.alloc(0)
  let resolveAgentSettled!: () => void
  const agentSettled = new Promise<void>(resolve => {
    resolveAgentSettled = resolve
  })

  child.stdout.on('data', chunk => {
    const bytes = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk))
    pending = Buffer.concat([pending, bytes])
    let lfIndex: number
    while ((lfIndex = pending.indexOf(0x0a)) !== -1) {
      const line = pending.subarray(0, lfIndex)
      pending = pending.subarray(lfIndex + 1)
      if (line.length === 0) continue
      try {
        const message = JSON.parse(line.toString('utf8')) as unknown
        if (typeof message !== 'object' || message === null) continue
        const parsed = record(message)
        records.push({ message: parsed, bytes: Buffer.from(line) })
        if (parsed.type === 'agent_settled') resolveAgentSettled()
      } catch {
        // Pi may print non-JSON prelude lines before its RPC stream begins.
      }
    }
  })
  child.stderr.on('data', chunk => {
    stderrChunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk)))
  })

  const spawned = new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('close', (code, signal) => resolve({ code, signal }))
  })

  try {
    await withDeadline(spawned, RAW_PI_TIMEOUT_MS, 'C1.4 raw Pi probe did not spawn')
    await withDeadline(
      new Promise<void>((resolve, reject) => {
        child.stdin.write(
          `${JSON.stringify({ id: 'c1.4-raw-byte-probe', type: 'prompt', message: C1_4_LF_JSONL_USER_TEXT })}\n`,
          error => (error ? reject(error) : resolve())
        )
      }),
      RAW_PI_TIMEOUT_MS,
      'C1.4 raw Pi probe prompt write timed out'
    )
    await withDeadline(
      Promise.race([
        agentSettled,
        closed.then(exit => {
          throw new Error(`C1.4 raw Pi exited before agent_settled: ${JSON.stringify(exit)}`)
        })
      ]),
      RAW_PI_TIMEOUT_MS,
      'C1.4 raw Pi probe did not settle'
    )
    child.stdin.end()
    const exit = await withDeadline(closed, RAW_PI_EXIT_TIMEOUT_MS, 'C1.4 raw Pi probe did not exit cleanly')
    assert.deepEqual(
      { code: exit.code, signal: exit.signal },
      { code: 0, signal: null },
      Buffer.concat(stderrChunks).toString('utf8')
    )
    return records
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end()
      child.kill('SIGTERM')
      try {
        await withDeadline(closed, RAW_PI_EXIT_TIMEOUT_MS, 'C1.4 raw Pi TERM cleanup timed out')
      } catch {
        child.kill('SIGKILL')
        await withDeadline(closed, RAW_PI_EXIT_TIMEOUT_MS, 'C1.4 raw Pi KILL cleanup timed out')
      }
    }
  }
}

test(
  'C1.4 real Pi preserves U+2028/U+2029 through LF framing and remains live for a second turn',
  { timeout: TEST_TIMEOUT_MS },
  async t => {
    const fixture = await startRealPiFixture({
      lfJsonlResponse: true,
      hardDeadlineMs: 30_000,
      transcriptCheckpoint: 'C1.4',
      transcriptCaseId: 'C1.4-lf-jsonl-unicode-separators'
    })
    t.after(fixture.cleanup)

    await fixture.client.initialize()
    const session = await fixture.client.newSession({ cwd: fixture.cwd, mcpServers: [] })
    const first = await fixture.client.prompt(
      {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: C1_4_LF_JSONL_USER_TEXT }]
      },
      { timeoutMs: PROMPT_TIMEOUT_MS }
    )
    await fixture.assertWithinHardDeadline()

    assert.equal(first.stopReason, 'end_turn')
    assert.deepEqual(visibleTextChunks(fixture.client.transcript()), [
      `${PROJECT_TRUST_WARNING}\n`,
      C1_4_LF_JSONL_RESPONSE_TEXT
    ])
    assert.deepEqual(
      Array.from(C1_4_LF_JSONL_RESPONSE_TEXT)
        .map(character => character.codePointAt(0))
        .filter(codePoint => codePoint === 0x2028 || codePoint === 0x2029),
      [0x2028, 0x2029]
    )
    const firstResponses = promptResponses(fixture.client.transcript(), C1_4_LF_JSONL_USER_TEXT)
    assert.equal(firstResponses.length, 1)
    assert.equal(record(firstResponses[0]!.result).stopReason, 'end_turn')

    const second = await fixture.client.prompt(
      {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: C1_4_LF_JSONL_LIVENESS_USER_TEXT }]
      },
      { timeoutMs: PROMPT_TIMEOUT_MS }
    )
    await fixture.assertWithinHardDeadline()

    assert.equal(second.stopReason, 'end_turn')
    assert.deepEqual(visibleTextChunks(fixture.client.transcript()), [
      `${PROJECT_TRUST_WARNING}\n`,
      C1_4_LF_JSONL_RESPONSE_TEXT,
      C1_4_LF_JSONL_LIVENESS_RESPONSE_TEXT
    ])
    const secondResponses = promptResponses(fixture.client.transcript(), C1_4_LF_JSONL_LIVENESS_USER_TEXT)
    assert.equal(secondResponses.length, 1)
    assert.equal(record(secondResponses[0]!.result).stopReason, 'end_turn')
    assert.equal(fixture.client.isRunning, true)

    assert.equal(fixture.requests.length, 2)
    for (const providerRequest of fixture.requests) {
      assert.equal(providerRequest.method, 'POST')
      assert.equal(providerRequest.url, '/v1/chat/completions')
      assert.equal(providerRequest.host, `${fixture.loopbackAddress.host}:${String(fixture.loopbackAddress.port)}`)
      assert.equal(providerRequest.outcome, 'end')
      assert.equal(providerRequest.bodyExceededLimit, false)
      assert.ok(
        providerRequest.body &&
          providerRequest.body.length > 0 &&
          providerRequest.body.length <= MAX_LOOPBACK_BODY_BYTES
      )
    }

    const adapterExit = await fixture.client.close()
    assert.deepEqual({ code: adapterExit.code, signal: adapterExit.signal }, { code: 0, signal: null })

    const rawRecords = await runRawPiByteProbe(fixture)
    const rawDeltaRecords = rawRecords.filter(({ message }) => {
      const event = record(message.assistantMessageEvent)
      return event.type === 'text_delta' && typeof event.delta === 'string'
    })
    assert.equal(rawDeltaRecords.length, 1)
    const rawDeltaRecord = rawDeltaRecords[0]!
    assert.equal(record(rawDeltaRecord.message.assistantMessageEvent).delta, C1_4_LF_JSONL_RESPONSE_TEXT)
    assert.equal(rawDeltaRecord.bytes.includes(Buffer.from(C1_4_LF_JSONL_RESPONSE_TEXT, 'utf8')), true)
    assert.equal(rawDeltaRecord.bytes.includes(Buffer.from([0xe2, 0x80, 0xa8])), true)
    assert.equal(rawDeltaRecord.bytes.includes(Buffer.from([0xe2, 0x80, 0xa9])), true)
    assert.equal(rawDeltaRecord.bytes.includes(Buffer.from('\\u2028')), false)
    assert.equal(rawDeltaRecord.bytes.includes(Buffer.from('\\u2029')), false)
    assert.equal(fixture.requests.length, 3)
    assert.equal(fixture.requests[2]!.outcome, 'end')
    await fixture.assertWithinHardDeadline()

    await fixture.closeLoopback()
  }
)
