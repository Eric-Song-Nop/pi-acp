import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { join } from 'node:path'
import test from 'node:test'
import {
  PI_DIAGNOSTIC_REDACTION,
  PI_STARTUP_STDERR_DRAIN_TIMEOUT_MS,
  PI_STARTUP_STDERR_LIMIT_BYTES,
  PI_STARTUP_SUMMARY_LIMIT_BYTES,
  PI_STARTUP_TRUNCATION_MARKER,
  PiStartupDiagnosticCapture,
  type PiStartupDiagnosticOptions
} from '../../src/pi-rpc/diagnostics.js'

const cwd = '/workspace/acme'
const agentDir = '/home/tester/.pi/agent'

function options(env: NodeJS.ProcessEnv = {}): PiStartupDiagnosticOptions {
  return { cwd, agentDir, env }
}

function captureBuffer(
  input: Buffer,
  chunkSizes: readonly number[],
  captureOptions = options()
): PiStartupDiagnosticCapture {
  const capture = new PiStartupDiagnosticCapture(captureOptions)
  let offset = 0
  let chunkIndex = 0

  while (offset < input.length) {
    const size = chunkSizes[chunkIndex % chunkSizes.length]
    const end = Math.min(offset + size, input.length)
    capture.push(input.subarray(offset, end))
    offset = end
    chunkIndex += 1
  }

  return capture
}

test('startup diagnostics classify and label a Pi project extension load line', () => {
  const extensionPath = join(cwd, '.pi', 'extensions', 'failing.ts')
  const capture = new PiStartupDiagnosticCapture(options())
  capture.push(`\u001b[31mError: Failed to load extension "${extensionPath}": factory exploded\u001b[0m`)

  const diagnostic = capture.finalize({ code: 1, signal: null })

  assert.deepEqual(diagnostic, {
    schemaVersion: 1,
    code: 'PI_EXTENSION_LOAD_FAILED',
    phase: 'startup',
    source: 'project:.pi/extensions/failing.ts',
    summary: 'Extension load failed (project:.pi/extensions/failing.ts):\nfactory exploded',
    truncated: false,
    redacted: true,
    stderrLimitBytes: 16_384,
    summaryLimitBytes: 4_096
  })
  assert.equal(Object.isFrozen(diagnostic), true)
  assert.equal(PI_STARTUP_STDERR_DRAIN_TIMEOUT_MS, 100)

  const wrappedCapture = new PiStartupDiagnosticCapture(options())
  wrappedCapture.push(
    `Error: Failed to load extension "${extensionPath}": Failed to load extension: reason=C1.1_SAFE_EXTENSION_LOAD_REASON`
  )
  const wrappedDiagnostic = wrappedCapture.finalize({ code: 1 })
  assert.equal(
    wrappedDiagnostic.summary,
    'Extension load failed (project:.pi/extensions/failing.ts):\nreason=C1.1_SAFE_EXTENSION_LOAD_REASON'
  )
})

test('startup diagnostics distinguish global, external, relative, and generic sources without exporting paths', () => {
  const cases = [
    {
      path: join(agentDir, 'extensions', 'pi-acp-failing-load', 'index.ts'),
      source: 'global:extensions/pi-acp-failing-load/index.ts'
    },
    {
      path: join(cwd, 'extensions', 'relative.ts'),
      source: 'project:extensions/relative.ts'
    },
    {
      path: '/Users/alice/private/extensions/external.ts',
      source: 'external:<redacted>'
    },
    {
      path: './.pi/extensions/local.ts',
      source: 'project:.pi/extensions/local.ts'
    }
  ] as const

  for (const entry of cases) {
    const capture = new PiStartupDiagnosticCapture(options())
    capture.push(`Error: Failed to load extension "${entry.path}": no factory`)
    const diagnostic = capture.finalize({ code: 1 })

    assert.equal(diagnostic.code, 'PI_EXTENSION_LOAD_FAILED')
    assert.equal(diagnostic.source, entry.source)
    assert.equal(diagnostic.summary, `Extension load failed (${entry.source}):\nno factory`)
    assert.equal(diagnostic.summary.includes(entry.path), false)
    assert.equal(diagnostic.redacted, true)
  }

  const generic = new PiStartupDiagnosticCapture(options())
  generic.push('unexpected startup failure')
  const diagnostic = generic.finalize({ code: 7, signal: 'SIGTERM' })
  assert.equal(diagnostic.code, 'PI_STARTUP_FAILED')
  assert.equal(diagnostic.source, 'unknown')
  assert.equal(diagnostic.summary, 'Pi failed to start (code=7, signal=SIGTERM).\nunexpected startup failure')

  const oversizedSource = join(agentDir, 'extensions', 'a'.repeat(600), 'bad.ts')
  const oversized = new PiStartupDiagnosticCapture(options())
  oversized.push(`Error: Failed to load extension "${oversizedSource}": bounded source`)
  const oversizedDiagnostic = oversized.finalize({ code: 1 })
  assert.equal(oversizedDiagnostic.source, 'external:<redacted>')
  assert.equal(oversizedDiagnostic.summary, 'Extension load failed (external:<redacted>):\nbounded source')
  assert.equal(oversizedDiagnostic.summary.includes(oversizedSource), false)
})

test('percent-decoded file URLs cannot reintroduce controls, terminal sequences, bidi, or default ignorables', () => {
  const cases = [
    { encoded: '%00nul.ts', forbidden: '\u0000' },
    { encoded: '%09tab.ts', forbidden: '\u0009' },
    { encoded: '%0Aline-feed.ts', forbidden: '\u000a' },
    { encoded: '%0Dcarriage-return.ts', forbidden: '\u000d' },
    { encoded: '%1B%5B31m-csi.ts', forbidden: '\u001b' },
    { encoded: '%1B%5D0%3Bowned%07-osc.ts', forbidden: '\u0007' },
    { encoded: '%1B%5D52%3Bc%3Bowned%07-osc52.ts', forbidden: '\u001b' },
    { encoded: '%C2%9B31m-c1.ts', forbidden: '\u009b' },
    { encoded: '%C2%9D0%3Bowned%C2%9C-c1-osc.ts', forbidden: '\u009d' },
    { encoded: '%E2%80%AE-bidi.ts', forbidden: '\u202e' },
    { encoded: '%E2%81%A6-isolate.ts', forbidden: '\u2066' },
    { encoded: '%C2%AD-soft-hyphen.ts', forbidden: '\u00ad' },
    { encoded: '%CD%8F-grapheme-joiner.ts', forbidden: '\u034f' },
    { encoded: '%EF%BB%BF-bom.ts', forbidden: '\ufeff' },
    { encoded: '%EF%B8%8F-variation-selector.ts', forbidden: '\ufe0f' },
    { encoded: '%E2%80%A8-line-separator.ts', forbidden: '\u2028' },
    { encoded: '%E2%80%A9-paragraph-separator.ts', forbidden: '\u2029' }
  ] as const

  for (const entry of cases) {
    const extensionUrl = `file://${cwd}/.pi/extensions/${entry.encoded}`
    const capture = new PiStartupDiagnosticCapture(options())
    capture.push(`Error: Failed to load extension "${extensionUrl}": encoded path rejected`)

    const diagnostic = capture.finalize({ code: 1 })

    assert.equal(diagnostic.code, 'PI_EXTENSION_LOAD_FAILED')
    assert.equal(diagnostic.source, 'external:<redacted>')
    assert.equal(diagnostic.summary, 'Extension load failed (external:<redacted>):\nencoded path rejected')
    assert.equal(diagnostic.source.includes(entry.forbidden), false)
    if (entry.forbidden !== '\n') assert.equal(diagnostic.summary.includes(entry.forbidden), false)
    assert.equal(diagnostic.summary.includes(extensionUrl), false)
    assert.equal(diagnostic.redacted, true)
  }
})

test('percent-decoded file URLs fail closed on encoded separators and credentials', () => {
  const safeUrl = `file://${cwd}/.pi/extensions/safe%20name.ts`
  const safeCapture = new PiStartupDiagnosticCapture(options())
  safeCapture.push(`Error: Failed to load extension "${safeUrl}": safe encoding`)
  const safeDiagnostic = safeCapture.finalize({ code: 1 })
  assert.equal(safeDiagnostic.source, 'project:.pi/extensions/safe name.ts')
  assert.equal(safeDiagnostic.summary, 'Extension load failed (project:.pi/extensions/safe name.ts):\nsafe encoding')

  const rejectedPaths = [
    `file://${cwd}/.pi/extensions/nested%2Fbad.ts`,
    `file://${cwd}/.pi/extensions/nested%5Cbad.ts`,
    `file://${cwd}/.pi/extensions/%2E%2E%2Fbad.ts`,
    `file://${cwd}/.pi/extensions/%73%6B%5Fagent%5FABCDEFGH1234.ts`,
    `file://${cwd}/.pi/extensions/exact%2Denv%2Dsecret%2D123.ts`
  ] as const

  for (const extensionUrl of rejectedPaths) {
    const capture = new PiStartupDiagnosticCapture(options({ SERVICE_API_KEY: 'exact-env-secret-123' }))
    capture.push(`Error: Failed to load extension "${extensionUrl}": unsafe encoding rejected`)
    const diagnostic = capture.finalize({ code: 1 })

    assert.equal(diagnostic.source, 'external:<redacted>')
    assert.equal(diagnostic.summary, 'Extension load failed (external:<redacted>):\nunsafe encoding rejected')
    assert.equal(diagnostic.summary.includes('sk_agent_ABCDEFGH1234'), false)
    assert.equal(diagnostic.summary.includes('exact-env-secret-123'), false)
    assert.equal(diagnostic.summary.includes(extensionUrl), false)
    assert.equal(diagnostic.redacted, true)
  }

  const extensionPath = join(agentDir, 'extensions', 'bad.ts')
  const genericCapture = new PiStartupDiagnosticCapture(options())
  genericCapture.push(`Error: Failed to load extension "${extensionPath}":
credential=file://${cwd}/logs/%73%6B%5Fagent%5FABCDEFGH1234.txt
separator=file://${cwd}/logs/nested%2Ftrace.txt`)
  const genericDiagnostic = genericCapture.finalize({ code: 1 })

  assert.equal(genericDiagnostic.source, 'global:extensions/bad.ts')
  assert.equal(genericDiagnostic.summary.includes('sk_agent_ABCDEFGH1234'), false)
  assert.equal(genericDiagnostic.summary.includes('%2F'), false)
  assert.equal(genericDiagnostic.summary.includes(PI_DIAGNOSTIC_REDACTION), true)
  assert.equal(genericDiagnostic.summary.includes('credential='), false)
  assert.equal(genericDiagnostic.summary.includes('separator='), false)
  assert.equal(genericDiagnostic.redacted, true)
})

test('file URL parsing is case-insensitive, canonical, platform-aware, and fail-closed', () => {
  const projectCases = [
    `FILE://${cwd}/.pi/extensions/upper.ts`,
    `File://localhost${cwd}/.pi/extensions/localhost.ts`
  ] as const
  for (const extensionUrl of projectCases) {
    const capture = new PiStartupDiagnosticCapture(options())
    capture.push(`Error: Failed to load extension "${extensionUrl}": canonical file URL`)
    const diagnostic = capture.finalize({ code: 1 })
    assert.match(diagnostic.source, /^project:\.pi\/extensions\//)
    assert.equal(diagnostic.summary.includes(extensionUrl), false)
  }

  const rejected = [
    'FILE:///Users/alice/private/project/failure.ts',
    'file://server/share/private/failure.ts',
    `file://${cwd}/.pi/extensions/query.ts?token=unsafe`,
    `file://${cwd}/.pi/extensions/fragment.ts#unsafe`,
    `file://${cwd}/.pi/extensions/%2E%2E%2Fescape.ts`,
    `file://${cwd}/.pi/extensions/.%2E/escape.ts`,
    `file://${cwd}/.pi/extensions/%2E./escape.ts`,
    `file://${cwd}/.pi/extensions/%252e%252e%252fescape.ts`,
    `file://${cwd}/.pi/extensions/invalid%.ts`,
    `file://${cwd}/.pi/extensions/invalid%G0.ts`,
    `file://${cwd}/.pi/extensions/overlong%C0%AF.ts`,
    `file://${cwd}/.pi/extensions/safe%22%3A%20forged.ts`,
    `file://${cwd}/.pi/extensions/safe%29%3A%20forged.ts`,
    `file://${cwd}/.pi/extensions/Basic%20dXNlcjpwYXNzd29yZA%3D%3D.ts`,
    `file://${cwd}/.pi/extensions/-----BEGIN%20PRIVATE%20KEY-----ABC-----END%20PRIVATE%20KEY-----.ts`,
    'file:opaque-private-path',
    'file://alice:password@server/share/private.ts'
  ] as const
  for (const extensionUrl of rejected) {
    const capture = new PiStartupDiagnosticCapture(options())
    capture.push(`Error: Failed to load extension "${extensionUrl}": REAL_REASON`)
    const diagnostic = capture.finalize({ code: 1 })

    assert.equal(diagnostic.source, 'external:<redacted>')
    assert.equal(diagnostic.summary, 'Extension load failed (external:<redacted>):\nREAL_REASON')
    assert.equal(diagnostic.summary.includes(extensionUrl), false)
    assert.equal(diagnostic.redacted, true)
  }

  const windowsOptions: PiStartupDiagnosticOptions = {
    cwd: 'C:\\workspace\\acme',
    agentDir: 'C:\\Users\\tester\\.pi\\agent',
    env: {}
  }
  const windowsCases = [
    {
      url: 'file:///C:/workspace/acme/extensions/safe%20name.ts',
      source: 'project:extensions/safe name.ts'
    },
    {
      url: 'FILE:///C:/Users/tester/.pi/agent/extensions/global.ts',
      source: 'global:extensions/global.ts'
    },
    {
      url: 'file:///D:/private/external.ts',
      source: 'external:<redacted>'
    }
  ] as const
  for (const entry of windowsCases) {
    const capture = new PiStartupDiagnosticCapture(windowsOptions)
    capture.push(`Error: Failed to load extension "${entry.url}": windows URL`)
    assert.equal(capture.finalize({ code: 1 }).source, entry.source)
  }

  const uncCapture = new PiStartupDiagnosticCapture({
    cwd: '\\\\server\\share\\workspace\\acme',
    agentDir: '\\\\server\\share\\Users\\tester\\.pi\\agent',
    env: {}
  })
  uncCapture.push('Error: Failed to load extension "file://server/share/workspace/acme/extensions/unc.ts": UNC URL')
  assert.equal(uncCapture.finalize({ code: 1 }).source, 'project:extensions/unc.ts')
})

test('relative and absolute source labeling uses trusted path flavor and canonical containment', () => {
  const cases = [
    { path: 'safe/../local.ts', source: 'project:local.ts' },
    { path: 'safe/../../Users/alice/private.ts', source: 'external:<redacted>' },
    { path: 'safe\\..\\..\\Users\\alice\\private.ts', source: 'external:<redacted>' },
    { path: 'C:..\\Users\\alice\\private.ts', source: 'external:<redacted>' },
    { path: '/WORKSPACE/ACME/Users/alice/private.ts', source: 'external:<redacted>' },
    { path: '/HOME/TESTER/.PI/AGENT/private.ts', source: 'external:<redacted>' }
  ] as const

  for (const entry of cases) {
    const capture = new PiStartupDiagnosticCapture(options())
    capture.push(`Error: Failed to load extension "${entry.path}": containment`)
    const diagnostic = capture.finalize({ code: 1 })
    assert.equal(diagnostic.source, entry.source)
    assert.equal(diagnostic.summary.includes(entry.path), false)
  }

  const windowsCapture = new PiStartupDiagnosticCapture({
    cwd: 'C:\\workspace\\acme',
    agentDir: 'C:\\Users\\tester\\.pi\\agent',
    env: {}
  })
  windowsCapture.push('Error: Failed to load extension "C:\\workspace\\acme\\extensions\\safe.ts": windows path')
  assert.equal(windowsCapture.finalize({ code: 1 }).source, 'project:extensions/safe.ts')
})

test('generic absolute paths are redacted across arbitrary delimiters without consuming ordinary URLs', () => {
  const extensionPath = join(agentDir, 'extensions', 'bad.ts')
  const externalPaths = [
    'failure|/Users/alice/private/one.ts',
    'failure>/Users/alice/private/two.ts',
    'failure,/Users/alice/private/three.ts',
    'failure→/Users/alice/private/four.ts',
    'failure=C:\\Users\\alice\\private\\five.ts',
    'failure=\\\\server\\share\\private\\six.ts',
    'failure=\\Users\\alice\\private\\seven.ts',
    'failure=//server/share/private/eight.ts'
  ] as const
  const capture = new PiStartupDiagnosticCapture(options())
  capture.push(`Error: Failed to load extension "${extensionPath}":
${externalPaths.join('\n')}
public=https://example.test/path/to/resource`)
  const diagnostic = capture.finalize({ code: 1 })

  for (const externalPath of externalPaths) assert.equal(diagnostic.summary.includes(externalPath), false)
  assert.equal(diagnostic.summary.includes('/Users/alice'), false)
  assert.equal(diagnostic.summary.includes('C:\\Users\\alice'), false)
  assert.equal(diagnostic.summary.includes('https://example.test/path/to/resource'), true)
  assert.ok((diagnostic.summary.match(/external:<redacted>/g)?.length ?? 0) >= externalPaths.length)
})

test('head and tail retention classifies an attacker-padded Pi line larger than 64 KiB', () => {
  const extensionPath = join(agentDir, 'extensions', 'pi-acp-failing-load', 'index.ts')
  const raw = Buffer.from(
    `Error: Failed to load extension "${extensionPath}": ${'attacker-padding-'.repeat(5_000)}\nACTIONABLE_TAIL`,
    'utf8'
  )
  assert.ok(raw.length > 64 * 1_024)

  const diagnostic = captureBuffer(raw, [1, 2, 3, 127, 8_191, 17]).finalize({ code: 1 })

  assert.equal(diagnostic.code, 'PI_EXTENSION_LOAD_FAILED')
  assert.equal(diagnostic.source, 'global:extensions/pi-acp-failing-load/index.ts')
  assert.equal(
    diagnostic.summary.startsWith(
      `Extension load failed (global:extensions/pi-acp-failing-load/index.ts):\n${PI_STARTUP_TRUNCATION_MARKER}`
    ),
    true
  )
  assert.equal(diagnostic.summary.endsWith('ACTIONABLE_TAIL'), true)
  assert.equal(diagnostic.summary.includes(extensionPath), false)
  assert.equal(diagnostic.truncated, true)
  assert.ok(Buffer.byteLength(diagnostic.summary, 'utf8') <= PI_STARTUP_SUMMARY_LIMIT_BYTES)
  assert.equal(diagnostic.stderrLimitBytes, PI_STARTUP_STDERR_LIMIT_BYTES)
})

test('split and invalid UTF-8 decode deterministically only after byte retention', () => {
  const bytes = Buffer.concat([
    Buffer.from('valid € and 🙂 before ', 'utf8'),
    Buffer.from([0xf0, 0x28, 0x8c, 0x28]),
    Buffer.from(' after', 'utf8')
  ])

  const first = captureBuffer(bytes, [1]).finalize({ code: 1 })
  const second = captureBuffer(bytes, [2, 5, 3, 11]).finalize({ code: 1 })

  assert.deepEqual(first, second)
  assert.equal(first.summary.includes('€'), true)
  assert.equal(first.summary.includes('🙂'), true)
  assert.equal(first.summary.includes('\ufffd'), true)
  assert.equal(first.redacted, true)
  assert.equal(first.truncated, false)
})

test('ANSI, OSC, CR, C0/C1, zero-width, and bidi controls are removed', () => {
  const capture = new PiStartupDiagnosticCapture(options())
  capture.push(
    [
      '\u001b]0;OSC-BEL-SECRET\u0007',
      '\u001b]2;OSC-ST-SECRET\u001b\\',
      '\u001bPDEVICE-CONTROL-SECRET\u001b\\',
      '\u001b[31mboom\u001b[0m\rnext',
      '\u0000\u0001',
      '\u009b32mgreen\u009b0m',
      '\u0085',
      'left\u202eright\u2066hidden\u2069\u200b'
    ].join('')
  )

  const diagnostic = capture.finalize({ code: 1 })

  assert.equal(diagnostic.summary, 'Pi failed to start (code=1).\nboom\nnextgreenleftrighthidden')
  assert.equal(diagnostic.redacted, true)
  assert.doesNotMatch(diagnostic.summary, /OSC|DEVICE/)
  for (const control of ['\u001b', '\u009b', '\u202e', '\u2066', '\u2069']) {
    assert.equal(diagnostic.summary.includes(control), false)
  }
})

test('sensitive environment values and common credential and path shapes are redacted', () => {
  const extensionPath = join(agentDir, 'extensions', 'bad.ts')
  const capture = new PiStartupDiagnosticCapture(
    options({
      SERVICE_API_KEY: 'exact-env-secret-123',
      SAFE_LABEL: 'visible-safe-value'
    })
  )
  capture.push(`Error: Failed to load extension "${extensionPath}":
exact=exact-env-secret-123
Authorization: Bearer bearer-secret-456
token=query-token-789
url=https://alice:hunter2@example.test/private
github=ghp_abcdefghijklmnopqrstuvwxyz123456
jwt=eyJabcdefghijk.eyJmnopqrstuv.wxyzABCDEFGH
private=/Users/alice/private/project/failure.ts
safe=visible-safe-value`)

  const diagnostic = capture.finalize({ code: 1 })

  for (const secret of [
    'exact-env-secret-123',
    'bearer-secret-456',
    'query-token-789',
    'alice:hunter2',
    'ghp_abcdefghijklmnopqrstuvwxyz123456',
    'eyJabcdefghijk.eyJmnopqrstuv.wxyzABCDEFGH',
    '/Users/alice/private/project/failure.ts'
  ]) {
    assert.equal(diagnostic.summary.includes(secret), false, `leaked ${secret}`)
  }
  assert.equal(diagnostic.summary.includes(PI_DIAGNOSTIC_REDACTION), true)
  assert.equal(diagnostic.summary.includes('https://'), false)
  assert.equal(diagnostic.summary.includes('visible-safe-value'), false)
  assert.equal(diagnostic.redacted, true)

  const sensitiveSourcePath = join(
    agentDir,
    'extensions',
    'exact-env-secret-123',
    'sk-source-credential-123456789',
    'bad.ts'
  )
  const sensitiveSourceCapture = new PiStartupDiagnosticCapture(options({ SERVICE_API_KEY: 'exact-env-secret-123' }))
  sensitiveSourceCapture.push(`Error: Failed to load extension "${sensitiveSourcePath}": source rejected`)
  const sensitiveSourceDiagnostic = sensitiveSourceCapture.finalize({ code: 1 })

  assert.equal(sensitiveSourceDiagnostic.source, 'external:<redacted>')
  assert.equal(sensitiveSourceDiagnostic.summary.includes('exact-env-secret-123'), false)
  assert.equal(sensitiveSourceDiagnostic.summary.includes('sk-source-credential-123456789'), false)
  assert.equal(sensitiveSourceDiagnostic.redacted, true)

  const mutableEnv: NodeJS.ProcessEnv = { SERVICE_API_KEY: 'secret-at-spawn' }
  const snapshotCapture = new PiStartupDiagnosticCapture(options(mutableEnv))
  mutableEnv.SERVICE_API_KEY = 'changed-after-spawn'
  snapshotCapture.push('failure secret-at-spawn')
  const snapshotDiagnostic = snapshotCapture.finalize({ code: 1 })
  assert.equal(snapshotDiagnostic.summary.includes('secret-at-spawn'), false)
  assert.equal(snapshotDiagnostic.summary.includes(PI_DIAGNOSTIC_REDACTION), true)
})

test('quoted, JSON, bare authorization, and provider credential forms are redacted idempotently', () => {
  const extensionPath = join(agentDir, 'extensions', 'bad.ts')
  const secrets = [
    'quoted-bearer-secret-123',
    'json-bearer-secret-456',
    'arbitrary-secret-value',
    'bare-bearer-secret~789',
    'dXNlcjpwYXNzd29yZA==',
    'auth-token-secret-123',
    ['sk', 'live', 'abcdefghijklmnopqrstuvwxyz'].join('_'),
    'glpat-abcdefghijklmnopqrstuvwxyz',
    'pretty-json-secret-001',
    'pretty-client-secret-002'
  ] as const
  const capture = new PiStartupDiagnosticCapture(options())
  capture.push(`Error: Failed to load extension "${extensionPath}":
Authorization: "Bearer ${secrets[0]}"
{"authorization":"Bearer ${secrets[1]}"}
{'token':'${secrets[2]}'}
Bearer ${secrets[3]}
Basic ${secrets[4]}
auth_token=${secrets[5]}
live=${secrets[6]}
gitlab=${secrets[7]}
{"token":
  "${secrets[8]}"}
{"client_secret"
  :
  "${secrets[9]}"}
cookie=[session-secret-value]`)
  const diagnostic = capture.finalize({ code: 1 })

  assert.equal(diagnostic.source, 'global:extensions/bad.ts')
  for (const secret of [...secrets, 'session-secret-value']) {
    assert.equal(diagnostic.summary.includes(secret), false, `leaked ${secret}`)
  }
  assert.equal(diagnostic.summary.includes(PI_DIAGNOSTIC_REDACTION), true)
  assert.equal(diagnostic.summary.includes('Authorization:'), false)
  assert.equal(diagnostic.summary.includes('"authorization"'), false)
  assert.equal(diagnostic.summary.includes("'token'"), false)
  assert.equal(diagnostic.summary.includes('Pi rejected the extension during startup.'), false)
  assert.equal(diagnostic.redacted, true)
})

test('standard secret environment names are snapshotted and redacted', () => {
  const envSecrets = {
    PGPASSWORD: 'postgres-password-secret-001',
    MYSQL_PWD: 'mysql-password-secret-002',
    'NPM_CONFIG_//registry.npmjs.org/:_authToken': 'npm-auth-token-secret-003'
  } as const
  const capture = new PiStartupDiagnosticCapture(options(envSecrets))
  capture.push(`postgres=${envSecrets.PGPASSWORD}
mysql=${envSecrets.MYSQL_PWD}
npm=${envSecrets['NPM_CONFIG_//registry.npmjs.org/:_authToken']}`)

  const diagnostic = capture.finalize({ code: 1 })

  for (const secret of Object.values(envSecrets)) {
    assert.equal(diagnostic.summary.includes(secret), false, `leaked ${secret}`)
  }
  assert.equal(diagnostic.redacted, true)
})

test('credential redaction fails closed for short auth, structured keys, headers, and escaped values', () => {
  const cases = [
    { input: 'failure Basic Zm9v', secret: 'Zm9v' },
    { input: 'failure Bearer abc1234', secret: 'abc1234' },
    { input: 'OPENAI_API_KEY=ordinary-opaque-secret-value', secret: 'ordinary-opaque-secret-value' },
    { input: 'DB_PASSWORD=database-password-secret-value', secret: 'database-password-secret-value' },
    { input: 'AWS_SECRET_ACCESS_KEY=aws-secret-access-value', secret: 'aws-secret-access-value' },
    { input: 'MY_TOKEN=custom-token-secret-value', secret: 'custom-token-secret-value' },
    { input: 'AUTH=opaque-auth-value', secret: 'opaque-auth-value' },
    { input: 'SERVICE_AUTH=service-auth-secret-value', secret: 'service-auth-secret-value' },
    {
      input: 'NPM_CONFIG_//registry.npmjs.org/:_authToken=npm-config-token-secret',
      secret: 'npm-config-token-secret'
    },
    { input: 'private_key=super-secret-private-material', secret: 'super-secret-private-material' },
    { input: 'credentials=plural-credential-secret', secret: 'plural-credential-secret' },
    { input: 'tokens=plural-token-secret', secret: 'plural-token-secret' },
    { input: 'cookies=plural-cookie-secret', secret: 'plural-cookie-secret' },
    { input: 'openaiApiKey=camel-api-key-secret', secret: 'camel-api-key-secret' },
    { input: 'githubToken=camel-github-token-secret', secret: 'camel-github-token-secret' },
    { input: 'oauthAccessToken=camel-access-token-secret', secret: 'camel-access-token-secret' },
    { input: 'servicePassword=camel-password-secret', secret: 'camel-password-secret' },
    { input: 'databaseCredentials=camel-credentials-secret', secret: 'camel-credentials-secret' },
    { input: 'stripeSecret=camel-stripe-secret', secret: 'camel-stripe-secret' },
    { input: 'sessionCookie=camel-cookie-secret', secret: 'camel-cookie-secret' },
    { input: 'awsAccessKey=camel-access-key-secret', secret: 'camel-access-key-secret' },
    { input: 'openaiapikey=compact-api-key-secret', secret: 'compact-api-key-secret' },
    { input: 'OPENAIAPIKEY=uppercase-compact-api-key-secret', secret: 'uppercase-compact-api-key-secret' },
    { input: 'githubtoken=compact-token-secret', secret: 'compact-token-secret' },
    { input: 'servicepassword=compact-password-secret', secret: 'compact-password-secret' },
    { input: 'databasecredentials=compact-credentials-secret', secret: 'compact-credentials-secret' },
    { input: 'API Key: COMMON-SPACED-API-SECRET', secret: 'COMMON-SPACED-API-SECRET' },
    { input: 'Access Key: COMMON-SPACED-ACCESS-SECRET', secret: 'COMMON-SPACED-ACCESS-SECRET' },
    { input: 'Private Key: COMMON-SPACED-PRIVATE-SECRET', secret: 'COMMON-SPACED-PRIVATE-SECRET' },
    { input: 'Session Key: COMMON-SPACED-SESSION-SECRET', secret: 'COMMON-SPACED-SESSION-SECRET' },
    { input: 'headers["Authorization"]="Digest SECRET-BRACKET-VALUE"', secret: 'SECRET-BRACKET-VALUE' },
    { input: "config['api_key']='BRACKET-API-KEY-SECRET'", secret: 'BRACKET-API-KEY-SECRET' },
    { input: 'tokens[0]=BRACKET-TOKEN-SECRET', secret: 'BRACKET-TOKEN-SECRET' },
    { input: 'credentials[primary]=BRACKET-CREDENTIAL-SECRET', secret: 'BRACKET-CREDENTIAL-SECRET' },
    { input: 'env[OPENAI_API_KEY]=BRACKET-ENV-SECRET', secret: 'BRACKET-ENV-SECRET' },
    { input: 'tokens[0][1]=MULTI-BRACKET-TOKEN-SECRET', secret: 'MULTI-BRACKET-TOKEN-SECRET' },
    { input: 'env=OPENAI_API_KEY=NESTED-API-KEY-SECRET', secret: 'NESTED-API-KEY-SECRET' },
    { input: 'config=token=NESTED-TOKEN-SECRET', secret: 'NESTED-TOKEN-SECRET' },
    { input: 'payload=AUTH=NESTED-AUTH-SECRET', secret: 'NESTED-AUTH-SECRET' },
    { input: 'outer=API Key=NESTED-SPACED-KEY-SECRET', secret: 'NESTED-SPACED-KEY-SECRET' },
    {
      input: 'headers["Authorization"][0]="MULTI-BRACKET-AUTH-SECRET"',
      secret: 'MULTI-BRACKET-AUTH-SECRET'
    },
    {
      input: 'Authorization: Digest username="alice", response="digest-secret-response"',
      secret: 'digest-secret-response'
    },
    {
      input: 'Authorization: AWS4-HMAC-SHA256 Credential=visible, Signature=AWS-SIGNATURE-SECRET',
      secret: 'AWS-SIGNATURE-SECRET'
    },
    { input: 'Cookie: harmless=1; session=COOKIE-SECRET-TWO', secret: 'COOKIE-SECRET-TWO' },
    {
      input: '-----BEGIN X-FOO PRIVATE KEY-----\nHYPHENATED-PRIVATE-KEY-BODY\n-----END X-FOO PRIVATE KEY-----',
      secret: 'HYPHENATED-PRIVATE-KEY-BODY'
    },
    { input: '{"token":"abc\\\\\\"SUPERSECRET-JSON-SUFFIX"}', secret: 'SUPERSECRET-JSON-SUFFIX' },
    { input: "{'token':'abc\\\\'SUPERSECRET-SINGLE-SUFFIX'}", secret: 'SUPERSECRET-SINGLE-SUFFIX' },
    { input: 'token: |-\n  YAML-BLOCK-SECRET-SUFFIX', secret: 'YAML-BLOCK-SECRET-SUFFIX' }
  ] as const

  for (const entry of cases) {
    const capture = new PiStartupDiagnosticCapture(options())
    capture.push(`${entry.input}\nVISIBLE_AFTER_SECRET`)
    const diagnostic = capture.finalize({ code: 1 })

    assert.equal(JSON.stringify(diagnostic).includes(entry.secret), false, `leaked ${entry.secret}`)
    assert.equal(diagnostic.summary.includes(PI_DIAGNOSTIC_REDACTION), true)
    assert.equal(diagnostic.redacted, true)
  }

  const safePrefixCapture = new PiStartupDiagnosticCapture(options())
  safePrefixCapture.push('reason=C1.1_SAFE_REASON authorization: Bearer SAFE-PREFIX-SECRET')
  const safePrefixDiagnostic = safePrefixCapture.finalize({ code: 1 })
  assert.equal(safePrefixDiagnostic.summary.includes('C1.1_SAFE_REASON'), true)
  assert.equal(safePrefixDiagnostic.summary.includes('SAFE-PREFIX-SECRET'), false)

  const urlCapture = new PiStartupDiagnosticCapture(options())
  urlCapture.push('url=https://alice:p@ssword@example.test/private')
  const urlDiagnostic = urlCapture.finalize({ code: 1 })
  assert.equal(urlDiagnostic.summary.includes('alice'), false)
  assert.equal(urlDiagnostic.summary.includes('ssword'), false)
  assert.equal(urlDiagnostic.summary.includes('https://[REDACTED]@example.test/private'), true)
})

test('benign assignment and environment names containing secret substrings remain visible', () => {
  const benignEntries = {
    author: 'Ada Lovelace',
    authority: 'local coordinator',
    tokenizer: 'wordpiece',
    secretary: 'coordinator',
    cookiecutter: 'project template',
    signatureAlgorithm: 'ed25519 SAFE_REASON'
  } as const

  for (const [name, value] of Object.entries(benignEntries)) {
    const capture = new PiStartupDiagnosticCapture(options({ [name.toUpperCase()]: value }))
    capture.push(`${name}=${value}`)
    const diagnostic = capture.finalize({ code: 1 })

    assert.equal(diagnostic.summary.endsWith(`${name}=${value}`), true, `over-redacted ${name}`)
    assert.equal(diagnostic.redacted, false, `marked benign ${name} as redacted`)
  }

  const sensitiveCapture = new PiStartupDiagnosticCapture(options())
  sensitiveCapture.push('reason=C1.1_SAFE_REASON githubToken=ASSIGNMENT-SUFFIX-SECRET')
  const sensitiveDiagnostic = sensitiveCapture.finalize({ code: 1 })
  assert.equal(sensitiveDiagnostic.summary.includes('C1.1_SAFE_REASON'), true)
  assert.equal(sensitiveDiagnostic.summary.includes('ASSIGNMENT-SUFFIX-SECRET'), false)
  assert.equal(sensitiveDiagnostic.summary.includes(PI_DIAGNOSTIC_REDACTION), true)
  assert.equal(sensitiveDiagnostic.redacted, true)
})

test('generic path sanitization consumes ambiguous suffixes and malformed extension lines', () => {
  const pathCases = [
    '/Users/alice/private,corp/customer.ts',
    '/Users/alice/private;corp/customer.ts',
    '/Users/alice/private)corp/customer.ts',
    '/Users/alice/private corp/customer.ts',
    '/Users/alice/private\\\\\\"SECRET-SUFFIX/customer.ts',
    'file:///Users/alice/private,corp/customer.ts',
    'file:///Users/alice/private corp/customer.ts',
    'C://Users/alice/private/customer.ts',
    `${'\\'.repeat(3)}server\\share\\alice\\private\\customer.ts`,
    `${'\\'.repeat(4)}server\\share\\alice\\private\\customer.ts`,
    `{"path":"${'\\'.repeat(4)}server\\share\\alice\\private\\customer.ts"}`
  ] as const

  for (const path of pathCases) {
    const capture = new PiStartupDiagnosticCapture(options())
    capture.push(`failure=${path}`)
    const diagnostic = capture.finalize({ code: 1 })
    const serialized = JSON.stringify(diagnostic)

    for (const forbidden of ['alice', 'customer.ts', 'SECRET-SUFFIX']) {
      assert.equal(serialized.includes(forbidden), false, `leaked ${forbidden} from ${path}`)
    }
    assert.equal(diagnostic.summary.includes('external:<redacted>'), true)
    assert.equal(diagnostic.redacted, true)
  }

  for (const malformedPath of [
    '/Users/alice/private\\\\\\"ABSOLUTE-SECRET-SUFFIX/customer.ts',
    './.pi/extensions/safe\\\\\\"RELATIVE-SECRET-SUFFIX/customer.ts',
    '/Users/alice/private\nABSOLUTE-SECRET-SUFFIX/customer.ts',
    './.pi/extensions/safe\nRELATIVE-SECRET-SUFFIX/customer.ts'
  ]) {
    const capture = new PiStartupDiagnosticCapture(options())
    capture.push(`Error: Failed to load extension "${malformedPath}": forged reason`)
    const diagnostic = capture.finalize({ code: 1 })
    const serialized = JSON.stringify(diagnostic)

    assert.equal(diagnostic.code, 'PI_STARTUP_FAILED')
    assert.equal(diagnostic.source, 'unknown')
    assert.equal(serialized.includes('SECRET-SUFFIX'), false)
    assert.equal(serialized.includes('customer.ts'), false)
    assert.equal(diagnostic.redacted, true)
  }
})

test('cutoff boundaries redact common and exact-env credentials for every byte total and chunking', () => {
  const cases = [
    {
      value: 'sk-project-dummy-credential-0123456789',
      captureOptions: options()
    },
    {
      value: 'ultra-sensitive-secret-0123456789',
      captureOptions: options({ SERVICE_API_KEY: 'ultra-sensitive-secret-0123456789' })
    }
  ] as const
  const splitIndex = 12

  for (const entry of cases) {
    for (const totalBytes of [
      PI_STARTUP_STDERR_LIMIT_BYTES - 1,
      PI_STARTUP_STDERR_LIMIT_BYTES,
      PI_STARTUP_STDERR_LIMIT_BYTES + 1
    ]) {
      const secret = Buffer.from(entry.value)
      const secretStart = PI_STARTUP_STDERR_LIMIT_BYTES / 2 - splitIndex
      const suffix = Buffer.from('\nSAFE_BOUNDARY_TAIL\n')
      const trailingBytes = totalBytes - secretStart - secret.length - suffix.length
      assert.ok(trailingBytes >= 0)
      const raw = Buffer.concat([Buffer.alloc(secretStart), secret, suffix, Buffer.alloc(trailingBytes)])
      assert.equal(raw.length, totalBytes)

      for (const chunkSizes of [[1], [8_191, 1, 3], [raw.length]] as const) {
        const diagnostic = captureBuffer(raw, chunkSizes, entry.captureOptions).finalize({ code: 1 })
        const serialized = JSON.stringify(diagnostic)

        assert.equal(serialized.includes(entry.value), false)
        assert.equal(serialized.includes(entry.value.slice(0, splitIndex)), false)
        assert.equal(serialized.includes(entry.value.slice(splitIndex + 1)), false)
        assert.equal(diagnostic.redacted, true)
        assert.equal(diagnostic.truncated, totalBytes > PI_STARTUP_STDERR_LIMIT_BYTES)
        if (diagnostic.truncated) assert.equal(diagnostic.summary.endsWith('SAFE_BOUNDARY_TAIL'), true)
      }
    }
  }
})

test('cutoff boundaries redact multiline environment values and split private-key blocks', () => {
  const multilineSecret = 'SECRET-HEADER\nSECRET-LINE-ONE\nSECRET-LINE-TWO'
  const splitIndex = 6
  const secretStart = PI_STARTUP_STDERR_LIMIT_BYTES / 2 - splitIndex
  const suffix = Buffer.from('\nSAFE_MULTILINE_TAIL\n')
  const trailingBytes =
    PI_STARTUP_STDERR_LIMIT_BYTES + 1 - secretStart - Buffer.byteLength(multilineSecret) - suffix.length
  const multilineRaw = Buffer.concat([
    Buffer.alloc(secretStart),
    Buffer.from(multilineSecret),
    suffix,
    Buffer.alloc(trailingBytes)
  ])
  const multilineDiagnostic = captureBuffer(
    multilineRaw,
    [1, 8_191, 1, 3],
    options({ SERVICE_API_KEY: multilineSecret })
  ).finalize({ code: 1 })

  for (const fragment of ['SECRET-HEADER', 'SECRET-LINE-ONE', 'SECRET-LINE-TWO']) {
    assert.equal(JSON.stringify(multilineDiagnostic).includes(fragment), false)
  }
  assert.equal(multilineDiagnostic.summary.endsWith('SAFE_MULTILINE_TAIL'), true)
  assert.equal(multilineDiagnostic.redacted, true)

  const begin = '-----BEGIN PRIVATE KEY-----'
  for (const entry of [
    {
      splitIndex: 1,
      body: '\nLINE-ONE-PRIVATE-KEY-SECRET\nLINE-TWO-PRIVATE-KEY-SECRET'
    },
    {
      splitIndex: 2,
      body: '\nLINE-ONE-PRIVATE-KEY-SECRET\nLINE-TWO-PRIVATE-KEY-SECRET'
    },
    {
      splitIndex: 10,
      body: '\nLINE-ONE-PRIVATE-KEY-SECRET\nLINE-TWO-PRIVATE-KEY-SECRET\n-----END PRIVATE KEY-----'
    }
  ] as const) {
    const beginStart = PI_STARTUP_STDERR_LIMIT_BYTES / 2 - entry.splitIndex
    const privateSuffix = Buffer.from(`${entry.body}\nSAFE_PRIVATE_KEY_TAIL\n`)
    const privateTrailingBytes =
      PI_STARTUP_STDERR_LIMIT_BYTES + 1 - beginStart - Buffer.byteLength(begin) - privateSuffix.length
    const privateRaw = Buffer.concat([
      Buffer.alloc(beginStart),
      Buffer.from(begin),
      privateSuffix,
      Buffer.alloc(privateTrailingBytes)
    ])
    const privateDiagnostic = captureBuffer(privateRaw, [8_191, 1, 3]).finalize({ code: 1 })
    const privateSerialized = JSON.stringify(privateDiagnostic)

    for (const forbidden of ['LINE-ONE-PRIVATE-KEY-SECRET', 'LINE-TWO-PRIVATE-KEY-SECRET', 'PRIVATE KEY']) {
      assert.equal(privateSerialized.includes(forbidden), false)
    }
    assert.equal(privateDiagnostic.redacted, true)
    assert.equal(privateDiagnostic.truncated, true)
  }

  const genericBegin = '-----BEGIN X25519 PRIVATE KEY-----'
  for (const splitIndex of [4, 10]) {
    const beginStart = PI_STARTUP_STDERR_LIMIT_BYTES / 2 - splitIndex
    const privateSuffix = Buffer.from('\nGENERIC-PRIVATE-KEY-BODY-SECRET\nSAFE_GENERIC_KEY_TAIL\n')
    const privateTrailingBytes =
      PI_STARTUP_STDERR_LIMIT_BYTES + 1 - beginStart - Buffer.byteLength(genericBegin) - privateSuffix.length
    const privateRaw = Buffer.concat([
      Buffer.alloc(beginStart),
      Buffer.from(genericBegin),
      privateSuffix,
      Buffer.alloc(privateTrailingBytes)
    ])
    const diagnostic = captureBuffer(privateRaw, [1, 8_191, 3]).finalize({ code: 1 })

    assert.equal(JSON.stringify(diagnostic).includes('GENERIC-PRIVATE-KEY-BODY-SECRET'), false)
    assert.equal(diagnostic.redacted, true)
  }

  const largeGapHead = Buffer.concat([Buffer.alloc(PI_STARTUP_STDERR_LIMIT_BYTES / 2 - 4), Buffer.from('----')])
  const largeGapTailText = Buffer.from('SECOND-PRIVATE-BODY-LINE\nTHIRD-PRIVATE-BODY-LINE\n')
  const largeGapTail = Buffer.concat([
    largeGapTailText,
    Buffer.alloc(PI_STARTUP_STDERR_LIMIT_BYTES / 2 - largeGapTailText.length)
  ])
  const largeGapRaw = Buffer.concat([largeGapHead, Buffer.alloc(48, 0x78), largeGapTail])
  const largeGapDiagnostic = captureBuffer(largeGapRaw, [1, 8_191, 3]).finalize({ code: 1 })
  assert.equal(JSON.stringify(largeGapDiagnostic).includes('THIRD-PRIVATE-BODY-LINE'), false)
  assert.equal(largeGapDiagnostic.redacted, true)
})

test('head classification is isolated from cross-gap terminal sequences and literal omission markers', () => {
  const fakePath = join(agentDir, 'extensions', 'tail-spoof.ts')
  const spanningSequences = [
    { open: '\u001b]0;unterminated', close: '\u0007' },
    { open: '\u001b[31', close: 'm' },
    { open: '\u001bPunterminated', close: '\u001b\\' }
  ] as const

  for (const sequence of spanningSequences) {
    const headPrelude = Buffer.from('ordinary startup failure\n')
    const opener = Buffer.from(sequence.open)
    const head = Buffer.concat([
      headPrelude,
      Buffer.alloc(PI_STARTUP_STDERR_LIMIT_BYTES / 2 - headPrelude.length - opener.length),
      opener
    ])
    const tailText = Buffer.from(
      `${sequence.close}Error: Failed to load extension "${fakePath}": tail spoof\nSAFE_REAL_TAIL\n`
    )
    const tail = Buffer.concat([tailText, Buffer.alloc(PI_STARTUP_STDERR_LIMIT_BYTES / 2 - tailText.length)])
    const raw = Buffer.concat([head, Buffer.from('X'), tail])
    const diagnostic = captureBuffer(raw, [1, 8_191, 3]).finalize({ code: 1 })

    assert.equal(diagnostic.code, 'PI_STARTUP_FAILED')
    assert.equal(diagnostic.source, 'unknown')
    assert.equal(diagnostic.summary.includes('Extension load failed ('), false)
    assert.equal(diagnostic.summary.includes(fakePath), false)
  }

  const realPath = join(agentDir, 'extensions', 'real-head.ts')
  const literalHeadText = Buffer.from(
    `attacker literal ${'\n[stderr omitted]\n'}Error: Failed to load extension "${realPath}": REAL_HEAD_REASON\n`
  )
  const literalHead = Buffer.concat([
    literalHeadText,
    Buffer.alloc(PI_STARTUP_STDERR_LIMIT_BYTES / 2 - literalHeadText.length)
  ])
  const literalTailText = Buffer.from('SAFE_LITERAL_TAIL\n')
  const literalTail = Buffer.concat([
    literalTailText,
    Buffer.alloc(PI_STARTUP_STDERR_LIMIT_BYTES / 2 - literalTailText.length)
  ])
  const literalRaw = Buffer.concat([literalHead, Buffer.from('X'), literalTail])
  const literalDiagnostic = captureBuffer(literalRaw, [8_191, 1, 3]).finalize({ code: 1 })

  assert.equal(literalDiagnostic.code, 'PI_EXTENSION_LOAD_FAILED')
  assert.equal(literalDiagnostic.source, 'global:extensions/real-head.ts')
  assert.equal(literalDiagnostic.summary.includes('REAL_HEAD_REASON'), true)
})

test('unsafe exit metadata cannot bypass the final diagnostic sink invariant', () => {
  const cases = [
    { signal: 'sk-ABCDEFGHIJKL' },
    { error: { code: 'sk_agent_ABCDEFGH' } },
    { error: { code: 'ghp_ABCDEFGHIJKL' } },
    { signal: '\u001b[31mSIGTERM' },
    { error: { code: 'TOKEN=secret-value' } }
  ] as const

  for (const exit of cases) {
    const capture = new PiStartupDiagnosticCapture(options())
    const diagnostic = capture.finalize(exit)
    assert.equal(diagnostic.source, 'unknown')
    assert.equal(diagnostic.summary, 'Pi failed to start before the RPC channel became ready.')
    const serialized = JSON.stringify(diagnostic)
    for (const forbidden of ['sk-', 'sk_agent_', 'ghp_', 'TOKEN=', '\u001b']) {
      assert.equal(serialized.includes(forbidden), false)
    }
  }
})

test('summary truncation is byte-bounded, source-pinned, Unicode-safe, deterministic, and cached', () => {
  const extensionPath = join(agentDir, 'extensions', 'unicode.ts')
  const bytes = Buffer.from(
    `Error: Failed to load extension "${extensionPath}": ${'界🙂'.repeat(12_000)}\nFINAL_REASON`,
    'utf8'
  )

  const firstCapture = captureBuffer(bytes, [1, 8_191, 2, 509])
  const secondCapture = captureBuffer(bytes, [16_383, 7, 31])
  const first = firstCapture.finalize({ code: 1 })
  const second = secondCapture.finalize({ code: 1 })

  assert.deepEqual(first, second)
  assert.equal(first.truncated, true)
  assert.equal(first.summary.includes('\ufffd'), false)
  assert.equal(first.summary.endsWith('FINAL_REASON'), true)
  assert.equal(
    first.summary.startsWith(`Extension load failed (global:extensions/unicode.ts):\n${PI_STARTUP_TRUNCATION_MARKER}`),
    true
  )
  assert.ok(Buffer.byteLength(first.summary, 'utf8') <= PI_STARTUP_SUMMARY_LIMIT_BYTES)

  firstCapture.push('ignored after finalization')
  assert.strictEqual(firstCapture.finalize({ code: 99 }), first)
})

test('discard clears startup bytes and permanently ignores runtime stderr', () => {
  const capture = new PiStartupDiagnosticCapture(options())
  capture.push('startup prelude that must not remain in session memory')
  capture.discard()
  capture.push(`Error: Failed to load extension "${join(agentDir, 'extensions', 'runtime.ts')}": too late`)

  const diagnostic = capture.finalize({ code: 9 })

  assert.equal(diagnostic.code, 'PI_STARTUP_FAILED')
  assert.equal(diagnostic.source, 'unknown')
  assert.equal(diagnostic.summary, 'Pi failed to start (code=9).')
  assert.equal(diagnostic.redacted, false)
  assert.equal(diagnostic.truncated, false)
})
