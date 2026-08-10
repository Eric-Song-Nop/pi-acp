import { VERSION, type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { createHash } from 'node:crypto'
import { closeSync, constants, fsyncSync, openSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const EXPECTED_PI_VERSION = '0.83.0'
const PROVIDER_ID = 'pi-acp-fixture'
const MODEL_ID = 'fixture-model-v1'
const COMMAND_ID = 'fixture-state'
const HANG_SENTINEL = 'hang-after-receipt'
let invocationCount = 0

function requireFixtureEnvironment() {
  const nonce = process.env.PI_ACP_FIXTURE_NONCE
  const receiptDir = process.env.PI_ACP_FIXTURE_RECEIPT_DIR
  const baseUrlText = process.env.PI_ACP_FIXTURE_BASE_URL
  const apiKey = process.env.PI_ACP_FIXTURE_API_KEY

  if (!nonce || !/^[0-9a-f]{32}$/u.test(nonce)) {
    throw new Error('C3.4 fixture nonce must be exactly 32 lowercase hex characters')
  }
  if (!receiptDir || !isAbsolute(receiptDir)) {
    throw new Error('C3.4 fixture receipt directory must be absolute')
  }
  if (apiKey !== `pi-acp-fixture-${nonce}`) {
    throw new Error('C3.4 fixture API key must be the nonce-derived non-secret test value')
  }

  const baseUrl = new URL(baseUrlText ?? '')
  if (
    baseUrl.protocol !== 'http:' ||
    baseUrl.hostname !== '127.0.0.1' ||
    !baseUrl.port ||
    baseUrl.pathname !== '/v1' ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw new Error('C3.4 fixture provider URL must be an explicit numeric loopback /v1 origin')
  }

  return {
    nonce,
    receiptDir,
    baseUrl: baseUrl.href.replace(/\/$/u, '')
  }
}

function writeDurableReceipt(receiptDir: string, name: string, value: unknown): void {
  const path = join(receiptDir, name)
  const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try {
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`, 'utf8')
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }

  if (process.platform !== 'win32') {
    const directoryDescriptor = openSync(receiptDir, constants.O_RDONLY)
    try {
      fsyncSync(directoryDescriptor)
    } finally {
      closeSync(directoryDescriptor)
    }
  }
}

export default function registerC3_4ExecuteCommandFixture(pi: ExtensionAPI) {
  if (VERSION !== EXPECTED_PI_VERSION) {
    throw new Error(`C3.4 fixture requires Pi ${EXPECTED_PI_VERSION}, received ${VERSION}`)
  }
  const fixture = requireFixtureEnvironment()

  pi.registerProvider(PROVIDER_ID, {
    name: 'Pi ACP Fixture',
    baseUrl: fixture.baseUrl,
    apiKey: '$PI_ACP_FIXTURE_API_KEY',
    api: 'openai-completions',
    models: [
      {
        id: MODEL_ID,
        name: 'Pi ACP Fixture Model',
        reasoning: false,
        input: ['text'],
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0
        },
        contextWindow: 8_192,
        maxTokens: 1_024
      }
    ]
  })

  pi.registerCommand(COMMAND_ID, {
    description: 'Report that the deterministic Pi ACP fixture is loaded',
    handler: async (args, ctx) => {
      invocationCount += 1
      const argsBytes = Buffer.from(args, 'utf8')
      writeDurableReceipt(
        fixture.receiptDir,
        `pi-acp-c3.4-invocation-${fixture.nonce}-${String(process.pid)}-${String(invocationCount)}.json`,
        {
          schemaVersion: 1,
          checkpoint: 'C3.4',
          phase: 'command_invocation',
          nonce: fixture.nonce,
          piVersion: VERSION,
          piPid: process.pid,
          sessionId: ctx.sessionManager.getSessionId(),
          sessionFile: ctx.sessionManager.getSessionFile() ?? null,
          invocationCount,
          name: COMMAND_ID,
          args,
          argsUtf8ByteLength: argsBytes.length,
          argsSha256: createHash('sha256').update(argsBytes).digest('hex'),
          argsBase64: argsBytes.toString('base64')
        }
      )

      if (args === HANG_SENTINEL) await new Promise<never>(() => undefined)
      ctx.ui.notify('Pi ACP C3.4 fixture state', 'info')
    }
  })

  pi.on('session_start', (_event, ctx) => {
    writeDurableReceipt(fixture.receiptDir, `pi-acp-c3.4-session-start-${fixture.nonce}-${String(process.pid)}.json`, {
      schemaVersion: 1,
      checkpoint: 'C3.4',
      phase: 'session_start',
      nonce: fixture.nonce,
      piVersion: VERSION,
      piPid: process.pid,
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile() ?? null
    })
  })

  pi.on('session_shutdown', event => {
    if (event.reason !== 'quit') return
    writeDurableReceipt(fixture.receiptDir, `pi-acp-c3.4-shutdown-${fixture.nonce}-${String(process.pid)}.json`, {
      schemaVersion: 1,
      checkpoint: 'C3.4',
      phase: 'session_shutdown',
      reason: event.reason,
      nonce: fixture.nonce,
      piVersion: VERSION,
      piPid: process.pid
    })
  })
}
