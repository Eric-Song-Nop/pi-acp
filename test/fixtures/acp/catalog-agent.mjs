import { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } from '@agentclientprotocol/sdk'
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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

const stubbornMode = mode === 'hang-prompt' || mode === 'close-output-on-prompt' || malformedPayloads.has(mode)
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
const input = NodeReadable.toWeb(process.stdin)
const stream = ndJsonStream(output, input)

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

if (malformedPayloads.has(mode)) {
  await writeStdout(`${JSON.stringify(malformedPayload)}\n`)
} else {
  new AgentSideConnection(connection => new CatalogAgent(connection), stream)
}

process.stdout.on('error', () => {
  if (!stubbornMode) process.exit(0)
})
