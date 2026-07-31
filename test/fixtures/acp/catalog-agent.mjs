import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from '@agentclientprotocol/sdk'
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable as NodeReadable } from 'node:stream'

const mode = process.argv.find(argument => argument.startsWith('--mode='))?.slice('--mode='.length) ?? 'default'
const fragmentBytes = Number.parseInt(process.env.ACP_FIXTURE_FRAGMENT_BYTES ?? '0', 10)
const malformedPayloads = new Map([
  ['malformed-primitive', 42],
  ['malformed-null', null],
  ['malformed-array', []],
  ['malformed-response', { id: 0, error: null }],
  ['malformed-error-object', { jsonrpc: '2.0', id: 0, error: null }]
])
const malformedPayload = malformedPayloads.get(mode)

if (!Number.isInteger(fragmentBytes) || fragmentBytes < 0) {
  throw new Error('ACP_FIXTURE_FRAGMENT_BYTES must be a non-negative integer')
}

if (process.env.ACP_HARNESS_PARENT_MARKER !== undefined) {
  process.stderr.write(`unexpected inherited marker: ${process.env.ACP_HARNESS_PARENT_MARKER}\n`)
}

const stubbornMode =
  mode === 'hang-prompt' || mode === 'timeout-race' || mode === 'close-output-on-prompt' || malformedPayloads.has(mode)
if (stubbornMode) {
  if (process.platform !== 'win32') process.on('SIGTERM', () => {})
  setInterval(() => {}, 1_000)
}

function writeStdout(chunk) {
  return new Promise((resolve, reject) => {
    process.stdout.write(Buffer.from(chunk), error => {
      if (error) reject(error)
      else resolve()
    })
  })
}

const output = new WritableStream({
  async write(chunk) {
    if (fragmentBytes === 0) {
      await writeStdout(chunk)
      return
    }

    for (let offset = 0; offset < chunk.length; offset += fragmentBytes) {
      await writeStdout(chunk.subarray(offset, offset + fragmentBytes))
    }
  }
})

class CatalogAgent {
  constructor(connection) {
    this.connection = connection
  }

  sessions = new Set()
  pendingPrompts = new Map()
  descendant = undefined
  nextSessionId = 1

  async initialize() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false
      }
    }
  }

  async newSession() {
    const sessionId = `fixture-session-${this.nextSessionId}`
    this.nextSessionId += 1
    this.sessions.add(sessionId)

    if (mode === 'hang-prompt' && process.platform !== 'win32' && !this.descendant) {
      this.descendant = spawn(
        process.execPath,
        ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
        { stdio: 'ignore' }
      )
      this.descendant.unref()
      if (this.descendant.pid === undefined) throw new Error('Failed to spawn fixture descendant')
      await writeFile(join(process.cwd(), 'descendant.pid'), String(this.descendant.pid), 'utf8')
    }

    if (mode !== 'no-catalog') {
      setTimeout(() => {
        void this.publishCatalog(sessionId, ['alpha']).catch(error => {
          process.stderr.write(`catalog publish failed: ${String(error)}\n`)
        })
      }, 0)
    }

    return { sessionId }
  }

  async authenticate() {
    return {}
  }

  async prompt(params) {
    if (!this.sessions.has(params.sessionId)) throw new Error(`Unknown fixture session ${params.sessionId}`)

    if (mode === 'hang-prompt') {
      return await new Promise(resolve => {
        this.pendingPrompts.set(params.sessionId, resolve)
      })
    }

    if (mode === 'exit-on-prompt') {
      await new Promise(resolve => {
        process.stderr.write(Buffer.concat([Buffer.alloc(32 * 1024, 0xff), Buffer.from('TAIL-MARKER\n')]), resolve)
      })
      setTimeout(() => process.exit(17), 0)
      return await new Promise(() => {})
    }

    if (mode === 'close-output-on-prompt') {
      await new Promise(resolve => {
        process.stderr.write('OUTPUT-CLOSED-MARKER\n', resolve)
      })
      process.stdout.end()
      return await new Promise(() => {})
    }

    const text = params.prompt
      .filter(content => content.type === 'text')
      .map(content => content.text)
      .join('')
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `fixture echo: ${text}`
        }
      }
    })
    return { stopReason: 'end_turn' }
  }

  async cancel(params) {
    const resolve = this.pendingPrompts.get(params.sessionId)
    if (!resolve) return
    this.pendingPrompts.delete(params.sessionId)
    resolve({ stopReason: 'cancelled' })
  }

  async extMethod(method, params) {
    if (method === 'test/ping') {
      return { sequence: params.sequence }
    }
    if (method !== 'test/set_catalog') throw new Error(`Unknown fixture extension method ${method}`)

    const sessionId = params.sessionId
    const names = params.names
    if (typeof sessionId !== 'string' || !this.sessions.has(sessionId)) {
      throw new Error('test/set_catalog requires a known sessionId')
    }
    if (!Array.isArray(names) || names.some(name => typeof name !== 'string')) {
      throw new Error('test/set_catalog requires a string names array')
    }

    await this.publishCatalog(sessionId, names)
    return { updated: names.length }
  }

  async publishCatalog(sessionId, names) {
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: names.map(name => ({
          name,
          description: `Fixture command /${name}`,
          input: {
            hint: 'arguments'
          }
        }))
      }
    })
  }
}

async function runTimeoutRaceAgent() {
  let writeQueue = Promise.resolve()
  let nextSessionId = 1
  let latePrompt
  const send = message => {
    writeQueue = writeQueue.then(() => writeStdout(`${JSON.stringify(message)}\n`))
    return writeQueue
  }
  const handleMessage = async message => {
    if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string' || !Object.hasOwn(message, 'id')) return

    if (message.method === 'initialize') {
      await send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: false
          }
        }
      })
      return
    }

    if (message.method === 'session/new') {
      const sessionId = `fixture-session-${nextSessionId}`
      nextSessionId += 1
      await send({
        jsonrpc: '2.0',
        id: message.id,
        result: { sessionId }
      })
      await send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [
              {
                name: 'alpha',
                description: 'Fixture command /alpha',
                input: {
                  hint: 'arguments'
                }
              }
            ]
          }
        }
      })
      return
    }

    if (message.method !== 'session/prompt') return
    const promptText = Array.isArray(message.params?.prompt)
      ? message.params.prompt
          .filter(content => content?.type === 'text' && typeof content.text === 'string')
          .map(content => content.text)
          .join('')
      : ''
    if (!promptText.includes('late')) return

    latePrompt = message
    await send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: message.params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `armed:${promptText}`
          }
        }
      }
    })
  }

  const handlers = new Set()
  const lines = createInterface({
    input: process.stdin,
    crlfDelay: Number.POSITIVE_INFINITY
  })
  for await (const line of lines) {
    if (line.length === 0) continue
    try {
      const message = JSON.parse(line)
      const handler = handleMessage(message)
      handlers.add(handler)
      void handler
        .catch(error => {
          process.stderr.write(`timeout-race message failed: ${String(error)}\n`)
        })
        .finally(() => {
          handlers.delete(handler)
        })
    } catch (error) {
      process.stderr.write(`timeout-race parse failed: ${String(error)}\n`)
    }
  }

  await Promise.allSettled([...handlers])
  await new Promise(resolve => {
    process.stderr.write('TIMEOUT-RACE-EOF\n', resolve)
  })
  if (latePrompt) {
    await send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: latePrompt.params.sessionId,
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            {
              name: 'late-poison',
              description: 'Must never enter retained client state',
              input: {
                hint: 'arguments'
              }
            }
          ]
        }
      }
    })
    await send({
      jsonrpc: '2.0',
      id: latePrompt.id,
      result: { stopReason: 'end_turn' }
    })
  }
}

if (malformedPayloads.has(mode)) {
  await writeStdout(`${JSON.stringify(malformedPayload)}\n`)
} else if (mode === 'timeout-race') {
  await runTimeoutRaceAgent()
} else {
  const input = NodeReadable.toWeb(process.stdin)
  const stream = ndJsonStream(output, input)
  new AgentSideConnection(connection => new CatalogAgent(connection), stream)
}

process.stdout.on('error', () => {
  if (!stubbornMode) process.exit(0)
})
