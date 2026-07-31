import assert from 'node:assert/strict'
import test from 'node:test'
import { parseArgs } from '../../scripts/check-ci-provenance.js'
import {
  assertAuditSnapshot,
  assertExactToolchain,
  assertGitCheckout,
  classifyMutableIdentity,
  githubRunUrl,
  parseAuditReport,
  parseOptionalGitSha,
  registryTagUrl,
  registryTarballUrl,
  registryVersionUrl,
  resolveGitHubTagCommit,
  validateLockedNpmPackagePin,
  validateNpmPackagePin,
  type AuditCounts,
  type NpmPinExpectation
} from '../helpers/ci-provenance.js'
import { readCompatibilityMatrix } from '../helpers/compatibility-matrix.js'

const EXPECTED_SHA = '1234567890abcdef1234567890abcdef12345678'
const OTHER_SHA = 'abcdef1234567890abcdef1234567890abcdef12'
const THIRD_SHA = 'fedcba0987654321fedcba0987654321fedcba09'
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

function githubObject(type: 'commit' | 'tag', sha: string, repository = 'example/project') {
  const kind = type === 'commit' ? 'commits' : 'tags'
  return {
    type,
    sha,
    url: `https://api.github.com/repos/${repository}/git/${kind}/${sha}`
  }
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

test('C0.3 GitHub tag provenance accepts canonical lightweight and annotated tags', async () => {
  let lightweightLoads = 0
  assert.equal(
    await resolveGitHubTagCommit('example/project', { object: githubObject('commit', EXPECTED_SHA) }, async () => {
      lightweightLoads += 1
      throw new Error('lightweight tags must not be peeled')
    }),
    EXPECTED_SHA
  )
  assert.equal(lightweightLoads, 0)

  const firstTag = githubObject('tag', EXPECTED_SHA)
  const secondTag = githubObject('tag', OTHER_SHA)
  const commit = githubObject('commit', THIRD_SHA)
  const requested: string[] = []
  assert.equal(
    await resolveGitHubTagCommit('example/project', { object: firstTag }, async url => {
      requested.push(url)
      if (url === firstTag.url) {
        return { sha: firstTag.sha, url: firstTag.url, object: secondTag }
      }
      if (url === secondTag.url) {
        return { sha: secondTag.sha, url: secondTag.url, object: commit }
      }
      throw new Error(`unexpected tag URL: ${url}`)
    }),
    THIRD_SHA
  )
  assert.deepEqual(requested, [firstTag.url, secondTag.url])
})

test('C0.3 GitHub tag provenance rejects path escape, response swap, cycle, and excessive depth', async () => {
  const tag = githubObject('tag', EXPECTED_SHA)

  await assert.rejects(() =>
    resolveGitHubTagCommit(
      'example/project',
      {
        object: {
          ...githubObject('commit', OTHER_SHA),
          url: `https://api.github.com/repos/attacker/project/git/commits/${OTHER_SHA}`
        }
      },
      async () => ({})
    )
  )
  await assert.rejects(
    () =>
      resolveGitHubTagCommit('example/project', { object: tag }, async () => ({
        sha: OTHER_SHA,
        url: tag.url,
        object: githubObject('commit', THIRD_SHA)
      })),
    /response SHA changed/u
  )
  await assert.rejects(
    () =>
      resolveGitHubTagCommit('example/project', { object: tag }, async () => ({
        sha: tag.sha,
        url: tag.url,
        object: tag
      })),
    /peel cycle/u
  )

  const tagShas = [EXPECTED_SHA, OTHER_SHA, THIRD_SHA, '0'.repeat(40), '1'.repeat(40)]
  const tags = tagShas.map(sha => githubObject('tag', sha))
  await assert.rejects(
    () =>
      resolveGitHubTagCommit('example/project', { object: tags[0] }, async url => {
        const index = tags.findIndex(candidate => candidate.url === url)
        const current = tags[index]
        assert.ok(current)
        return {
          sha: current.sha,
          url: current.url,
          object: tags[index + 1] ?? githubObject('commit', '2'.repeat(40))
        }
      }),
    /maximum peel depth/u
  )
})
