import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { Socket } from 'node:net'
import test from 'node:test'
import { MAX_LOOPBACK_BODY_BYTES, startRealPiFixture } from '../helpers/real-pi-fixture.js'

const TEST_TIMEOUT_MS = 40_000
const REQUEST_TIMEOUT_MS = 2_000
const CLOSE_TIMEOUT_MS = 1_000
const FIXED_USER_TEXT = 'Return the deterministic C0.3 response.'
const FIXED_RESPONSE_TEXT = 'C0.3 deterministic agent response'

type CapturedRequest = {
  method: string | undefined
  url: string | undefined
  host: string | undefined
  authorization: string | undefined
  body: Buffer
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

function createCloser(server: Server, sockets: Set<Socket>): () => Promise<void> {
  let closePromise: Promise<void> | undefined
  return async () => {
    closePromise ??= new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      }
      const timer = setTimeout(() => {
        for (const socket of sockets) socket.destroy()
        server.closeAllConnections()
        finish(new Error('C0.3 deterministic provider did not close within its bound'))
      }, CLOSE_TIMEOUT_MS)
      timer.unref()

      if (server.listening) server.close(error => finish(error ?? undefined))
      else finish()
      for (const socket of sockets) socket.destroy()
      server.closeIdleConnections()
      server.closeAllConnections()
    })
    await closePromise
  }
}

function sessionTextChunks(
  transcript: ReturnType<Awaited<ReturnType<typeof startRealPiFixture>>['client']['transcript']>
) {
  return transcript.flatMap(entry => {
    if (
      entry.kind !== 'message' ||
      entry.direction !== 'agent_to_client' ||
      !('method' in entry.message) ||
      entry.message.method !== 'session/update'
    ) {
      return []
    }
    const params = entry.message.params as {
      update?: {
        sessionUpdate?: unknown
        content?: {
          type?: unknown
          text?: unknown
        }
      }
    }
    if (
      params.update?.sessionUpdate !== 'agent_message_chunk' ||
      params.update.content?.type !== 'text' ||
      typeof params.update.content.text !== 'string'
    ) {
      return []
    }
    return [params.update.content.text]
  })
}

test(
  'C0.3 real Pi agent turn completes against one deterministic loopback response',
  { timeout: TEST_TIMEOUT_MS },
  async t => {
    const fixture = await startRealPiFixture({ hardDeadlineMs: 30_000 })
    await fixture.closeLoopback()

    const requests: CapturedRequest[] = []
    const sockets = new Set<Socket>()
    const provider = createServer((request, response) => {
      const chunks: Buffer[] = []
      let byteLength = 0
      let exceeded = false
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        if (exceeded) {
          response.statusCode = 413
          response.end()
          return
        }
        const body = Buffer.concat(chunks, byteLength)
        requests.push({
          method: request.method,
          url: request.url,
          host: request.headers.host,
          authorization: request.headers.authorization,
          body
        })
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'close'
        })
        const chunkBase = {
          id: 'fixture-turn-1',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'fixture-model-v1'
        }
        response.write(
          `data: ${JSON.stringify({
            ...chunkBase,
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  content: FIXED_RESPONSE_TEXT
                },
                finish_reason: null
              }
            ]
          })}\n\n`
        )
        response.write(
          `data: ${JSON.stringify({
            ...chunkBase,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: 'stop'
              }
            ],
            usage: {
              prompt_tokens: 1,
              completion_tokens: 4,
              total_tokens: 5
            }
          })}\n\n`
        )
        response.end('data: [DONE]\n\n')
      }

      request.setTimeout(REQUEST_TIMEOUT_MS, () => {
        settled = true
        response.statusCode = 408
        response.end()
        request.destroy()
      })
      request.on('data', chunk => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        byteLength += bytes.length
        if (byteLength <= MAX_LOOPBACK_BODY_BYTES) chunks.push(bytes)
        else exceeded = true
      })
      request.once('end', finish)
      request.once('aborted', () => {
        settled = true
      })
      request.once('error', () => {
        settled = true
      })
    })
    provider.on('connection', socket => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    await listen(provider, fixture.loopbackAddress.port)
    const closeProvider = createCloser(provider, sockets)

    t.after(async () => {
      await fixture.client.close().catch(() => undefined)
      await closeProvider()
      await fixture.cleanup()
    })

    await fixture.client.initialize()
    const session = await fixture.client.newSession({
      cwd: fixture.cwd,
      mcpServers: []
    })
    const response = await fixture.client.prompt(
      {
        sessionId: session.sessionId,
        prompt: [
          {
            type: 'text',
            text: FIXED_USER_TEXT
          }
        ]
      },
      { timeoutMs: 10_000 }
    )
    await fixture.assertWithinHardDeadline()

    assert.equal(response.stopReason, 'end_turn')
    assert.deepEqual(sessionTextChunks(fixture.client.transcript()), [FIXED_RESPONSE_TEXT])
    assert.equal(requests.length, 1)

    const observed = requests[0]
    assert.equal(observed.method, 'POST')
    assert.equal(observed.url, '/v1/chat/completions')
    assert.equal(observed.host, `${fixture.loopbackAddress.host}:${String(fixture.loopbackAddress.port)}`)
    assert.equal(observed.authorization, `Bearer pi-acp-fixture-${fixture.nonce}`)
    assert.ok(observed.body.length > 0 && observed.body.length <= MAX_LOOPBACK_BODY_BYTES)

    const body = JSON.parse(observed.body.toString('utf8')) as {
      model?: unknown
      stream?: unknown
      messages?: readonly {
        role?: unknown
        content?: unknown
      }[]
    }
    assert.equal(body.model, 'fixture-model-v1')
    assert.equal(body.stream, true)
    const userMessages = (body.messages ?? []).filter(message => message.role === 'user')
    assert.deepEqual(userMessages, [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: FIXED_USER_TEXT
          }
        ]
      }
    ])

    const exit = await fixture.client.close()
    assert.deepEqual({ code: exit.code, signal: exit.signal }, { code: 0, signal: null })
    await closeProvider()
  }
)
