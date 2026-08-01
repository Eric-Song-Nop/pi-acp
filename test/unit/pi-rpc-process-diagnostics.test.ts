import assert from 'node:assert/strict'
import { ChildProcess, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync as hostExistsSync, readFileSync, writeFileSync } from 'node:fs'
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  PI_STARTUP_STDERR_LIMIT_BYTES,
  PI_STARTUP_SUMMARY_LIMIT_BYTES,
  type PiStartupDiagnostic
} from '../../src/pi-rpc/diagnostics.js'
import {
  PI_RPC_HANDSHAKE_FAILED_CODE,
  PI_RPC_HANDSHAKE_TIMEOUT_CODE,
  PI_RPC_PROCESS_CLEANUP_UNCONFIRMED_CODE,
  PI_RPC_PROCESS_TERMINATED_CODE,
  PiRpcProcess,
  PiRpcProcessCleanupError,
  PiRpcProcessTerminatedError,
  PiRpcSpawnError,
  piRpcProcessTerminatedErrorData
} from '../../src/pi-rpc/process.js'

const TEST_TIMEOUT_MS = 10_000
const REJECTION_DEADLINE_MS = 3_000
const PI_STDIN_TEARDOWN_PUBLICATION_BOUND_MS = 500
const SAFE_REASON = 'C1.1_SAFE_REASON'
const FAKE_CREDENTIAL = 'sk-c11-unit-secret-0123456789'
const GLOBAL_SOURCE = 'global:extensions/pi-acp-failing-load/index.ts'

type FakePiFixture = {
  rootDir: string
  cwd: string
  agentDir: string
  sourcePath: string
  childPath: string
  piCommand: string
}

function posixQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

async function createFakePiFixture(): Promise<FakePiFixture> {
  const rootDir = await mkdtemp(join(tmpdir(), 'pi-acp-process-diagnostics-'))
  const cwd = join(rootDir, 'workspace')
  const agentDir = join(rootDir, 'agent')
  const sourcePath = join(agentDir, 'extensions', 'pi-acp-failing-load', 'index.ts')
  const childPath = join(rootDir, 'early-exit-child.mjs')
  const piCommand = join(rootDir, process.platform === 'win32' ? 'fake-pi.cmd' : 'fake-pi')

  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(join(agentDir, 'extensions'), { recursive: true })])
  await writeFile(
    childPath,
    `import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, createReadStream, existsSync, writeSync } from 'node:fs'
import { join } from 'node:path'

const run = async () => {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? ''
  const sourcePath = join(agentDir, 'extensions', 'pi-acp-failing-load', 'index.ts')
  const credential = process.env.OPENAI_API_KEY ?? ''

  if (
    process.env.PI_ACP_PROCESS_MODE === 'handshake-reject' ||
    process.env.PI_ACP_PROCESS_MODE === 'handshake-missing-state'
  ) {
    const marker = process.env.PI_ACP_CLEANUP_MARKER ?? ''
    let recorded = false
    const recordCleanup = () => {
      if (recorded) return
      recorded = true
      if (marker) appendFileSync(marker, 'cleanup\\n')
      process.exit(0)
    }
    process.stdin.once('end', recordCleanup)
    process.on('SIGTERM', recordCleanup)
    const chunk = await new Promise(resolve => process.stdin.once('data', resolve))
    const request = JSON.parse(String(chunk).trim().split('\\n')[0])
    const response =
      process.env.PI_ACP_PROCESS_MODE === 'handshake-reject'
        ? { type: 'response', id: request.id, command: 'get_state', success: false, error: 'state rejected' }
        : { type: 'response', id: request.id, command: 'get_state', success: true }
    writeSync(1, JSON.stringify(response) + '\\n')
    process.stdin.resume()
    await new Promise(() => {})
  }

  if (
    process.argv.includes('--runtime-term-resistant') ||
    process.env.PI_ACP_PROCESS_MODE === 'runtime-term-resistant'
  ) {
    process.on('SIGTERM', () => {})
    process.stdin.resume()
    await new Promise((resolve, reject) => {
      process.stdout.write('RUNTIME_TERM_RESISTANT_READY\\n', error =>
        error ? reject(error) : resolve()
      )
    })
    setInterval(() => {}, 1_000)
    await new Promise(() => {})
  }

  if (
    process.argv.includes('--runtime-stdout-eof') ||
    process.env.PI_ACP_PROCESS_MODE === 'startup-stdout-eof'
  ) {
    process.on('SIGTERM', () => {})
    process.stdin.resume()
    process.stdout.end()
    setInterval(() => {}, 1_000)
    await new Promise(() => {})
  }

  if (process.argv.includes('--runtime-buffered-exit')) {
    await new Promise(resolve => process.stdin.once('data', resolve))
    writeSync(1, '{"type":"agent_settled"}\\n')
    process.exit(37)
  }

  if (process.argv.includes('--runtime-late-event')) {
    process.on('SIGTERM', () => {})
    process.stdin.resume()
    await new Promise((resolve, reject) => {
      process.stdout.write('RUNTIME_LATE_EVENT_READY\\n', error =>
        error ? reject(error) : resolve()
      )
    })
    setTimeout(() => writeSync(1, '{"type":"agent_settled","late":true}\\n'), 150)
    setInterval(() => {}, 1_000)
    await new Promise(() => {})
  }

  if (process.argv.includes('--close-stdin-upgrade-late-stderr')) {
    const triggerPath = process.env.PI_ACP_LATE_STDERR_TRIGGER ?? ''
    const lateStderrCode = [
      "const { existsSync } = require('node:fs')",
      'const trigger = process.argv[1]',
      'const deadline = Date.now() + 1_000',
      'const timer = setInterval(() => { if (existsSync(trigger)) { clearInterval(timer); process.exit(0) } if (Date.now() >= deadline) process.exit(2) }, 2)'
    ].join('; ')
    const lateStderr = spawn(process.execPath, ['-e', lateStderrCode, triggerPath], {
      stdio: ['ignore', 'ignore', 2]
    })
    lateStderr.unref()
    const control = createReadStream('', { fd: 3, autoClose: false })
    control.once('data', message => {
      if (String(message).trim() === 'EXIT_23') process.exit(23)
    })
    control.resume()
    closeSync(0)
    await new Promise((resolve, reject) => {
      process.stdout.write('STDIN_CLOSED_UPGRADE_LATE_STDERR\\n', error =>
        error ? reject(error) : resolve()
      )
    })
    await new Promise(() => {})
  }

  if (process.argv.includes('--close-stdin-silent')) {
    process.on('SIGTERM', () => {})
    closeSync(0)
    await new Promise((resolve, reject) => {
      process.stdout.write('STDIN_CLOSED_SILENT\\n', error => (error ? reject(error) : resolve()))
    })
    setInterval(() => {}, 1_000)
    await new Promise(() => {})
  }

  if (process.argv.includes('--close-stdin-late-exit')) {
    const control = createReadStream('', { fd: 3, autoClose: false })
    control.once('data', message => {
      if (String(message).trim() !== 'EXIT_19') return
      writeSync(2, 'GENERIC_LATE_EXIT\\n')
      process.exit(19)
    })
    control.resume()
    closeSync(0)
    await new Promise((resolve, reject) => {
      process.stdout.write('STDIN_CLOSED_LATE_EXIT\\n', error => (error ? reject(error) : resolve()))
    })
    await new Promise(() => {})
  }

  if (process.argv.includes('--close-stdin')) {
    process.on('SIGTERM', () => {})
    closeSync(0)
    // Publish the fixture diagnostic before readiness. The pipe retains these
    // bytes until PiRpcProcess attaches its capture listener, avoiding a child
    // timer race against the frozen 100ms stderr publication cut.
    await new Promise((resolve, reject) => {
      process.stderr.write(
        '\\nFailed to load extension "' + sourcePath + '":\\nreason=${SAFE_REASON}\\n',
        error => (error ? reject(error) : resolve())
      )
    })
    await new Promise((resolve, reject) => {
      process.stdout.write('STDIN_CLOSED\\n', error => (error ? reject(error) : resolve()))
    })
    setInterval(() => {}, 1_000)
    await new Promise(() => {})
  }

  await new Promise(resolve => process.stdin.once('data', resolve))
  const prefix = '\\n\\u001b[31mFailed to load extension "' + sourcePath + '": '
  await new Promise((resolve, reject) => {
    process.stderr.write(prefix, error => (error ? reject(error) : resolve()))
  })
  await new Promise((resolve, reject) => {
    process.stderr.write(Buffer.alloc(72 * 1024, 0x78), error => (error ? reject(error) : resolve()))
  })
  const diagnostic = [
    '\\nreason=${SAFE_REASON} authorization: Bearer ',
    credential,
    ' token=',
    credential,
    ' \\u001b]8;;file://',
    sourcePath,
    '\\u0007unsafe-link\\u001b]8;;\\u0007 \\u202eBIDI\\u0000\\u001b[0m\\n'
  ].join('')
  await new Promise((resolve, reject) => {
    process.stderr.write(diagnostic, error => (error ? reject(error) : resolve()))
  })
  process.exit(17)
}

void run()
`,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 }
  )

  if (process.platform === 'win32') {
    await writeFile(piCommand, `@"${process.execPath}" "${childPath}" %*\r\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o700
    })
  } else {
    await writeFile(piCommand, `#!/bin/sh\nexec ${posixQuote(process.execPath)} ${posixQuote(childPath)} "$@"\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o700
    })
    await chmod(piCommand, 0o700)
  }

  return { rootDir, cwd, agentDir, sourcePath, childPath, piCommand }
}

function setFixtureEnvironment(t: test.TestContext, fixture: FakePiFixture): void {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  const previousCredential = process.env.OPENAI_API_KEY
  process.env.PI_CODING_AGENT_DIR = fixture.agentDir
  process.env.OPENAI_API_KEY = FAKE_CREDENTIAL

  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    if (previousCredential === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousCredential
  })
}

async function withDeadline<T>(promise: Promise<T>, deadlineMs = REJECTION_DEADLINE_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`operation did not reject within ${String(deadlineMs)}ms`)),
          deadlineMs
        )
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function latchStderrDrainCall(proc: PiRpcProcess, targetCall: number): { started: Promise<void>; calls: () => number } {
  const internal = proc as unknown as { waitForStderrDrain: () => Promise<void> }
  const original = internal.waitForStderrDrain.bind(proc)
  let calls = 0
  let markStarted!: () => void
  const started = new Promise<void>(resolve => {
    markStarted = resolve
  })

  internal.waitForStderrDrain = async () => {
    calls += 1
    if (calls === targetCall) markStarted()
    await original()
  }

  return { started, calls: () => calls }
}

async function writeChildControl(child: ChildProcessWithoutNullStreams, message: string): Promise<void> {
  const control = child.stdio[3] as NodeJS.WritableStream | null
  assert.ok(control)
  await new Promise<void>((resolve, reject) => {
    control.write(`${message}\n`, error => (error ? reject(error) : resolve()))
  })
}

function assertSafeDiagnostic(diagnostic: Readonly<PiStartupDiagnostic>, fixture: FakePiFixture): void {
  assert.equal(diagnostic.schemaVersion, 1)
  assert.equal(diagnostic.code, 'PI_EXTENSION_LOAD_FAILED')
  assert.equal(diagnostic.phase, 'startup')
  assert.equal(diagnostic.source, GLOBAL_SOURCE)
  assert.equal(diagnostic.stderrLimitBytes, PI_STARTUP_STDERR_LIMIT_BYTES)
  assert.equal(diagnostic.summaryLimitBytes, PI_STARTUP_SUMMARY_LIMIT_BYTES)
  assert.equal(diagnostic.truncated, true)
  assert.equal(diagnostic.redacted, true)
  assert.ok(Buffer.byteLength(diagnostic.summary, 'utf8') <= PI_STARTUP_SUMMARY_LIMIT_BYTES)
  assert.match(diagnostic.summary, /C1\.1_SAFE_REASON/u)
  assert.match(diagnostic.summary, /global:extensions\/pi-acp-failing-load\/index\.ts/u)
  assert.match(diagnostic.summary, /\[REDACTED\]/u)
  for (const unsafeControl of ['\u001b', '\u0000', '\u202e']) {
    assert.equal(diagnostic.summary.includes(unsafeControl), false)
  }
  assert.doesNotMatch(diagnostic.summary, /authorization:\s*Bearer\s+[^[]/iu)
  assert.equal(diagnostic.summary.includes(FAKE_CREDENTIAL), false)
  assert.equal(diagnostic.summary.includes(fixture.rootDir), false)
  assert.equal(diagnostic.summary.includes(fixture.agentDir), false)
  assert.equal(diagnostic.summary.includes(fixture.sourcePath), false)
  assert.equal(diagnostic.summary.includes(fixture.childPath), false)
}

function assertSafeErrorText(error: Error, fixture: FakePiFixture): void {
  assert.ok(Buffer.byteLength(error.message, 'utf8') <= PI_STARTUP_SUMMARY_LIMIT_BYTES)
  assert.match(error.message, /C1\.1_SAFE_REASON/u)
  assert.match(error.message, /global:extensions\/pi-acp-failing-load\/index\.ts/u)
  assert.doesNotMatch(error.message, /EPIPE|ERR_STREAM_DESTROYED|Cannot call write after a stream was destroyed/u)
  assert.equal(error.message.includes(FAKE_CREDENTIAL), false)
  assert.equal(error.message.includes(fixture.rootDir), false)
  assert.equal(error.message.includes(fixture.agentDir), false)
  assert.equal(error.message.includes(fixture.sourcePath), false)
  assert.equal(error.message.includes(fixture.childPath), false)
}

async function waitForStdoutText(child: ChildProcessWithoutNullStreams, expected: string): Promise<void> {
  let output = ''
  await withDeadline(
    new Promise<void>((resolve, reject) => {
      const onData = (chunk: Buffer): void => {
        output += chunk.toString('utf8')
        if (!output.includes(expected)) return
        cleanup()
        resolve()
      }
      const onError = (error: Error): void => {
        cleanup()
        reject(error)
      }
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        cleanup()
        reject(new Error(`child exited before readiness (code=${String(code)}, signal=${String(signal)})`))
      }
      const cleanup = (): void => {
        child.stdout.off('data', onData)
        child.off('error', onError)
        child.off('exit', onExit)
      }

      child.stdout.on('data', onData)
      child.once('error', onError)
      child.once('exit', onExit)
    })
  )
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ESRCH') return false
    throw error
  }
}

function createRuntimeProcess(child: ChildProcessWithoutNullStreams, fixture: FakePiFixture): PiRpcProcess {
  const PiRpcProcessForTest = PiRpcProcess as unknown as new (
    child: ChildProcessWithoutNullStreams,
    options: { cwd: string; agentDir: string; env: Readonly<NodeJS.ProcessEnv> }
  ) => PiRpcProcess
  const proc = new PiRpcProcessForTest(child, {
    cwd: fixture.cwd,
    agentDir: fixture.agentDir,
    env: process.env
  })
  ;(proc as unknown as { startupComplete: boolean }).startupComplete = true
  return proc
}

test(
  'PiRpcProcess.spawn rejects an early Pi extension load failure with one bounded safe diagnostic',
  { timeout: TEST_TIMEOUT_MS },
  async t => {
    const fixture = await createFakePiFixture()
    t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
    setFixtureEnvironment(t, fixture)

    const startedAt = Date.now()
    await assert.rejects(
      withDeadline(PiRpcProcess.spawn({ cwd: fixture.cwd, piCommand: fixture.piCommand })),
      (error: unknown) => {
        assert.ok(error instanceof PiRpcSpawnError)
        assert.equal(error.code, 'PI_EXTENSION_LOAD_FAILED')
        assert.equal(error.candidate, undefined)
        assert.ok(error.diagnostic)
        assertSafeDiagnostic(error.diagnostic, fixture)
        assertSafeErrorText(error, fixture)
        return true
      }
    )
    assert.ok(Date.now() - startedAt < REJECTION_DEADLINE_MS)
  }
)

test('PiRpcProcess.spawn supports an opt-in bounded restore handshake', { timeout: TEST_TIMEOUT_MS }, async t => {
  const fixture = await createFakePiFixture()
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
  setFixtureEnvironment(t, fixture)
  const previousMode = process.env.PI_ACP_PROCESS_MODE
  process.env.PI_ACP_PROCESS_MODE = 'runtime-term-resistant'
  t.after(() => {
    if (previousMode === undefined) delete process.env.PI_ACP_PROCESS_MODE
    else process.env.PI_ACP_PROCESS_MODE = previousMode
  })

  const startedAt = Date.now()
  await assert.rejects(
    withDeadline(
      PiRpcProcess.spawn({
        cwd: fixture.cwd,
        piCommand: fixture.piCommand,
        handshakeTimeoutMs: 50
      })
    ),
    (error: unknown) => {
      assert.ok(error instanceof PiRpcSpawnError)
      assert.equal(error.code, PI_RPC_HANDSHAKE_TIMEOUT_CODE)
      assert.equal(error.message, 'Pi RPC startup handshake timed out before get_state completed.')
      return true
    }
  )
  assert.ok(Date.now() - startedAt < REJECTION_DEADLINE_MS)
})

test('PiRpcProcess.spawn requires a successful state in timeout mode and cleans each failure once', async t => {
  for (const mode of ['handshake-reject', 'handshake-missing-state'] as const) {
    await t.test(mode, async st => {
      const fixture = await createFakePiFixture()
      st.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
      setFixtureEnvironment(st, fixture)
      const marker = join(fixture.rootDir, `${mode}.cleanup`)
      const previousMode = process.env.PI_ACP_PROCESS_MODE
      const previousMarker = process.env.PI_ACP_CLEANUP_MARKER
      process.env.PI_ACP_PROCESS_MODE = mode
      process.env.PI_ACP_CLEANUP_MARKER = marker
      st.after(() => {
        if (previousMode === undefined) delete process.env.PI_ACP_PROCESS_MODE
        else process.env.PI_ACP_PROCESS_MODE = previousMode
        if (previousMarker === undefined) delete process.env.PI_ACP_CLEANUP_MARKER
        else process.env.PI_ACP_CLEANUP_MARKER = previousMarker
      })

      await assert.rejects(
        withDeadline(
          PiRpcProcess.spawn({
            cwd: fixture.cwd,
            piCommand: fixture.piCommand,
            handshakeTimeoutMs: 1_500
          })
        ),
        (error: unknown) => {
          assert.ok(error instanceof PiRpcSpawnError)
          assert.equal(error.code, PI_RPC_HANDSHAKE_FAILED_CODE)
          assert.equal(error.candidate, undefined)
          return true
        }
      )
      assert.equal(readFileSync(marker, 'utf8'), 'cleanup\n')
    })
  }
})

test('PiRpcProcess.spawn keeps legacy best-effort state rejection without a timeout mode', async t => {
  const fixture = await createFakePiFixture()
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
  setFixtureEnvironment(t, fixture)
  const marker = join(fixture.rootDir, 'default-handshake.cleanup')
  const previousMode = process.env.PI_ACP_PROCESS_MODE
  const previousMarker = process.env.PI_ACP_CLEANUP_MARKER
  process.env.PI_ACP_PROCESS_MODE = 'handshake-reject'
  process.env.PI_ACP_CLEANUP_MARKER = marker
  t.after(() => {
    if (previousMode === undefined) delete process.env.PI_ACP_PROCESS_MODE
    else process.env.PI_ACP_PROCESS_MODE = previousMode
    if (previousMarker === undefined) delete process.env.PI_ACP_CLEANUP_MARKER
    else process.env.PI_ACP_CLEANUP_MARKER = previousMarker
  })

  const proc = await withDeadline(PiRpcProcess.spawn({ cwd: fixture.cwd, piCommand: fixture.piCommand }))
  assert.equal(proc.getStartupHandshakeState(), undefined)
  assert.equal(hostExistsSync(marker), false)
  await withDeadline(proc.stop())
  assert.equal(readFileSync(marker, 'utf8'), 'cleanup\n')
})

test('PiRpcProcess.spawn returns an unconfirmed timeout candidate for cleanup retry', async t => {
  const fixture = await createFakePiFixture()
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
  setFixtureEnvironment(t, fixture)
  const previousMode = process.env.PI_ACP_PROCESS_MODE
  process.env.PI_ACP_PROCESS_MODE = 'runtime-term-resistant'
  t.after(() => {
    if (previousMode === undefined) delete process.env.PI_ACP_PROCESS_MODE
    else process.env.PI_ACP_PROCESS_MODE = previousMode
  })

  const originalKill = ChildProcess.prototype.kill
  let timeoutError: PiRpcSpawnError | undefined
  ChildProcess.prototype.kill = function () {
    return true
  }
  try {
    await assert.rejects(
      withDeadline(
        PiRpcProcess.spawn({
          cwd: fixture.cwd,
          piCommand: fixture.piCommand,
          handshakeTimeoutMs: 50
        })
      ),
      (error: unknown) => {
        assert.ok(error instanceof PiRpcSpawnError)
        timeoutError = error
        assert.equal(error.code, PI_RPC_HANDSHAKE_TIMEOUT_CODE)
        assert.ok(error.candidate)
        assert.equal(Object.keys(error).includes('candidate'), false)
        return true
      }
    )
  } finally {
    ChildProcess.prototype.kill = originalKill
  }

  assert.ok(timeoutError?.candidate)
  assert.equal(timeoutError.candidate.isAlive(), false)
  await withDeadline(timeoutError.candidate.stop())
})

test('PiRpcProcess.spawn retains an unconfirmed diagnostic candidate after stdout closes', async t => {
  const fixture = await createFakePiFixture()
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
  setFixtureEnvironment(t, fixture)
  const previousMode = process.env.PI_ACP_PROCESS_MODE
  process.env.PI_ACP_PROCESS_MODE = 'startup-stdout-eof'
  t.after(() => {
    if (previousMode === undefined) delete process.env.PI_ACP_PROCESS_MODE
    else process.env.PI_ACP_PROCESS_MODE = previousMode
  })

  const originalKill = ChildProcess.prototype.kill
  let spawnError: PiRpcSpawnError | undefined
  ChildProcess.prototype.kill = function () {
    return true
  }
  try {
    await assert.rejects(
      withDeadline(PiRpcProcess.spawn({ cwd: fixture.cwd, piCommand: fixture.piCommand })),
      (error: unknown) => {
        assert.ok(error instanceof PiRpcSpawnError)
        spawnError = error
        assert.equal(error.code, 'PI_STARTUP_FAILED')
        assert.equal(error.diagnostic?.code, 'PI_STARTUP_FAILED')
        assert.ok(error.candidate)
        assert.equal(Object.keys(error).includes('candidate'), false)
        return true
      }
    )
    assert.ok(spawnError?.candidate)
    await assert.rejects(withDeadline(spawnError.candidate.stop()), PiRpcProcessCleanupError)
  } finally {
    ChildProcess.prototype.kill = originalKill
  }

  assert.ok(spawnError?.candidate)
  await withDeadline(spawnError.candidate.stop())
})

test(
  'PiRpcProcess preserves the same startup diagnostic for a pending request and a later request',
  { timeout: TEST_TIMEOUT_MS },
  async t => {
    const fixture = await createFakePiFixture()
    t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
    setFixtureEnvironment(t, fixture)

    const child = spawn(process.execPath, [fixture.childPath], {
      cwd: fixture.cwd,
      env: process.env,
      stdio: 'pipe'
    }) as ChildProcessWithoutNullStreams
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    })

    const PiRpcProcessForTest = PiRpcProcess as unknown as new (
      child: ChildProcessWithoutNullStreams,
      options: { cwd: string; agentDir: string; env: Readonly<NodeJS.ProcessEnv> }
    ) => PiRpcProcess
    const proc = new PiRpcProcessForTest(child, {
      cwd: fixture.cwd,
      agentDir: fixture.agentDir,
      env: process.env
    })
    const pending = proc.getState()

    let pendingError: PiRpcProcessTerminatedError | undefined
    await assert.rejects(withDeadline(pending), (error: unknown) => {
      assert.ok(error instanceof PiRpcProcessTerminatedError)
      pendingError = error
      assert.ok(error.diagnostic)
      assertSafeDiagnostic(error.diagnostic, fixture)
      assertSafeErrorText(error, fixture)
      return true
    })

    await assert.rejects(withDeadline(proc.getState()), (error: unknown) => {
      assert.ok(error instanceof PiRpcProcessTerminatedError)
      assert.equal(error, pendingError)
      assert.ok(error.diagnostic)
      assertSafeDiagnostic(error.diagnostic, fixture)
      assertSafeErrorText(error, fixture)
      return true
    })
  }
)

test(
  'PiRpcProcess owns stdin EPIPE, caches its causal error, and tears down a live child',
  { timeout: TEST_TIMEOUT_MS },
  async t => {
    const fixture = await createFakePiFixture()
    t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
    setFixtureEnvironment(t, fixture)

    const child = spawn(process.execPath, [fixture.childPath, '--close-stdin'], {
      cwd: fixture.cwd,
      env: process.env,
      stdio: 'pipe'
    }) as ChildProcessWithoutNullStreams
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    })
    await waitForStdoutText(child, 'STDIN_CLOSED\n')
    const pid = child.pid
    assert.ok(pid)

    const PiRpcProcessForTest = PiRpcProcess as unknown as new (
      child: ChildProcessWithoutNullStreams,
      options: { cwd: string; agentDir: string; env: Readonly<NodeJS.ProcessEnv> }
    ) => PiRpcProcess
    const proc = new PiRpcProcessForTest(child, {
      cwd: fixture.cwd,
      agentDir: fixture.agentDir,
      env: process.env
    })

    const startedAt = Date.now()
    let pendingError: PiRpcProcessTerminatedError | undefined
    await assert.rejects(withDeadline(proc.getState()), (error: unknown) => {
      assert.ok(error instanceof PiRpcProcessTerminatedError)
      pendingError = error
      assert.ok(error.diagnostic)
      assert.equal(error.diagnostic.code, 'PI_EXTENSION_LOAD_FAILED')
      assert.equal(error.diagnostic.source, GLOBAL_SOURCE)
      assert.match(error.diagnostic.summary, /C1\.1_SAFE_REASON/u)
      assertSafeErrorText(error, fixture)
      return true
    })
    assert.ok(Date.now() - startedAt < REJECTION_DEADLINE_MS)

    await assert.rejects(withDeadline(proc.getState()), (error: unknown) => {
      assert.ok(error instanceof PiRpcProcessTerminatedError)
      assert.equal(error, pendingError)
      return true
    })

    await withDeadline(proc.stop())
    assert.equal(child.exitCode !== null || child.signalCode !== null, true)
    assert.equal(isProcessAlive(pid), false)
    assert.equal(child.stdin.listenerCount('error'), 0)
  }
)

test(
  'PiRpcProcess upgrades provisional stdin EPIPE to a real exit during stderr drain',
  { timeout: TEST_TIMEOUT_MS },
  async t => {
    const fixture = await createFakePiFixture()
    t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
    setFixtureEnvironment(t, fixture)

    const child = spawn(process.execPath, [fixture.childPath, '--close-stdin-late-exit'], {
      cwd: fixture.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe']
    }) as ChildProcessWithoutNullStreams
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    })
    await waitForStdoutText(child, 'STDIN_CLOSED_LATE_EXIT\n')
    const pid = child.pid
    assert.ok(pid)

    const PiRpcProcessForTest = PiRpcProcess as unknown as new (
      child: ChildProcessWithoutNullStreams,
      options: { cwd: string; agentDir: string; env: Readonly<NodeJS.ProcessEnv> }
    ) => PiRpcProcess
    const proc = new PiRpcProcessForTest(child, {
      cwd: fixture.cwd,
      agentDir: fixture.agentDir,
      env: process.env
    })
    const firstDrain = latchStderrDrainCall(proc, 1)

    let pendingError: PiRpcProcessTerminatedError | undefined
    const pending = proc.getState()
    await withDeadline(firstDrain.started)
    await withDeadline(writeChildControl(child, 'EXIT_19'))
    await assert.rejects(withDeadline(pending), (error: unknown) => {
      assert.ok(error instanceof PiRpcProcessTerminatedError)
      pendingError = error
      assert.ok(error.diagnostic)
      assert.equal(error.diagnostic.code, 'PI_STARTUP_FAILED')
      assert.equal(error.diagnostic.source, 'unknown')
      assert.match(error.diagnostic.summary, /code=19/u)
      assert.match(error.diagnostic.summary, /GENERIC_LATE_EXIT/u)
      assert.equal(error.diagnostic.summary.includes('EPIPE'), false)
      assert.equal(error.message.includes('EPIPE'), false)
      return true
    })
    assert.equal(firstDrain.calls() >= 1, true)

    await assert.rejects(withDeadline(proc.getState()), (error: unknown) => {
      assert.ok(error instanceof PiRpcProcessTerminatedError)
      assert.equal(error, pendingError)
      return true
    })

    await withDeadline(proc.stop())
    assert.equal(child.exitCode, 19)
    assert.equal(isProcessAlive(pid), false)
    assert.equal(child.stdin.listenerCount('error'), 0)
  }
)

test('PiRpcProcess gives an upgraded real exit its own bounded stderr drain', { timeout: TEST_TIMEOUT_MS }, async t => {
  const fixture = await createFakePiFixture()
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
  setFixtureEnvironment(t, fixture)
  const stderrTriggerPath = join(fixture.rootDir, 'late-stderr.trigger')

  const child = spawn(process.execPath, [fixture.childPath, '--close-stdin-upgrade-late-stderr'], {
    cwd: fixture.cwd,
    env: {
      ...process.env,
      PI_ACP_LATE_STDERR_TRIGGER: stderrTriggerPath
    },
    stdio: ['pipe', 'pipe', 'pipe', 'pipe']
  }) as ChildProcessWithoutNullStreams
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })
  await waitForStdoutText(child, 'STDIN_CLOSED_UPGRADE_LATE_STDERR\n')
  const pid = child.pid
  assert.ok(pid)

  const PiRpcProcessForTest = PiRpcProcess as unknown as new (
    child: ChildProcessWithoutNullStreams,
    options: { cwd: string; agentDir: string; env: Readonly<NodeJS.ProcessEnv> }
  ) => PiRpcProcess
  const proc = new PiRpcProcessForTest(child, {
    cwd: fixture.cwd,
    agentDir: fixture.agentDir,
    env: process.env
  })
  const firstDrain = latchStderrDrainCall(proc, 1)
  const secondDrain = latchStderrDrainCall(proc, 2)

  const exitObserved = new Promise<void>((resolve, reject) => {
    child.once('exit', code => {
      try {
        assert.equal(code, 23)
        resolve()
      } catch (error) {
        reject(error)
      }
    })
  })
  const startedAt = Date.now()
  const pending = proc.getState()
  await withDeadline(firstDrain.started)
  await withDeadline(writeChildControl(child, 'EXIT_23'))
  await withDeadline(exitObserved)
  // Inject only after the instrumented second drain has actually begun. This
  // fails if upgraded exits do not receive their own bounded stderr phase.
  await withDeadline(secondDrain.started)
  child.stderr.emit('data', Buffer.from('POST_UPGRADE_STDERR\n'))
  writeFileSync(stderrTriggerPath, 'go', { encoding: 'utf8', flag: 'wx', mode: 0o600 })

  let pendingError: PiRpcProcessTerminatedError | undefined
  await assert.rejects(withDeadline(pending), (error: unknown) => {
    assert.ok(error instanceof PiRpcProcessTerminatedError)
    pendingError = error
    assert.ok(error.diagnostic)
    assert.equal(error.diagnostic.code, 'PI_STARTUP_FAILED')
    assert.equal(error.diagnostic.source, 'unknown')
    assert.match(error.diagnostic.summary, /code=23/u)
    assert.match(error.diagnostic.summary, /POST_UPGRADE_STDERR/u)
    assert.equal(error.diagnostic.summary.includes('EPIPE'), false)
    return true
  })
  assert.equal(secondDrain.calls(), 2)
  assert.ok(Date.now() - startedAt < REJECTION_DEADLINE_MS)

  await assert.rejects(withDeadline(proc.getState()), (error: unknown) => {
    assert.ok(error instanceof PiRpcProcessTerminatedError)
    assert.equal(error, pendingError)
    return true
  })

  await withDeadline(proc.stop())
  assert.equal(child.exitCode, 23)
  assert.equal(isProcessAlive(pid), false)
  assert.equal(child.stdin.listenerCount('error'), 0)
})

test(
  'PiRpcProcess omits provisional stdin transport codes for a silent live child',
  { timeout: TEST_TIMEOUT_MS },
  async t => {
    const fixture = await createFakePiFixture()
    t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
    setFixtureEnvironment(t, fixture)

    const child = spawn(process.execPath, [fixture.childPath, '--close-stdin-silent'], {
      cwd: fixture.cwd,
      env: process.env,
      stdio: 'pipe'
    }) as ChildProcessWithoutNullStreams
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    })
    await waitForStdoutText(child, 'STDIN_CLOSED_SILENT\n')
    const pid = child.pid
    assert.ok(pid)

    const PiRpcProcessForTest = PiRpcProcess as unknown as new (
      child: ChildProcessWithoutNullStreams,
      options: { cwd: string; agentDir: string; env: Readonly<NodeJS.ProcessEnv> }
    ) => PiRpcProcess
    const proc = new PiRpcProcessForTest(child, {
      cwd: fixture.cwd,
      agentDir: fixture.agentDir,
      env: process.env
    })

    const startedAt = Date.now()
    let pendingError: PiRpcProcessTerminatedError | undefined
    await assert.rejects(withDeadline(proc.getState()), (error: unknown) => {
      assert.ok(error instanceof PiRpcProcessTerminatedError)
      pendingError = error
      assert.ok(error.diagnostic)
      assert.equal(error.diagnostic.code, 'PI_STARTUP_FAILED')
      assert.equal(error.diagnostic.source, 'unknown')
      for (const transportCode of ['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_INVALID_STATE']) {
        assert.equal(error.diagnostic.summary.includes(transportCode), false)
        assert.equal(error.message.includes(transportCode), false)
      }
      return true
    })
    assert.ok(Date.now() - startedAt < REJECTION_DEADLINE_MS)

    await assert.rejects(withDeadline(proc.getState()), (error: unknown) => {
      assert.ok(error instanceof PiRpcProcessTerminatedError)
      assert.equal(error, pendingError)
      return true
    })

    await withDeadline(proc.stop())
    assert.equal(child.exitCode !== null || child.signalCode !== null, true)
    assert.equal(isProcessAlive(pid), false)
    assert.equal(child.stdin.listenerCount('error'), 0)
  }
)

test('PiRpcProcess publishes one replay-safe runtime terminal record and fences later writes', async t => {
  const fixture = await createFakePiFixture()
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
  setFixtureEnvironment(t, fixture)

  const child = spawn(process.execPath, [fixture.childPath], {
    cwd: fixture.cwd,
    env: process.env,
    stdio: 'pipe'
  }) as ChildProcessWithoutNullStreams
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })
  const proc = createRuntimeProcess(child, fixture)

  const stdin = child.stdin as any
  const originalWrite = stdin.write.bind(child.stdin)
  let writeCount = 0
  stdin.write = (...args: unknown[]) => {
    writeCount += 1
    return originalWrite(...args)
  }

  const observed: PiRpcProcessTerminatedError[] = []
  proc.onTerminal(error => observed.push(error))
  const results = await withDeadline(Promise.allSettled([proc.getState(), proc.getMessages()]))
  assert.equal(results[0]?.status, 'rejected')
  assert.equal(results[1]?.status, 'rejected')
  const firstError = (results[0] as PromiseRejectedResult).reason
  const secondError = (results[1] as PromiseRejectedResult).reason
  assert.ok(firstError instanceof PiRpcProcessTerminatedError)
  assert.equal(secondError, firstError)
  assert.equal(observed.length, 1)
  assert.equal(observed[0], firstError)
  assert.equal(firstError.code, PI_RPC_PROCESS_TERMINATED_CODE)
  assert.equal(piRpcProcessTerminatedErrorData(firstError), firstError.data)
  assert.equal(firstError.data.code, PI_RPC_PROCESS_TERMINATED_CODE)
  assert.equal(firstError.data.piAcp.process.state, 'terminated')
  assert.equal(firstError.data.piAcp.recovery.automaticReplay, false)
  assert.equal(Object.isFrozen(firstError.data), true)
  assert.equal(Object.isFrozen(firstError.data.piAcp), true)
  assert.equal(Object.isFrozen(firstError.data.piAcp.process), true)
  assert.equal((proc as unknown as { pending: Map<string, unknown> }).pending.size, 0)
  assert.equal(proc.isAlive(), false)

  const terminalWriteCount = writeCount
  await assert.rejects(withDeadline(proc.getState()), error => error === firstError)
  assert.equal(writeCount, terminalWriteCount)

  let replayed: PiRpcProcessTerminatedError | undefined
  proc.onTerminal(error => {
    replayed = error
  })
  await new Promise<void>(resolve => queueMicrotask(resolve))
  assert.equal(replayed, firstError)
  await withDeadline(proc.stop())
})

test('PiRpcProcess uses response-versus-terminal observation order and quarantines losing bytes', async t => {
  const fixture = await createFakePiFixture()
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
  setFixtureEnvironment(t, fixture)

  const runOrder = async (responseFirst: boolean): Promise<void> => {
    const child = spawn(process.execPath, [fixture.childPath, '--runtime-term-resistant'], {
      cwd: fixture.cwd,
      env: process.env,
      stdio: 'pipe'
    }) as ChildProcessWithoutNullStreams
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    })
    await waitForStdoutText(child, 'RUNTIME_TERM_RESISTANT_READY\n')
    const proc = createRuntimeProcess(child, fixture)
    let eventCount = 0
    proc.onEvent(() => {
      eventCount += 1
    })
    child.stdout.emit('data', Buffer.from('{"type":"response","id":"unknown","command":"get_state","success":true}\n'))
    assert.equal(eventCount, 0)

    let requestId = ''
    ;(child.stdin as any).write = (line: string, callback: (error?: Error | null) => void) => {
      requestId = String(JSON.parse(line).id)
      queueMicrotask(() => callback(null))
      return true
    }

    const pending = proc.getState()
    assert.notEqual(requestId, '')
    const response = `${JSON.stringify({
      type: 'response',
      id: requestId,
      command: 'get_state',
      success: true,
      data: { winner: 'response' }
    })}\n`

    if (responseFirst) {
      child.stdout.emit('data', Buffer.from(response))
      child.emit('exit', 41, null)
      assert.deepEqual(await withDeadline(pending), { winner: 'response' })
    } else {
      let terminalError: PiRpcProcessTerminatedError | undefined
      proc.onTerminal(error => {
        terminalError = error
      })
      child.emit('exit', 42, null)
      child.stdout.emit('data', Buffer.from(response))
      await assert.rejects(withDeadline(pending), error => {
        assert.equal(error, terminalError)
        return true
      })
    }

    await withDeadline(proc.stop())
  }

  await runOrder(true)
  await runOrder(false)
})

test('PiRpcProcess treats write(false) as backpressure and stop wins over a later request', async t => {
  const fixture = await createFakePiFixture()
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
  setFixtureEnvironment(t, fixture)

  const child = spawn(process.execPath, [fixture.childPath, '--runtime-term-resistant'], {
    cwd: fixture.cwd,
    env: process.env,
    stdio: 'pipe'
  }) as ChildProcessWithoutNullStreams
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })
  await waitForStdoutText(child, 'RUNTIME_TERM_RESISTANT_READY\n')
  const proc = createRuntimeProcess(child, fixture)

  let writeCount = 0
  let requestId = ''
  ;(child.stdin as any).write = (line: string, callback: (error?: Error | null) => void) => {
    writeCount += 1
    requestId = String(JSON.parse(line).id)
    queueMicrotask(() => callback(null))
    return false
  }

  const pending = proc.getState()
  child.stdout.emit(
    'data',
    Buffer.from(
      `${JSON.stringify({
        type: 'response',
        id: requestId,
        command: 'get_state',
        success: true,
        data: { backpressure: true }
      })}\n`
    )
  )
  assert.deepEqual(await withDeadline(pending), { backpressure: true })
  assert.equal(proc.isAlive(), true)

  const stop = proc.stop()
  assert.equal(proc.stop(), stop)
  const stoppedWriteCount = writeCount
  await assert.rejects(withDeadline(proc.getState()), PiRpcProcessTerminatedError)
  assert.equal(writeCount, stoppedWriteCount)
  await withDeadline(stop)
})

test('PiRpcProcess explicit stop rejects multiple raw pending requests with one error', async t => {
  const fixture = await createFakePiFixture()
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
  setFixtureEnvironment(t, fixture)

  const child = spawn(process.execPath, [fixture.childPath, '--runtime-term-resistant'], {
    cwd: fixture.cwd,
    env: process.env,
    stdio: 'pipe'
  }) as ChildProcessWithoutNullStreams
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })
  await waitForStdoutText(child, 'RUNTIME_TERM_RESISTANT_READY\n')
  const proc = createRuntimeProcess(child, fixture)

  const stdin = child.stdin as any
  const originalWrite = stdin.write.bind(child.stdin)
  let writeCount = 0
  stdin.write = (...args: unknown[]) => {
    writeCount += 1
    return originalWrite(...args)
  }

  let terminalError: PiRpcProcessTerminatedError | undefined
  proc.onTerminal(error => {
    terminalError = error
  })
  const first = proc.getState()
  const second = proc.getMessages()
  assert.equal(writeCount, 2)

  const stop = proc.stop()
  assert.equal((proc as unknown as { pending: Map<string, unknown> }).pending.size, 0)
  assert.ok(terminalError)
  const results = await withDeadline(Promise.allSettled([first, second]))
  assert.equal(results[0]?.status, 'rejected')
  assert.equal(results[1]?.status, 'rejected')
  assert.equal((results[0] as PromiseRejectedResult).reason, terminalError)
  assert.equal((results[1] as PromiseRejectedResult).reason, terminalError)

  const stoppedWriteCount = writeCount
  await assert.rejects(withDeadline(proc.getCommands()), error => error === terminalError)
  assert.equal(writeCount, stoppedWriteCount)
  await withDeadline(stop)
})

test('PiRpcProcess quarantines remaining same-line handlers after a synchronous stop', async t => {
  const fixture = await createFakePiFixture()
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
  setFixtureEnvironment(t, fixture)

  const child = spawn(process.execPath, [fixture.childPath, '--runtime-term-resistant'], {
    cwd: fixture.cwd,
    env: process.env,
    stdio: 'pipe'
  }) as ChildProcessWithoutNullStreams
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })
  await waitForStdoutText(child, 'RUNTIME_TERM_RESISTANT_READY\n')
  const proc = createRuntimeProcess(child, fixture)

  let stoppingHandlerCalls = 0
  let postTerminalHandlerCalls = 0
  let stopPromise: Promise<void> | undefined
  proc.onEvent(() => {
    stoppingHandlerCalls += 1
    stopPromise = proc.stop()
    void stopPromise.catch(() => undefined)
  })
  proc.onEvent(() => {
    postTerminalHandlerCalls += 1
  })

  child.stdout.emit('data', Buffer.from('{"type":"agent_start"}\n'))

  assert.equal(stoppingHandlerCalls, 1)
  assert.equal(postTerminalHandlerCalls, 0)
  assert.equal(proc.isAlive(), false)
  assert.ok(stopPromise)
  await withDeadline(stopPromise)
})

test('PiRpcProcess quarantines events after an arbitrary stdin write failure', async t => {
  const fixture = await createFakePiFixture()
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
  setFixtureEnvironment(t, fixture)

  const child = spawn(process.execPath, [fixture.childPath, '--runtime-late-event'], {
    cwd: fixture.cwd,
    env: process.env,
    stdio: 'pipe'
  }) as ChildProcessWithoutNullStreams
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })
  await waitForStdoutText(child, 'RUNTIME_LATE_EVENT_READY\n')
  const proc = createRuntimeProcess(child, fixture)

  let eventCount = 0
  proc.onEvent(() => {
    eventCount += 1
  })
  ;(child.stdin as any).write = (_line: string, callback: (error?: Error | null) => void) => {
    queueMicrotask(() => callback(Object.assign(new Error('unsafe transport detail'), { code: 'EIO' })))
    return true
  }

  let terminalError: PiRpcProcessTerminatedError | undefined
  await assert.rejects(withDeadline(proc.getState()), error => {
    assert.ok(error instanceof PiRpcProcessTerminatedError)
    terminalError = error
    assert.equal(error.data.piAcp.process.cause, 'stdin_write_failure')
    assert.equal(error.message.includes('unsafe transport detail'), false)
    assert.equal(JSON.stringify(error.data).includes('EIO'), false)
    return true
  })
  await new Promise(resolve => setTimeout(resolve, 225))
  assert.equal(eventCount, 0)
  await assert.rejects(withDeadline(proc.getMessages()), error => error === terminalError)
  await withDeadline(proc.stop())
})

test('PiRpcProcess treats stdout EOF as terminal without waiting for teardown', async t => {
  const fixture = await createFakePiFixture()
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
  setFixtureEnvironment(t, fixture)

  const child = spawn(process.execPath, [fixture.childPath, '--runtime-stdout-eof'], {
    cwd: fixture.cwd,
    env: process.env,
    stdio: 'pipe'
  }) as ChildProcessWithoutNullStreams
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })
  const proc = createRuntimeProcess(child, fixture)
  const startedAt = Date.now()
  await assert.rejects(withDeadline(proc.getState()), error => {
    assert.ok(error instanceof PiRpcProcessTerminatedError)
    assert.equal(error.data.piAcp.process.cause, 'stdout_eof')
    return true
  })
  assert.ok(Date.now() - startedAt < PI_STDIN_TEARDOWN_PUBLICATION_BOUND_MS)
  await withDeadline(proc.stop())
})

test('PiRpcProcess poisons runtime requests on clean stdin close and stdout error', async t => {
  const fixture = await createFakePiFixture()
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
  setFixtureEnvironment(t, fixture)

  for (const cause of ['stdin_closed', 'stdout_error'] as const) {
    const child = spawn(process.execPath, [fixture.childPath, '--runtime-term-resistant'], {
      cwd: fixture.cwd,
      env: process.env,
      stdio: 'pipe'
    }) as ChildProcessWithoutNullStreams
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    })
    await waitForStdoutText(child, 'RUNTIME_TERM_RESISTANT_READY\n')
    const proc = createRuntimeProcess(child, fixture)
    const pending = proc.getState()

    if (cause === 'stdin_closed') child.stdin.emit('close')
    else child.stdout.emit('error', new Error('unsafe stdout transport detail'))

    await assert.rejects(withDeadline(pending), (error: unknown) => {
      assert.ok(error instanceof PiRpcProcessTerminatedError)
      assert.equal(error.data.piAcp.process.cause, cause)
      assert.equal(error.message.includes('unsafe stdout transport detail'), false)
      return true
    })
    await withDeadline(proc.stop())
  }
})

test('PiRpcProcess retries direct-child cleanup after an unconfirmed attempt', async t => {
  const fixture = await createFakePiFixture()
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
  setFixtureEnvironment(t, fixture)

  const child = spawn(process.execPath, [fixture.childPath, '--runtime-term-resistant'], {
    cwd: fixture.cwd,
    env: process.env,
    stdio: 'pipe'
  }) as ChildProcessWithoutNullStreams
  await waitForStdoutText(child, 'RUNTIME_TERM_RESISTANT_READY\n')
  const proc = createRuntimeProcess(child, fixture)
  const originalKill = child.kill.bind(child)
  const signals: Array<NodeJS.Signals | number | undefined> = []
  ;(child as any).kill = (signal?: NodeJS.Signals | number) => {
    signals.push(signal)
    return true
  }

  const stop = proc.stop()
  assert.equal(proc.stop(), stop)
  try {
    await assert.rejects(withDeadline(stop), (error: unknown) => {
      assert.ok(error instanceof PiRpcProcessCleanupError)
      assert.equal(error.code, PI_RPC_PROCESS_CLEANUP_UNCONFIRMED_CODE)
      assert.deepEqual(error.data, { code: PI_RPC_PROCESS_CLEANUP_UNCONFIRMED_CODE })
      return true
    })
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
    assert.equal(proc.isAlive(), false)
  } finally {
    ;(child as any).kill = originalKill
  }

  const retry = proc.stop()
  assert.notEqual(retry, stop)
  await withDeadline(retry)
  assert.equal(child.exitCode !== null || child.signalCode !== null, true)
})
