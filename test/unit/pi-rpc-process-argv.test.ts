import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PI_RPC_PROJECT_TRUST_POLICY, PiRpcProcess } from '../../src/pi-rpc/process.js'

function posixQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

async function createArgvFixture() {
  const rootDir = await mkdtemp(join(tmpdir(), 'pi-acp-process-argv-'))
  const cwd = join(rootDir, 'workspace')
  const childPath = join(rootDir, 'argv-child.mjs')
  const piCommand = join(rootDir, process.platform === 'win32' ? 'fake-pi.cmd' : 'fake-pi')

  await mkdir(cwd, { recursive: true })
  await writeFile(
    childPath,
    `import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const receiptPath = process.env.PI_ACP_ARGV_RECEIPT
if (!receiptPath) throw new Error('PI_ACP_ARGV_RECEIPT is required')
writeFileSync(receiptPath, JSON.stringify(process.argv.slice(2)), { encoding: 'utf8', flag: 'wx' })

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', line => {
  const request = JSON.parse(line)
  if (request.type !== 'get_state') return
  const sessionFile = process.env.PI_ACP_ARGV_SESSION_FILE || undefined
  process.stdout.write(
    JSON.stringify({
      type: 'response',
      id: request.id,
      command: 'get_state',
      success: true,
      data: { sessionId: 'argv-session', ...(sessionFile ? { sessionFile } : {}) }
    }) + '\\n'
  )
})
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

  return { rootDir, cwd, piCommand }
}

function assertForcedApprovalArgs(args: string[]): void {
  assert.equal(args.filter(arg => arg === '--approve').length, 1)
  for (const forbidden of ['-a', '--no-approve', '-na']) assert.equal(args.includes(forbidden), false)
  assert.equal(
    args.some(arg => arg.startsWith('--approve=')),
    false
  )
}

test('PiRpcProcess.spawn applies the immutable forced-approval policy to normal and restore argv', async t => {
  const fixture = await createArgvFixture()
  t.after(() => rm(fixture.rootDir, { recursive: true, force: true }))

  assert.equal(Object.isFrozen(PI_RPC_PROJECT_TRUST_POLICY), true)
  assert.deepEqual(PI_RPC_PROJECT_TRUST_POLICY, {
    policy: 'force-approve',
    adapterOverride: 'approve',
    perProjectConsent: false,
    basis: 'cli-approve',
    cliArgument: '--approve'
  })

  const previousReceipt = process.env.PI_ACP_ARGV_RECEIPT
  const previousSessionFile = process.env.PI_ACP_ARGV_SESSION_FILE
  t.after(() => {
    if (previousReceipt === undefined) delete process.env.PI_ACP_ARGV_RECEIPT
    else process.env.PI_ACP_ARGV_RECEIPT = previousReceipt
    if (previousSessionFile === undefined) delete process.env.PI_ACP_ARGV_SESSION_FILE
    else process.env.PI_ACP_ARGV_SESSION_FILE = previousSessionFile
  })

  const normalReceipt = join(fixture.rootDir, 'normal-argv.json')
  process.env.PI_ACP_ARGV_RECEIPT = normalReceipt
  delete process.env.PI_ACP_ARGV_SESSION_FILE
  const normal = await PiRpcProcess.spawn({ cwd: fixture.cwd, piCommand: fixture.piCommand })
  const normalArgs = JSON.parse(await readFile(normalReceipt, 'utf8')) as string[]
  assert.deepEqual(normalArgs, ['--mode', 'rpc', '--no-themes', '--approve'])
  assertForcedApprovalArgs(normalArgs)
  await normal.stop()

  const sessionPath = join(fixture.rootDir, 'sessions', 'restored.jsonl')
  const restoreReceipt = join(fixture.rootDir, 'restore-argv.json')
  process.env.PI_ACP_ARGV_RECEIPT = restoreReceipt
  process.env.PI_ACP_ARGV_SESSION_FILE = sessionPath
  const restored = await PiRpcProcess.spawn({
    cwd: fixture.cwd,
    piCommand: fixture.piCommand,
    sessionPath,
    handshakeTimeoutMs: 1_500
  })
  const restoreArgs = JSON.parse(await readFile(restoreReceipt, 'utf8')) as string[]
  assert.deepEqual(restoreArgs, ['--mode', 'rpc', '--no-themes', '--approve', '--session', sessionPath])
  assertForcedApprovalArgs(restoreArgs)
  assert.ok(restoreArgs.indexOf('--approve') < restoreArgs.indexOf('--session'))
  await restored.stop()
})
