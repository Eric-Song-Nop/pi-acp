import assert from 'node:assert/strict'
import { open, readFile, readdir, realpath, unlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { networkInterfaces } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createConnection } from 'node:net'

const EXPECTED_NODE_VERSION = process.env.CI_EXPECTED_NODE_VERSION
const CONNECT_TIMEOUT_MS = 1_000
const ALLOWED_CONNECT_ERRORS = new Set(['EACCES', 'EAFNOSUPPORT', 'EHOSTUNREACH', 'ENETUNREACH'])
const SENSITIVE_ENVIRONMENT_NAME = /(?:^|_)(?:AUTH|CREDENTIAL|KEY|PROXY|SECRET|TOKEN)(?:_|$)/iu
const FORBIDDEN_ENVIRONMENT_NAMES = [
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_RUNTIME_TOKEN',
  'ANTHROPIC_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AZURE_OPENAI_API_KEY',
  'COPILOT_GITHUB_TOKEN',
  'GEMINI_API_KEY',
  'GITHUB_TOKEN',
  'GOOGLE_API_KEY',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'SSH_AUTH_SOCK',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY'
]

function assertBeneathTmp(name) {
  const value = process.env[name]
  assert.ok(value, `${name} must be set inside the network-denied container`)
  assert.equal(isAbsolute(value), true, `${name} must be absolute`)
  const normalizedTmp = resolve('/tmp')
  const normalizedValue = resolve(value)
  const pathFromTmp = relative(normalizedTmp, normalizedValue)
  assert.notEqual(pathFromTmp, '..', `${name} must remain beneath /tmp`)
  assert.equal(pathFromTmp.startsWith(`..${sep}`), false, `${name} must remain beneath /tmp`)
  assert.equal(isAbsolute(pathFromTmp), false, `${name} must remain beneath /tmp`)
}

async function assertOnlyLoopbackInterface() {
  const names = (await readdir('/sys/class/net')).sort()
  assert.deepEqual(names, ['lo'], 'network-denied CI must expose only the loopback interface')

  const interfaces = networkInterfaces()
  assert.deepEqual(Object.keys(interfaces).sort(), ['lo'])
  const loopback = interfaces.lo ?? []
  assert.ok(loopback.length > 0, 'loopback must have at least one address')
  assert.equal(
    loopback.every(address => address.internal),
    true,
    'every address in the isolated namespace must be internal'
  )
}

async function assertNoEffectiveCapabilities() {
  const status = await readFile('/proc/self/status', 'utf8')
  const capabilities = /^CapEff:\s*([0-9a-f]+)$/imu.exec(status)?.[1]
  const noNewPrivileges = /^NoNewPrivs:\s*(\d+)$/imu.exec(status)?.[1]
  assert.ok(capabilities, 'Linux process status must expose CapEff')
  assert.equal(/^0+$/u.test(capabilities), true, 'network-denied gate must run with zero effective capabilities')
  assert.equal(noNewPrivileges, '1', 'network-denied gate must enforce no-new-privileges')
  await realpath('/proc/self/ns/net')
}

async function assertReadOnlyWorkspace() {
  const probe = join(process.cwd(), `.c0.3-write-probe-${String(process.pid)}`)
  let handle
  try {
    handle = await open(probe, 'wx', 0o600)
  } catch (error) {
    assert.ok(error && typeof error === 'object' && 'code' in error, 'workspace denial must expose an OS error')
    assert.equal(error.code, 'EROFS', `workspace write failed with unexpected code ${String(error.code)}`)
    return
  }

  await handle.close()
  await unlink(probe)
  assert.fail('network-denied CI must mount the checkout read-only')
}

async function assertLoopbackRoundTrip() {
  const server = createServer(socket => {
    socket.end('ok')
  })
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })

  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const response = await new Promise((resolvePromise, reject) => {
      const socket = createConnection({
        host: '127.0.0.1',
        port: address.port
      })
      let value = ''
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('loopback round trip timed out'))
      }, CONNECT_TIMEOUT_MS)
      socket.setEncoding('utf8')
      socket.on('data', chunk => {
        value += chunk
      })
      socket.once('end', () => {
        clearTimeout(timer)
        resolvePromise(value)
      })
      socket.once('error', error => {
        clearTimeout(timer)
        reject(error)
      })
    })
    assert.equal(response, 'ok')
  } finally {
    await new Promise((resolvePromise, reject) => {
      server.close(error => {
        if (error) reject(error)
        else resolvePromise()
      })
    })
  }
}

async function assertExternalConnectDenied(host, family) {
  const error = await new Promise(resolvePromise => {
    const socket = createConnection({
      host,
      port: 443,
      family
    })
    const timer = setTimeout(() => {
      socket.destroy()
      resolvePromise(new Error(`external IPv${String(family)} connection did not fail immediately`))
    }, CONNECT_TIMEOUT_MS)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      resolvePromise(new Error(`external IPv${String(family)} connection unexpectedly succeeded`))
    })
    socket.once('error', caught => {
      clearTimeout(timer)
      resolvePromise(caught)
    })
  })

  assert.ok(
    error && typeof error === 'object' && 'code' in error,
    `external IPv${String(family)} denial must expose an OS error`
  )
  assert.equal(
    ALLOWED_CONNECT_ERRORS.has(error.code),
    true,
    `external IPv${String(family)} connection failed with unexpected code ${String(error.code)}`
  )
}

function assertGitHasNoCredentialHooks() {
  const result = spawnSync('git', ['config', '--local', '--list'], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0'
    },
    timeout: 2_000,
    maxBuffer: 64 * 1024
  })
  assert.equal(result.status, 0, `git config inspection failed: ${String(result.stderr).trim()}`)
  const forbidden = String(result.stdout)
    .split(/\r?\n/u)
    .filter(Boolean)
    .filter(line => {
      const key = line.slice(0, Math.max(0, line.indexOf('='))).toLowerCase()
      return (
        key.startsWith('credential.') ||
        (key.startsWith('http.') && key.endsWith('.extraheader')) ||
        (key.startsWith('url.') && key.endsWith('.insteadof'))
      )
    })
  assert.deepEqual(forbidden, [], 'isolated checkout must not contain credential or URL-rewrite hooks')
}

async function main() {
  assert.equal(process.platform, 'linux', 'network-denied CI evidence is Linux-only')
  assert.equal(process.arch, 'x64', 'network-denied CI evidence is pinned to linux/amd64')
  assert.ok(process.getuid() > 0, 'network-denied CI must run with an unprivileged UID')
  assert.ok(process.getgid() > 0, 'network-denied CI must run with an unprivileged GID')
  assert.equal(process.cwd(), '/workspace', 'network-denied CI must run from the isolated checkout mount')
  assert.match(EXPECTED_NODE_VERSION ?? '', /^\d+\.\d+\.\d+$/u)
  assert.equal(process.versions.node, EXPECTED_NODE_VERSION, 'container Node version must be exact')

  for (const name of FORBIDDEN_ENVIRONMENT_NAMES) {
    assert.equal(Object.hasOwn(process.env, name), false, `${name} must not enter the execution container`)
  }
  for (const name of Object.keys(process.env)) {
    assert.equal(
      SENSITIVE_ENVIRONMENT_NAME.test(name),
      false,
      `sensitive environment name ${name} must not enter the execution container`
    )
  }
  for (const name of [
    'HOME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME'
  ]) {
    assertBeneathTmp(name)
  }
  assert.equal(process.env.GIT_CONFIG_NOSYSTEM, '1')
  assert.equal(process.env.GIT_CONFIG_GLOBAL, '/dev/null')
  assert.equal(process.env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(process.env.GIT_OPTIONAL_LOCKS, '0')

  await assertOnlyLoopbackInterface()
  await assertNoEffectiveCapabilities()
  await assertReadOnlyWorkspace()
  await assertLoopbackRoundTrip()
  await assertExternalConnectDenied('192.0.2.1', 4)
  await assertExternalConnectDenied('2001:db8::1', 6)
  assertGitHasNoCredentialHooks()
  process.stdout.write(
    `${JSON.stringify({
      checkpoint: 'C0.3',
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      interfaces: ['lo'],
      externalEgress: 'kernel-denied',
      loopback: 'available',
      effectiveCapabilities: 'none',
      noNewPrivileges: true,
      uid: process.getuid(),
      gid: process.getgid(),
      workspace: 'read-only'
    })}\n`
  )
}

await main()
