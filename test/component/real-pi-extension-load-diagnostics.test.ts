import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { PROJECT_TRUST_WARNING } from '../../src/acp/agent.js'
import { startRealPiFixture } from '../helpers/real-pi-fixture.js'

const TEST_TIMEOUT_MS = 30_000
const SESSION_NEW_FAILURE_BOUND_MS = 10_000
const DIAGNOSTIC_SUMMARY_LIMIT_BYTES = 4_096
const DIAGNOSTIC_STDERR_LIMIT_BYTES = 16_384
const FAILING_EXTENSION_SAFE_REASON = 'C1.1_SAFE_EXTENSION_LOAD_REASON'
const FAILING_EXTENSION_SOURCE = 'global:extensions/pi-acp-failing-load/index.ts'
const FAILING_EXTENSION_FAKE_CREDENTIAL = 'sk-proj-dummy-internal-hyphens-123456789012'

type ExtensionLoadDiagnostic = {
  schemaVersion: number
  code: string
  phase: string
  source: string
  summary: string
  truncated: boolean
  redacted: boolean
  stderrLimitBytes: number
  summaryLimitBytes: number
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (isProcessRunning(pid)) {
    if (Date.now() >= deadline) throw new Error(`process ${String(pid)} remained alive after ${String(timeoutMs)}ms`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function assertPathMissing(path: string): Promise<void> {
  await assert.rejects(access(path), (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT')
    return true
  })
}

function hasForbiddenControlCharacter(value: string, allowLineBreaks: boolean): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (allowLineBreaks && (codePoint === 0x0a || codePoint === 0x0d)) continue
    if (codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))) return true
  }
  return false
}

function assertPrivacySafe(
  value: string,
  fixtureRoot: string | undefined,
  parentMarker: string,
  options: { allowLineBreaks?: boolean } = {}
): void {
  if (fixtureRoot !== undefined) assert.equal(value.includes(fixtureRoot), false)
  assert.equal(value.includes(FAILING_EXTENSION_FAKE_CREDENTIAL), false)
  assert.equal(value.includes(parentMarker), false)
  assert.equal(value.includes('\u001b'), false)
  assert.equal(value.includes('\u009b'), false)
  assert.equal(value.includes('[31m'), false)
  assert.equal(value.includes('[32m'), false)
  assert.equal(hasForbiddenControlCharacter(value, options.allowLineBreaks ?? false), false)
  assert.equal(value.includes('EPIPE'), false)
  assert.equal(value.includes('ERR_STREAM_DESTROYED'), false)
}

test(
  'C1.1 surfaces bounded privacy-safe diagnostics when a real Pi global extension fails to load',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const parentMarker = `parent-extension-load-poison-${String(process.pid)}-${String(Date.now())}`
    const previousOpenAiKey = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = parentMarker

    let fixture: Awaited<ReturnType<typeof startRealPiFixture>> | undefined
    try {
      fixture = await startRealPiFixture({
        extensionLoadFailure: true,
        hardDeadlineMs: 20_000,
        transcriptCheckpoint: 'C1.1',
        transcriptCaseId: 'C1.1-EXTENSION-LOAD-FAILURE'
      })

      const outerProcessId = fixture.client.processId
      assert.ok(outerProcessId)
      await access(join(fixture.agentDir, 'extensions', 'pi-acp-failing-load', 'index.ts'))
      const settings = JSON.parse(await readFile(join(fixture.agentDir, 'settings.json'), 'utf8')) as {
        quietStartup?: unknown
      }
      assert.equal(settings.quietStartup, true)
      await fixture.client.initialize()

      const startedAt = performance.now()
      const error = await fixture.client
        .newSession({ cwd: fixture.cwd, mcpServers: [] })
        .then(() => undefined)
        .catch((caught: unknown) => caught)
      const failureDurationMs = performance.now() - startedAt

      assert.ok(error instanceof Error)
      assert.equal((error as Error & { code?: unknown }).code, -32603)
      assert.ok(
        failureDurationMs < SESSION_NEW_FAILURE_BOUND_MS,
        `session/new took ${failureDurationMs.toFixed(1)}ms to report the extension load failure`
      )

      const requestError = error as Error & {
        code: number
        data?: {
          piAcp?: {
            diagnostic?: ExtensionLoadDiagnostic
          }
        }
      }
      const diagnostic = requestError.data?.piAcp?.diagnostic
      assert.ok(diagnostic)
      assert.deepEqual(Object.keys(diagnostic).sort(), [
        'code',
        'phase',
        'redacted',
        'schemaVersion',
        'source',
        'stderrLimitBytes',
        'summary',
        'summaryLimitBytes',
        'truncated'
      ])
      assert.equal(diagnostic.schemaVersion, 1)
      assert.equal(diagnostic.code, 'PI_EXTENSION_LOAD_FAILED')
      assert.equal(diagnostic.phase, 'startup')
      assert.equal(diagnostic.source, FAILING_EXTENSION_SOURCE)
      assert.equal(diagnostic.truncated, true)
      assert.equal(diagnostic.redacted, true)
      assert.equal(diagnostic.stderrLimitBytes, DIAGNOSTIC_STDERR_LIMIT_BYTES)
      assert.equal(diagnostic.summaryLimitBytes, DIAGNOSTIC_SUMMARY_LIMIT_BYTES)
      assert.ok(Buffer.byteLength(diagnostic.summary, 'utf8') <= DIAGNOSTIC_SUMMARY_LIMIT_BYTES)
      const messageBytes = Buffer.byteLength(requestError.message, 'utf8')
      assert.ok(
        messageBytes <= DIAGNOSTIC_SUMMARY_LIMIT_BYTES,
        `JSON-RPC message used ${String(messageBytes)} UTF-8 bytes: ${requestError.message.slice(0, 96)}`
      )

      for (const visibleText of [requestError.message, diagnostic.summary]) {
        assert.match(visibleText, new RegExp(FAILING_EXTENSION_SAFE_REASON, 'u'))
        assert.match(visibleText, new RegExp(FAILING_EXTENSION_SOURCE.replaceAll('.', '\\.'), 'u'))
        assertPrivacySafe(visibleText, fixture.rootDir, parentMarker, { allowLineBreaks: true })
      }

      const serializedError = JSON.stringify({
        code: requestError.code,
        message: requestError.message,
        data: requestError.data
      })
      assertPrivacySafe(serializedError, fixture.rootDir, parentMarker)
      assert.deepEqual(fixture.requests, [])
      const canaryPids = (await readFile(fixture.projectCanaryPath, 'utf8'))
        .trim()
        .split('\n')
        .map(value => Number(value))
      assert.equal(canaryPids.length, 1)
      assert.equal(Number.isInteger(canaryPids[0]) && canaryPids[0]! > 0, true)
      await assertPathMissing(fixture.trustPath)
      assert.equal(fixture.client.isRunning, true)

      const exit = await fixture.client.close()
      assert.equal(exit.code, 0)
      assert.equal(exit.signal, null)
      await waitForProcessExit(outerProcessId, 5_000)
      assert.equal(fixture.client.isRunning, false)

      const agentToClientEvidence = fixture.client
        .transcript()
        .flatMap(entry =>
          entry.kind === 'message' && entry.direction === 'agent_to_client' ? [JSON.stringify(entry.message)] : []
        )
        .join('\n')
      assert.equal(agentToClientEvidence.includes(PROJECT_TRUST_WARNING), false)
      assertPrivacySafe(agentToClientEvidence, fixture.rootDir, parentMarker, { allowLineBreaks: true })
      assertPrivacySafe(exit.stderrTail, undefined, parentMarker, { allowLineBreaks: true })
      assert.equal(exit.stderrTail.includes(fixture.agentDir), false)
      assert.equal(
        exit.stderrTail.includes(join(fixture.agentDir, 'extensions', 'pi-acp-failing-load', 'index.ts')),
        false
      )
      assert.deepEqual(fixture.requests, [])

      await fixture.cleanup()
      await assertPathMissing(fixture.rootDir)
    } finally {
      await fixture?.cleanup().catch(() => undefined)
      if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previousOpenAiKey
    }
  }
)
