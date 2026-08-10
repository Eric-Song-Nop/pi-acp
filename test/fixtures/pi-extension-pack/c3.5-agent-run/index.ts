import { VERSION, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { closeSync, constants, fsyncSync, lstatSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

const EXPECTED_PI_VERSION = '0.83.0'
const PROVIDER_ID = 'pi-acp-fixture'
const MODEL_ID = 'fixture-model-v1'
const COMMAND_ID = 'fixture-agent'
const USER_TEXT = 'Run the deterministic Pi ACP C3.5 fixture agent turn.'
const RELEASE_TEXT = 'release\n'
const RELEASE_TIMEOUT_MS = 10_000

let invocationCount = 0
let receiptSequence = 0

function requireFixtureEnvironment() {
  const nonce = process.env.PI_ACP_FIXTURE_NONCE
  const receiptDir = process.env.PI_ACP_FIXTURE_RECEIPT_DIR
  const baseUrlText = process.env.PI_ACP_FIXTURE_BASE_URL
  const apiKey = process.env.PI_ACP_FIXTURE_API_KEY
  const schedule = process.env.PI_ACP_C3_5_SCHEDULE

  if (!nonce || !/^[0-9a-f]{32}$/u.test(nonce)) {
    throw new Error('C3.5 fixture nonce must be exactly 32 lowercase hex characters')
  }
  if (!receiptDir || !isAbsolute(receiptDir)) {
    throw new Error('C3.5 fixture receipt directory must be absolute')
  }
  if (apiKey !== `pi-acp-fixture-${nonce}`) {
    throw new Error('C3.5 fixture API key must be the nonce-derived non-secret test value')
  }
  if (schedule !== 'preflight' && schedule !== 'provider-final') {
    throw new Error('C3.5 fixture schedule must be preflight or provider-final')
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
    throw new Error('C3.5 fixture provider URL must be an explicit numeric loopback /v1 origin')
  }

  return {
    nonce,
    receiptDir,
    baseUrl: baseUrl.href.replace(/\/$/u, ''),
    schedule,
    preflightReleasePath: join(receiptDir, `pi-acp-c3.5-preflight-release-${nonce}`)
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
    `pi-acp-c3.5-${phase}-${fixture.nonce}-${String(process.pid)}-${String(receiptSequence)}.json`
  )
  const temporaryPath = `${path}.tmp`
  const descriptor = openSync(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  let descriptorOpen = true
  try {
    writeFileSync(
      descriptor,
      `${JSON.stringify({
        schemaVersion: 1,
        checkpoint: 'C3.5',
        phase,
        sequence: receiptSequence,
        nonce: fixture.nonce,
        schedule: fixture.schedule,
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
      throw new Error(`C3.5 receipt path already exists: ${path}`)
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
      throw new AggregateError([error, ...cleanupErrors], 'C3.5 receipt publication and cleanup failed')
    }
    throw error
  }

  if (process.platform !== 'win32') {
    const directoryDescriptor = openSync(fixture.receiptDir, constants.O_RDONLY)
    try {
      fsyncSync(directoryDescriptor)
    } finally {
      closeSync(directoryDescriptor)
    }
  }
}

function sessionIdentity(ctx: ExtensionContext): { sessionId: string; sessionFile: string | null } {
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: ctx.sessionManager.getSessionFile() ?? null
  }
}

async function waitForRelease(path: string): Promise<void> {
  const deadline = Date.now() + RELEASE_TIMEOUT_MS
  for (;;) {
    try {
      const contents = await readFile(path, 'utf8')
      if (contents !== RELEASE_TEXT) throw new Error('C3.5 preflight release sentinel has invalid contents')
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (Date.now() >= deadline) throw new Error('C3.5 preflight release sentinel timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

export default function registerC3_5AgentRunFixture(pi: ExtensionAPI) {
  if (VERSION !== EXPECTED_PI_VERSION) {
    throw new Error(`C3.5 fixture requires Pi ${EXPECTED_PI_VERSION}, received ${VERSION}`)
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
    description: 'Run the deterministic Pi ACP C3.5 fixture agent turn',
    handler: async (args, ctx) => {
      if (args !== '') throw new Error('C3.5 fixture-agent requires empty arguments')
      invocationCount += 1
      writeDurableReceipt(fixture, 'command-invocation', {
        ...sessionIdentity(ctx),
        invocationCount,
        name: COMMAND_ID,
        args,
        argsUtf8ByteLength: Buffer.byteLength(args),
        argsBase64: Buffer.from(args).toString('base64')
      })
      pi.sendUserMessage(USER_TEXT)
    }
  })

  pi.on('session_start', (_event, ctx) => {
    writeDurableReceipt(fixture, 'session-start', sessionIdentity(ctx))
  })

  pi.on('before_agent_start', async (event, ctx) => {
    if (event.prompt !== USER_TEXT) throw new Error('C3.5 fixture observed an unattributed agent prompt')
    writeDurableReceipt(fixture, 'before-agent-start-entered', sessionIdentity(ctx))
    if (fixture.schedule === 'preflight') await waitForRelease(fixture.preflightReleasePath)
    writeDurableReceipt(fixture, 'before-agent-start-released', sessionIdentity(ctx))
  })

  pi.on('agent_start', (_event, ctx) => {
    writeDurableReceipt(fixture, 'agent-start', sessionIdentity(ctx))
  })

  pi.on('agent_end', (_event, ctx) => {
    writeDurableReceipt(fixture, 'agent-end', sessionIdentity(ctx))
  })

  pi.on('agent_settled', (_event, ctx) => {
    writeDurableReceipt(fixture, 'agent-settled', sessionIdentity(ctx))
  })

  pi.on('session_shutdown', (event, ctx) => {
    if (event.reason !== 'quit') return
    writeDurableReceipt(fixture, 'session-shutdown', {
      ...sessionIdentity(ctx),
      reason: event.reason
    })
  })
}
