import { VERSION, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { createHash } from 'node:crypto'
import { closeSync, constants, fsyncSync, lstatSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const EXPECTED_PI_VERSION = '0.83.0'
const PROVIDER_ID = 'pi-acp-fixture'
const MODEL_ID = 'fixture-model-v1'
const COMMAND_ID = 'fixture-state'
const OK_NOTIFICATION = 'Pi ACP C3.6 fixture state ok'
const PRIVATE_THROW_CANARY = 'C3.6 private throw canary 7f19644ea4c84604'
const EXIT_BEFORE_RESPONSE_CODE = 86

const ACCEPTED_ARGS = new Set([
  'c3.6-ok',
  'c3.6-throw',
  'c3.6-block',
  'c3.6-exit-before-response',
  'c3.6-response-before-exit'
])

let invocationCount = 0
let receiptSequence = 0

function requireFixtureEnvironment() {
  const nonce = process.env.PI_ACP_FIXTURE_NONCE
  const receiptDir = process.env.PI_ACP_FIXTURE_RECEIPT_DIR
  const baseUrlText = process.env.PI_ACP_FIXTURE_BASE_URL
  const apiKey = process.env.PI_ACP_FIXTURE_API_KEY

  if (!nonce || !/^[0-9a-f]{32}$/u.test(nonce)) {
    throw new Error('C3.6 fixture nonce must be exactly 32 lowercase hex characters')
  }
  if (!receiptDir || !isAbsolute(receiptDir)) {
    throw new Error('C3.6 fixture receipt directory must be absolute')
  }
  if (apiKey !== `pi-acp-fixture-${nonce}`) {
    throw new Error('C3.6 fixture API key must be the nonce-derived non-secret test value')
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
    throw new Error('C3.6 fixture provider URL must be an explicit numeric loopback /v1 origin')
  }

  return {
    nonce,
    receiptDir,
    baseUrl: baseUrl.href.replace(/\/$/u, '')
  }
}

function sessionIdentity(ctx: ExtensionContext): { sessionId: string; sessionFile: string | null } {
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: ctx.sessionManager.getSessionFile() ?? null
  }
}

function writeDurableReceipt(
  fixture: ReturnType<typeof requireFixtureEnvironment>,
  phase: string,
  value: Record<string, unknown>
): void {
  receiptSequence += 1
  const path = join(
    fixture.receiptDir,
    `pi-acp-c3.6-${phase}-${fixture.nonce}-${String(process.pid)}-${String(receiptSequence)}.json`
  )
  const temporaryPath = `${path}.tmp`
  const descriptor = openSync(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  let descriptorOpen = true
  try {
    writeFileSync(
      descriptor,
      `${JSON.stringify({
        schemaVersion: 1,
        checkpoint: 'C3.6',
        phase,
        sequence: receiptSequence,
        nonce: fixture.nonce,
        piVersion: VERSION,
        piPid: process.pid,
        ...value
      })}\n`,
      'utf8'
    )
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptorOpen = false
    try {
      lstatSync(path)
      throw new Error(`C3.6 receipt path already exists: ${path}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    renameSync(temporaryPath, path)
  } catch (error) {
    const cleanupErrors: unknown[] = []
    if (descriptorOpen) {
      try {
        closeSync(descriptor)
      } catch (closeError) {
        cleanupErrors.push(closeError)
      }
    }
    try {
      unlinkSync(temporaryPath)
    } catch (unlinkError) {
      if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') cleanupErrors.push(unlinkError)
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], 'C3.6 receipt publication and cleanup failed')
    }
    throw error
  }

  if (process.platform !== 'win32') {
    const directoryDescriptor = openSync(fixture.receiptDir, constants.O_RDONLY)
    let syncError: unknown
    try {
      fsyncSync(directoryDescriptor)
    } catch (error) {
      syncError = error
    }
    try {
      closeSync(directoryDescriptor)
    } catch (closeError) {
      if (syncError !== undefined) {
        throw new AggregateError([syncError, closeError], 'C3.6 receipt directory sync and cleanup failed')
      }
      throw closeError
    }
    if (syncError !== undefined) throw syncError
  }
}

export default function registerC3_6FailureLifecycleFixture(pi: ExtensionAPI) {
  if (VERSION !== EXPECTED_PI_VERSION) {
    throw new Error(`C3.6 fixture requires Pi ${EXPECTED_PI_VERSION}, received ${VERSION}`)
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
      writeDurableReceipt(fixture, 'command_invocation', {
        ...sessionIdentity(ctx),
        invocationCount,
        name: COMMAND_ID,
        args,
        argsUtf8ByteLength: argsBytes.length,
        argsSha256: createHash('sha256').update(argsBytes).digest('hex'),
        argsBase64: argsBytes.toString('base64')
      })

      if (!ACCEPTED_ARGS.has(args)) throw new Error('C3.6 fixture received an unknown or malformed argument')
      if (args === 'c3.6-throw') throw new Error(PRIVATE_THROW_CANARY)
      if (args === 'c3.6-block') await new Promise<never>(() => undefined)
      if (args === 'c3.6-exit-before-response') process.exit(EXIT_BEFORE_RESPONSE_CODE)
      if (args === 'c3.6-response-before-exit') ctx.shutdown()
      if (args === 'c3.6-ok') ctx.ui.notify(OK_NOTIFICATION, 'info')
    }
  })

  pi.on('session_start', (_event, ctx) => {
    writeDurableReceipt(fixture, 'session_start', sessionIdentity(ctx))
  })

  pi.on('session_shutdown', (event, ctx) => {
    if (event.reason !== 'quit') return
    writeDurableReceipt(fixture, 'session_shutdown', {
      ...sessionIdentity(ctx),
      reason: event.reason
    })
  })
}
