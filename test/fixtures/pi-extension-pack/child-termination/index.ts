import { VERSION, type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { existsSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const EXPECTED_PI_VERSION = '0.83.0'
const COMMAND_ID = 'c1-3-terminate-child'

function fixturePaths() {
  const nonce = process.env.PI_ACP_FIXTURE_NONCE
  const receiptDir = process.env.PI_ACP_FIXTURE_RECEIPT_DIR
  if (!nonce || !/^[0-9a-f]{32}$/u.test(nonce)) {
    throw new Error('C1.3 fixture nonce must be exactly 32 lowercase hex characters')
  }
  if (!receiptDir || !isAbsolute(receiptDir)) {
    throw new Error('C1.3 fixture receipt directory must be absolute')
  }

  return {
    nonce,
    receiptDir,
    markerPath: join(receiptDir, `pi-acp-c1.3-terminated-${nonce}.marker`)
  }
}

export default function registerChildTerminationFixture(pi: ExtensionAPI) {
  if (VERSION !== EXPECTED_PI_VERSION) {
    throw new Error(`C1.3 fixture requires Pi ${EXPECTED_PI_VERSION}, received ${VERSION}`)
  }
  const fixture = fixturePaths()

  pi.on('session_start', (_event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile()
    writeFileSync(
      join(fixture.receiptDir, `pi-acp-c1.3-session-start-${fixture.nonce}-${String(process.pid)}.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        checkpoint: 'C1.3',
        phase: 'session_start',
        nonce: fixture.nonce,
        piVersion: VERSION,
        piPid: process.pid,
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile: sessionFile ?? null
      })}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 }
    )
  })

  pi.registerCommand(COMMAND_ID, {
    description: 'C1.3 test-only child termination trigger',
    handler: async (_args, ctx) => {
      if (existsSync(fixture.markerPath)) return
      writeFileSync(fixture.markerPath, 'terminate-once\n', {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600
      })

      // Pi 0.83 guarantees that RPC-mode shutdown is deferred until the
      // current command response has been written. The child therefore exits
      // after the prompt ACK but before any agent_settled event or provider
      // request, reproducing the C1.3 lifecycle gap without a timing race.
      ctx.shutdown()
    }
  })
}
