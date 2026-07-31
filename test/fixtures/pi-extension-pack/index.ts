import { VERSION, type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FIXTURE_ID = 'pi-extension-pack-v1'
const PROVIDER_ID = 'pi-acp-fixture'
const MODEL_ID = 'fixture-model-v1'
const COMMAND_ID = 'fixture-state'
const EXPECTED_PI_VERSION = '0.83.0'
const extensionPath = fileURLToPath(import.meta.url)
let factoryInvocationCount = 0

function requireFixtureEnvironment() {
  const nonce = process.env.PI_ACP_FIXTURE_NONCE
  const receiptDir = process.env.PI_ACP_FIXTURE_RECEIPT_DIR
  const baseUrlText = process.env.PI_ACP_FIXTURE_BASE_URL
  const apiKey = process.env.PI_ACP_FIXTURE_API_KEY
  const forbiddenEnvNames = JSON.parse(process.env.PI_ACP_FIXTURE_FORBIDDEN_ENV_NAMES ?? '[]')

  if (!nonce || !/^[0-9a-f]{32}$/u.test(nonce)) {
    throw new Error('C0.6 fixture nonce must be exactly 32 lowercase hex characters')
  }
  if (!receiptDir || !isAbsolute(receiptDir)) {
    throw new Error('C0.6 fixture receipt directory must be absolute')
  }
  if (apiKey !== `pi-acp-fixture-${nonce}`) {
    throw new Error('C0.6 fixture API key must be the nonce-derived non-secret test value')
  }
  if (!Array.isArray(forbiddenEnvNames) || forbiddenEnvNames.some(name => typeof name !== 'string')) {
    throw new TypeError('C0.6 forbidden environment names must be a JSON string array')
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
    throw new Error('C0.6 fixture provider URL must be an explicit numeric loopback /v1 origin')
  }

  return {
    nonce,
    receiptDir,
    baseUrl: baseUrl.href.replace(/\/$/u, ''),
    forbiddenEnvNames
  }
}

export default function registerPiAcpFixture(pi: ExtensionAPI) {
  factoryInvocationCount += 1
  if (VERSION !== EXPECTED_PI_VERSION) {
    throw new Error(`C0.6 fixture requires Pi ${EXPECTED_PI_VERSION}, received ${VERSION}`)
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
    handler: async (_args, ctx) => {
      ctx.ui.notify('Pi ACP fixture loaded', 'info')
    }
  })

  pi.on('session_start', (event, ctx) => {
    if (event.reason !== 'startup') return
    if (ctx.mode !== 'rpc') throw new Error(`C0.6 fixture requires rpc mode, received ${ctx.mode}`)

    const registeredProviderIds = [...ctx.modelRegistry.getRegisteredProviderIds()]
    const model = ctx.modelRegistry.find(PROVIDER_ID, MODEL_ID)
    const available = ctx.modelRegistry
      .getAvailable()
      .some(candidate => candidate.provider === PROVIDER_ID && candidate.id === MODEL_ID)
    const authConfigured = model ? ctx.modelRegistry.hasConfiguredAuth(model) : false
    const selected = ctx.model?.provider === PROVIDER_ID && ctx.model.id === MODEL_ID
    const fixtureCommands = pi
      .getCommands()
      .filter(command => command.name === COMMAND_ID && command.source === 'extension')

    if (
      !registeredProviderIds.includes(PROVIDER_ID) ||
      !model ||
      !available ||
      !authConfigured ||
      !selected ||
      fixtureCommands.length !== 1
    ) {
      throw new Error('C0.6 fixture registrations were not fully bound before session_start')
    }

    const cliPath = process.argv[1]
    const source = readFileSync(extensionPath)
    const receipt = {
      schemaVersion: 1,
      checkpoint: 'C0.6',
      fixtureId: FIXTURE_ID,
      extensionEvidenceKind: 'cooperative_session_start_on_disk_self_report',
      phase: 'registered_and_started',
      event: event.type,
      reason: event.reason,
      nonce: fixture.nonce,
      factoryInvocationCount,
      piVersion: VERSION,
      piPid: process.pid,
      nodeVersion: process.versions.node,
      cwd: ctx.cwd,
      agentDir: process.env.PI_CODING_AGENT_DIR,
      sessionDir: process.env.PI_CODING_AGENT_SESSION_DIR,
      packageDir: process.env.PI_PACKAGE_DIR,
      extensionRealpath: realpathSync(extensionPath),
      extensionSha256: createHash('sha256').update(source).digest('hex'),
      cliRealpath: cliPath ? realpathSync(cliPath) : null,
      offline: process.env.PI_OFFLINE === '1',
      versionCheckDisabled: process.env.PI_SKIP_VERSION_CHECK === '1',
      telemetryDisabled: process.env.PI_TELEMETRY === '0',
      approveArgPresent: process.argv.includes('--approve') || process.argv.includes('-a'),
      extensionArgPresent: process.argv.includes('--extension') || process.argv.includes('-e'),
      forbiddenEnvPresent: fixture.forbiddenEnvNames.filter(name => Object.hasOwn(process.env, name)),
      environmentKeys: Object.keys(process.env).sort(),
      projectTrusted: ctx.isProjectTrusted(),
      registrations: {
        providers: [PROVIDER_ID],
        commands: [COMMAND_ID]
      },
      model: {
        provider: model.provider,
        id: model.id,
        name: model.name,
        available,
        authConfigured,
        selected
      }
    }

    writeFileSync(
      join(fixture.receiptDir, `pi-acp-c0.6-registration-${fixture.nonce}.json`),
      `${JSON.stringify(receipt)}\n`,
      {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600
      }
    )
  })

  pi.on('session_shutdown', event => {
    if (event.reason !== 'quit') return
    writeFileSync(
      join(fixture.receiptDir, `pi-acp-c0.6-shutdown-${fixture.nonce}.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        checkpoint: 'C0.6',
        fixtureId: FIXTURE_ID,
        phase: 'session_shutdown',
        reason: event.reason,
        nonce: fixture.nonce,
        piVersion: VERSION,
        piPid: process.pid
      })}\n`,
      {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600
      }
    )
  })
}
