import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  PI_STARTUP_STDERR_LIMIT_BYTES,
  PI_STARTUP_SUMMARY_LIMIT_BYTES,
  type PiStartupDiagnostic
} from '../../src/pi-rpc/diagnostics.js'
import { PiRpcProcess, PiRpcProcessTerminatedError, PiRpcSpawnError } from '../../src/pi-rpc/process.js'

const TEST_TIMEOUT_MS = 10_000
const REJECTION_DEADLINE_MS = 3_000
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
import { closeSync, existsSync, writeSync } from 'node:fs'
import { join } from 'node:path'

const run = async () => {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? ''
  const sourcePath = join(agentDir, 'extensions', 'pi-acp-failing-load', 'index.ts')
  const credential = process.env.OPENAI_API_KEY ?? ''

  if (process.argv.includes('--close-stdin-upgrade-late-stderr')) {
    const exitTriggerPath = process.env.PI_ACP_LATE_EXIT_TRIGGER ?? ''
    const triggerPath = process.env.PI_ACP_LATE_STDERR_TRIGGER ?? ''
    const lateStderrCode = [
      "const { existsSync, writeSync } = require('node:fs')",
      'const trigger = process.argv[1]',
      'const deadline = Date.now() + 1_000',
      "const timer = setInterval(() => { if (existsSync(trigger)) { clearInterval(timer); writeSync(2, 'POST_UPGRADE_STDERR\\\\n'); process.exit(0) } if (Date.now() >= deadline) process.exit(2) }, 2)"
    ].join('; ')
    const lateStderr = spawn(process.execPath, ['-e', lateStderrCode, triggerPath], {
      stdio: ['ignore', 'ignore', 2]
    })
    lateStderr.unref()
    closeSync(0)
    await new Promise((resolve, reject) => {
      process.stdout.write('STDIN_CLOSED_UPGRADE_LATE_STDERR\\n', error =>
        error ? reject(error) : resolve()
      )
    })
    const exitTimer = setInterval(() => {
      if (!existsSync(exitTriggerPath)) return
      clearInterval(exitTimer)
      process.exit(23)
    }, 2)
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
    closeSync(0)
    await new Promise((resolve, reject) => {
      process.stdout.write('STDIN_CLOSED_LATE_EXIT\\n', error => (error ? reject(error) : resolve()))
    })
    setTimeout(() => {
      writeSync(2, 'GENERIC_LATE_EXIT\\n')
      process.exit(19)
    }, 150)
    await new Promise(() => {})
  }

  if (process.argv.includes('--close-stdin')) {
    process.on('SIGTERM', () => {})
    closeSync(0)
    await new Promise((resolve, reject) => {
      process.stdout.write('STDIN_CLOSED\\n', error => (error ? reject(error) : resolve()))
    })
    setTimeout(() => {
      process.stderr.write(
        '\\nFailed to load extension "' + sourcePath + '":\\nreason=${SAFE_REASON}\\n'
      )
    }, 150)
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

async function waitForExitListenerCount(
  child: ChildProcessWithoutNullStreams,
  predicate: (count: number) => boolean
): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await withDeadline(
      new Promise<void>(resolve => {
        const check = (): void => {
          if (predicate(child.listenerCount('exit'))) {
            resolve()
            return
          }
          timer = setTimeout(check, 1)
        }
        check()
      })
    )
  } finally {
    if (timer) clearTimeout(timer)
  }
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
        assert.ok(error.diagnostic)
        assertSafeDiagnostic(error.diagnostic, fixture)
        assertSafeErrorText(error, fixture)
        return true
      }
    )
    assert.ok(Date.now() - startedAt < REJECTION_DEADLINE_MS)
  }
)

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
      stdio: 'pipe'
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

    let pendingError: PiRpcProcessTerminatedError | undefined
    await assert.rejects(withDeadline(proc.getState()), (error: unknown) => {
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

    await assert.rejects(withDeadline(proc.getState()), (error: unknown) => {
      assert.ok(error instanceof PiRpcProcessTerminatedError)
      assert.equal(error, pendingError)
      return true
    })

    assert.equal(child.exitCode, 19)
    assert.equal(isProcessAlive(pid), false)
    assert.equal(child.stdin.listenerCount('error'), 0)
  }
)

test('PiRpcProcess gives an upgraded real exit its own bounded stderr drain', { timeout: TEST_TIMEOUT_MS }, async t => {
  const fixture = await createFakePiFixture()
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))
  setFixtureEnvironment(t, fixture)
  const exitTriggerPath = join(fixture.rootDir, 'late-exit.trigger')
  const stderrTriggerPath = join(fixture.rootDir, 'late-stderr.trigger')

  const child = spawn(process.execPath, [fixture.childPath, '--close-stdin-upgrade-late-stderr'], {
    cwd: fixture.cwd,
    env: {
      ...process.env,
      PI_ACP_LATE_EXIT_TRIGGER: exitTriggerPath,
      PI_ACP_LATE_STDERR_TRIGGER: stderrTriggerPath
    },
    stdio: 'pipe'
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

  const exitObserved = new Promise<void>((resolve, reject) => {
    child.once('exit', code => {
      try {
        assert.equal(code, 23)
        writeFileSync(stderrTriggerPath, 'go', { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        resolve()
      } catch (error) {
        reject(error)
      }
    })
  })
  const stableExitListenerCount = child.listenerCount('exit')
  assert.equal(stableExitListenerCount >= 2, true)
  const startedAt = Date.now()
  const pending = proc.getState()
  // Synchronize on the three arbitration phases instead of wall-clock guesses:
  // initial terminal waiter attached -> first stderr drain -> upgrade waiter attached.
  await waitForExitListenerCount(child, count => count > stableExitListenerCount)
  await waitForExitListenerCount(child, count => count === stableExitListenerCount)
  await waitForExitListenerCount(child, count => count > stableExitListenerCount)
  writeFileSync(exitTriggerPath, 'go', { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  await withDeadline(exitObserved)

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
  assert.ok(Date.now() - startedAt < REJECTION_DEADLINE_MS)

  await assert.rejects(withDeadline(proc.getState()), (error: unknown) => {
    assert.ok(error instanceof PiRpcProcessTerminatedError)
    assert.equal(error, pendingError)
    return true
  })

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

    assert.equal(child.exitCode !== null || child.signalCode !== null, true)
    assert.equal(isProcessAlive(pid), false)
    assert.equal(child.stdin.listenerCount('error'), 0)
  }
)
