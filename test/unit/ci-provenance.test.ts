import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import {
  isolatedGitNetworkEnvironment,
  parseArgs,
  runIsolatedGitNetworkCommand,
  sanitizedCommandEnvironment
} from '../../scripts/check-ci-provenance.js'
import {
  assertAuditSnapshot,
  assertExactToolchain,
  assertGitCheckout,
  classifyMutableIdentity,
  githubRepositoryUrl,
  githubRunUrl,
  githubTagRef,
  gitLsRemoteTagArgs,
  parseAuditReport,
  parseOptionalGitSha,
  registryTagUrl,
  registryTarballUrl,
  registryVersionUrl,
  resolveGitLsRemoteTagCommit,
  validateLockedNpmPackagePin,
  validateNpmPackagePin,
  type AuditCounts,
  type NpmPinExpectation
} from '../helpers/ci-provenance.js'
import { readCompatibilityMatrix } from '../helpers/compatibility-matrix.js'

const EXPECTED_SHA = '1234567890abcdef1234567890abcdef12345678'
const OTHER_SHA = 'abcdef1234567890abcdef1234567890abcdef12'
const INTEGRITY = 'sha512-uYhF+FsZxogoSX/AxBcUdiY+ZklubwaXyAoEGA2eQwsHcyEAhUYIKh/WLXe/a8+k8eTCmxb+ZN2Zo9mzQtzbWw=='
const PACKAGE_PIN: NpmPinExpectation = {
  package: '@earendil-works/pi-coding-agent',
  version: '0.83.0',
  gitHead: EXPECTED_SHA,
  integrity: INTEGRITY
}
const ZERO_COUNTS: AuditCounts = {
  info: 0,
  low: 0,
  moderate: 0,
  high: 0,
  critical: 0,
  total: 0
}
const HIGH_COUNTS: AuditCounts = {
  info: 0,
  low: 0,
  moderate: 0,
  high: 1,
  critical: 0,
  total: 1
}
const execFileAsync = promisify(execFile)

function auditSource(counts: AuditCounts, vulnerabilities: Record<string, unknown> = {}): string {
  return JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {
      vulnerabilities: counts,
      dependencies: {
        total: 1
      }
    }
  })
}

test('C0.3 provenance requires the exact matrix Node and npm identities', () => {
  const matrix = readCompatibilityMatrix()

  assert.doesNotThrow(() => assertExactToolchain(matrix, matrix.ci.nodeVersion, matrix.node.npmVersion))
  assert.throws(() => assertExactToolchain(matrix, '22.19.1', matrix.node.npmVersion), /exact declared Node runtime/u)
  assert.throws(() => assertExactToolchain(matrix, matrix.ci.nodeVersion, '10.9.4'), /exact declared npm runtime/u)

  const inconsistent = structuredClone(matrix)
  inconsistent.dependencyAudit.tool.version = '10.9.4'
  assert.throws(
    () => assertExactToolchain(inconsistent, inconsistent.ci.nodeVersion, inconsistent.node.npmVersion),
    /audit tool identity/u
  )
})

test('C0.3 provenance binds the exact clean checkout and strict CLI input', () => {
  assert.deepEqual(parseArgs(['--expected-adapter-sha', EXPECTED_SHA]), {
    expectedAdapterSha: EXPECTED_SHA
  })
  assert.doesNotThrow(() => assertGitCheckout(EXPECTED_SHA, EXPECTED_SHA, ''))

  assert.throws(() => parseArgs([]), /usage:/u)
  assert.throws(() => parseArgs(['--expected-adapter-sha', EXPECTED_SHA.toUpperCase()]), /usage:/u)
  assert.throws(() => parseArgs(['--unknown', EXPECTED_SHA]), /usage:/u)
  assert.throws(() => assertGitCheckout(EXPECTED_SHA, OTHER_SHA, ''), /tested checkout SHA/u)
  assert.throws(() => assertGitCheckout(EXPECTED_SHA, EXPECTED_SHA, '?? generated.json\n'), /clean checkout/u)
  assert.throws(() => assertGitCheckout(EXPECTED_SHA, EXPECTED_SHA, ' '), /clean checkout/u)
  assert.throws(() => assertGitCheckout('not-a-sha', EXPECTED_SHA, ''))
})

test('C0.3 provenance subprocesses isolate configuration and reject ambient transport hooks', () => {
  const cacheDir = join('/tmp', 'c0.3-provenance-test')
  const env = sanitizedCommandEnvironment(cacheDir)

  assert.equal(env.npm_config_userconfig, join(cacheDir, 'npm-userconfig'))
  assert.equal(env.npm_config_globalconfig, join(cacheDir, 'npm-globalconfig'))
  assert.notEqual(env.npm_config_userconfig, env.npm_config_globalconfig)
  assert.equal(env.npm_config_registry, 'https://registry.npmjs.org/')
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1')
  assert.equal(env.GIT_CONFIG_SYSTEM, '/dev/null')
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null')
  assert.equal(env.GIT_CONFIG_COUNT, '0')
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(env.GIT_ASKPASS, '')
  assert.equal(env.GIT_OPTIONAL_LOCKS, '0')
  for (const key of [
    'GIT_CONFIG',
    'GIT_CONFIG_PARAMETERS',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_VALUE_0',
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_SSH',
    'GIT_SSH_COMMAND',
    'GIT_PROXY_COMMAND',
    'GIT_SSL_NO_VERIFY',
    'SSH_ASKPASS',
    'SSH_ASKPASS_REQUIRE',
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy'
  ]) {
    assert.equal(Object.hasOwn(env, key), false, `${key} must not reach provenance subprocesses`)
  }

  const gitEnv = isolatedGitNetworkEnvironment(cacheDir)
  assert.equal(gitEnv.GIT_CEILING_DIRECTORIES, dirname(cacheDir))
  assert.equal(gitEnv.GIT_DISCOVERY_ACROSS_FILESYSTEM, '0')
  assert.equal(gitEnv.GIT_ALLOW_PROTOCOL, 'https')
})

test('C0.3 provenance canonicalizes GitHub event and run identities without credentials', () => {
  assert.equal(parseOptionalGitSha(EXPECTED_SHA), EXPECTED_SHA)
  assert.equal(parseOptionalGitSha(undefined), null)
  assert.throws(() => parseOptionalGitSha('refs/pull/1/merge'))
  assert.equal(
    githubRunUrl('example/project', '123456789'),
    'https://github.com/example/project/actions/runs/123456789'
  )
  assert.equal(githubRunUrl(undefined, undefined), null)
  assert.throws(() => githubRunUrl('../escape', '123'))
  assert.throws(() => githubRunUrl('example/project', '0'))
  assert.throws(() => githubRunUrl('example/project', undefined))
})

test('C0.3 mutable identities are observed explicitly but drift and malformed data remain warn-only', () => {
  assert.deepEqual(classifyMutableIdentity('Pi latest', 'version', '0.83.0', '0.83.0'), {
    value: '0.83.0'
  })
  assert.deepEqual(classifyMutableIdentity('Pi latest', 'version', '0.83.0', '0.84.0'), {
    value: '0.84.0',
    warning: 'Pi latest observed 0.84.0, different from pinned 0.83.0; mutable drift is warn-only'
  })
  assert.deepEqual(classifyMutableIdentity('Pi main', 'git-sha', EXPECTED_SHA, OTHER_SHA), {
    value: OTHER_SHA,
    warning: `Pi main observed ${OTHER_SHA}, different from pinned ${EXPECTED_SHA}; mutable drift is warn-only`
  })
  assert.deepEqual(classifyMutableIdentity('Pi main', 'git-sha', EXPECTED_SHA, undefined), {
    warning: 'Pi main returned no valid git-sha identity; mutable observation unavailable (warn-only)'
  })
})

test('C0.3 registry URLs are canonical and reject path-like package input', () => {
  assert.equal(
    registryVersionUrl('@earendil-works/pi-coding-agent', '0.83.0').href,
    'https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent/0.83.0'
  )
  assert.equal(
    registryTarballUrl('@earendil-works/pi-coding-agent', '0.83.0').href,
    'https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-0.83.0.tgz'
  )
  assert.equal(registryVersionUrl('plain-package', '1.2.3').href, 'https://registry.npmjs.org/plain-package/1.2.3')
  assert.equal(
    registryTagUrl('@earendil-works/pi-coding-agent', 'latest').href,
    'https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent/latest'
  )
  assert.throws(() => registryVersionUrl('../escape', '1.2.3'))
  assert.throws(() => registryTarballUrl('@scope/package', '../latest'))
  assert.throws(() => registryTagUrl('@scope/package', '../latest'))
})

test('C0.3 npm registry and lock provenance require exact package identities', () => {
  const registryValue = {
    name: PACKAGE_PIN.package,
    version: PACKAGE_PIN.version,
    gitHead: PACKAGE_PIN.gitHead,
    dist: {
      integrity: PACKAGE_PIN.integrity,
      tarball: registryTarballUrl(PACKAGE_PIN.package, PACKAGE_PIN.version).href,
      signatures: []
    },
    ignoredRegistryMetadata: true
  }
  const lockValue = {
    version: PACKAGE_PIN.version,
    resolved: registryTarballUrl(PACKAGE_PIN.package, PACKAGE_PIN.version).href,
    integrity: PACKAGE_PIN.integrity,
    dev: true
  }

  assert.doesNotThrow(() => validateNpmPackagePin(PACKAGE_PIN, registryValue))
  assert.doesNotThrow(() => validateLockedNpmPackagePin(PACKAGE_PIN, lockValue))

  for (const [field, value] of [
    ['name', '@attacker/pi-coding-agent'],
    ['version', '0.83.1'],
    ['gitHead', OTHER_SHA]
  ] as const) {
    assert.throws(() => validateNpmPackagePin(PACKAGE_PIN, { ...registryValue, [field]: value }))
  }
  assert.throws(() =>
    validateNpmPackagePin(PACKAGE_PIN, {
      ...registryValue,
      dist: { ...registryValue.dist, integrity: `sha512-${'YQ=='.padStart(88, 'A')}` }
    })
  )
  assert.throws(() =>
    validateNpmPackagePin(PACKAGE_PIN, {
      ...registryValue,
      dist: { ...registryValue.dist, tarball: 'https://mirror.invalid/package.tgz' }
    })
  )
  assert.throws(() => validateNpmPackagePin({ ...PACKAGE_PIN, integrity: 'sha512-YQ==' }, registryValue))
  assert.throws(() =>
    validateLockedNpmPackagePin(PACKAGE_PIN, {
      ...lockValue,
      resolved: 'https://mirror.invalid/package.tgz'
    })
  )
  assert.throws(() => validateLockedNpmPackagePin(PACKAGE_PIN, { ...lockValue, integrity: undefined }))
  assert.throws(() => validateNpmPackagePin({ ...PACKAGE_PIN, package: '../escape' }, registryValue))
})

test('C0.3 audit parsing binds exact totals, exit status, and sorted GHSA identities', () => {
  assert.deepEqual(parseAuditReport(auditSource(ZERO_COUNTS), 0), {
    counts: ZERO_COUNTS,
    advisories: []
  })

  const observed = parseAuditReport(
    auditSource(HIGH_COUNTS, {
      vulnerable: {
        via: [
          'transitive-package',
          { url: 'https://github.com/advisories/GHSA-zzzz-1111-aaaa' },
          { url: 'https://github.com/advisories/GHSA-aaaa-2222-bbbb' },
          { url: 'https://github.com/advisories/GHSA-zzzz-1111-aaaa' }
        ]
      }
    }),
    1
  )
  assert.deepEqual(observed, {
    counts: HIGH_COUNTS,
    advisories: ['GHSA-aaaa-2222-bbbb', 'GHSA-zzzz-1111-aaaa']
  })

  assert.throws(() => parseAuditReport(auditSource(HIGH_COUNTS), 0), /exit status/u)
  assert.throws(() => parseAuditReport(auditSource(ZERO_COUNTS), 1), /exit status/u)
  assert.throws(() => parseAuditReport(auditSource(ZERO_COUNTS), 2), /status 0 or 1/u)
  assert.throws(() => parseAuditReport(auditSource({ ...HIGH_COUNTS, total: 2 }), 1))
  assert.throws(() => parseAuditReport('{', 0))
  assert.throws(() =>
    parseAuditReport(
      auditSource(HIGH_COUNTS, {
        vulnerable: {
          via: [{ url: 'http://github.com/advisories/GHSA-aaaa-2222-bbbb' }]
        }
      }),
      1
    )
  )
  assert.throws(() =>
    parseAuditReport(
      auditSource(HIGH_COUNTS, {
        vulnerable: {
          via: [{ url: 'https://github.com/advisories/not-a-ghsa' }]
        }
      }),
      1
    )
  )
  assert.throws(() =>
    parseAuditReport(
      auditSource(HIGH_COUNTS, {
        vulnerable: {
          via: [{ url: 'https://security.example/advisory/1' }]
        }
      }),
      1
    )
  )
  assert.throws(() =>
    parseAuditReport(
      auditSource(HIGH_COUNTS, {
        vulnerable: {
          via: [{}]
        }
      }),
      1
    )
  )
})

test('C0.3 audit snapshot rejects both count and advisory substitution', () => {
  const observed = {
    counts: HIGH_COUNTS,
    advisories: ['GHSA-aaaa-2222-bbbb']
  }
  assert.doesNotThrow(() => assertAuditSnapshot('development', HIGH_COUNTS, ['GHSA-aaaa-2222-bbbb'], observed))
  assert.throws(
    () => assertAuditSnapshot('development', ZERO_COUNTS, ['GHSA-aaaa-2222-bbbb'], observed),
    /severity counts drifted/u
  )
  assert.throws(
    () => assertAuditSnapshot('development', HIGH_COUNTS, ['GHSA-zzzz-1111-aaaa'], observed),
    /advisory identities drifted/u
  )
  assert.throws(() => assertAuditSnapshot('development', HIGH_COUNTS, ['not-an-advisory'], observed))
  assert.throws(() =>
    assertAuditSnapshot('development', HIGH_COUNTS, ['GHSA-zzzz-1111-aaaa', 'GHSA-aaaa-2222-bbbb'], observed)
  )
  assert.throws(() => assertAuditSnapshot('development', { ...HIGH_COUNTS, total: 2 }, observed.advisories, observed))
})

test('C0.3 Git smart-HTTP tag provenance accepts canonical lightweight and annotated tags', () => {
  const tag = 'v1.2.3'
  const directRef = githubTagRef(tag)
  const peeledRef = `${directRef}^{}`

  assert.equal(githubRepositoryUrl('example/project'), 'https://github.com/example/project.git')
  assert.equal(directRef, 'refs/tags/v1.2.3')
  assert.deepEqual(gitLsRemoteTagArgs('example/project', tag), [
    '--git-dir=/dev/null',
    '-c',
    'credential.helper=',
    '-c',
    'core.askPass=',
    '-c',
    'http.extraHeader=',
    '-c',
    'http.proxy=',
    'ls-remote',
    '--exit-code',
    '--tags',
    'https://github.com/example/project.git',
    directRef,
    peeledRef
  ])
  assert.equal(resolveGitLsRemoteTagCommit(tag, `${EXPECTED_SHA}\t${directRef}\n`), EXPECTED_SHA)
  assert.equal(
    resolveGitLsRemoteTagCommit(tag, `${EXPECTED_SHA}\t${directRef}\n${OTHER_SHA}\t${peeledRef}\n`),
    OTHER_SHA
  )
})

test('C0.3 Git smart-HTTP provenance excludes repository-local scoped transport configuration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-acp-c0.3-git-config-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  const checkout = join(root, 'checkout')
  const isolatedCwd = join(checkout, 'network-git')
  await mkdir(isolatedCwd, { recursive: true })
  await execFileAsync('git', ['init', '--quiet'], { cwd: checkout })

  const canonicalUrl = githubRepositoryUrl('example/project')
  const poisonBase = 'file:///controlled-mirror/'
  const poisonEntries = [
    ['credential.https://github.com.helper', '!printf credential-poison'],
    ['http.https://github.com/.extraHeader', 'Authorization: header-poison'],
    ['http.https://github.com/.proxy', 'http://127.0.0.1:1'],
    [`url.${poisonBase}.insteadOf`, 'https://github.com/']
  ] as const
  for (const [key, value] of poisonEntries) {
    await execFileAsync('git', ['config', '--local', key, value], { cwd: checkout })
  }

  const unisolatedEnv = sanitizedCommandEnvironment(await realpath(isolatedCwd))
  const unisolatedOptions = { cwd: isolatedCwd, env: unisolatedEnv, encoding: 'utf8' as const }
  assert.equal(
    (
      await execFileAsync('git', ['config', '--get-urlmatch', 'credential.helper', canonicalUrl], unisolatedOptions)
    ).stdout.trim(),
    '!printf credential-poison'
  )
  assert.equal(
    (
      await execFileAsync('git', ['config', '--get-urlmatch', 'http.extraHeader', canonicalUrl], unisolatedOptions)
    ).stdout.trim(),
    'Authorization: header-poison'
  )
  assert.equal(
    (
      await execFileAsync('git', ['config', '--get-urlmatch', 'http.proxy', canonicalUrl], unisolatedOptions)
    ).stdout.trim(),
    'http://127.0.0.1:1'
  )

  const productionArgs = gitLsRemoteTagArgs('example/project', 'v1.2.3')
  const lsRemoteIndex = productionArgs.indexOf('ls-remote')
  assert.notEqual(lsRemoteIndex, -1)
  const getUrlArgs = [...productionArgs.slice(0, lsRemoteIndex + 1), '--get-url', canonicalUrl]
  const vulnerableGetUrlArgs = getUrlArgs.filter(arg => arg !== '--git-dir=/dev/null')
  assert.equal(
    (await execFileAsync('git', vulnerableGetUrlArgs, unisolatedOptions)).stdout.trim(),
    `${poisonBase}example/project.git`
  )
  assert.equal((await execFileAsync('git', getUrlArgs, unisolatedOptions)).stdout.trim(), canonicalUrl)

  const canonicalIsolatedCwd = await realpath(isolatedCwd)
  assert.equal((await runIsolatedGitNetworkCommand(canonicalIsolatedCwd, getUrlArgs)).stdout.trim(), canonicalUrl)
  for (const match of [
    ['credential.helper', canonicalUrl],
    ['http.extraHeader', canonicalUrl],
    ['http.proxy', canonicalUrl]
  ] as const) {
    assert.deepEqual(
      await runIsolatedGitNetworkCommand(canonicalIsolatedCwd, ['config', '--get-urlmatch', match[0], match[1]], {
        allowedExitCodes: [1]
      }),
      { code: 1, stdout: '' }
    )
  }
})

test('C0.3 Git smart-HTTP tag provenance rejects path escape and ambiguous output', () => {
  const tag = 'v1.2.3'
  const directRef = githubTagRef(tag)
  const peeledRef = `${directRef}^{}`

  assert.throws(() => githubRepositoryUrl('../escape'))
  assert.throws(() => githubTagRef('../escape'))
  assert.throws(() => gitLsRemoteTagArgs('../escape', tag))
  assert.throws(() => gitLsRemoteTagArgs('example/project', '../escape'))
  assert.throws(() => resolveGitLsRemoteTagCommit(tag, ''))
  assert.throws(() => resolveGitLsRemoteTagCommit(tag, `${OTHER_SHA}\t${peeledRef}\n`), /did not return/u)
  assert.throws(() => resolveGitLsRemoteTagCommit(tag, `${EXPECTED_SHA}\trefs/tags/v9.9.9\n`), /unexpected record/u)
  assert.throws(
    () => resolveGitLsRemoteTagCommit(tag, `${EXPECTED_SHA}\t${directRef}\n${OTHER_SHA}\t${directRef}\n`),
    /duplicate record/u
  )
  assert.throws(
    () => resolveGitLsRemoteTagCommit(tag, `${EXPECTED_SHA.toUpperCase()}\t${directRef}\n`),
    /unexpected record/u
  )
  assert.throws(() => resolveGitLsRemoteTagCommit(tag, `${EXPECTED_SHA}\t${directRef}\r\n`), /malformed output/u)
})
