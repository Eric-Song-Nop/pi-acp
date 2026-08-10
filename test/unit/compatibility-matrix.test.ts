import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { z } from 'zod'
import { compatibilityMatrixSchema, readCompatibilityMatrix } from '../helpers/compatibility-matrix.js'

const packageManifestSchema = z
  .object({
    name: z.string(),
    version: z.string(),
    dependencies: z.record(z.string()),
    devDependencies: z.record(z.string()),
    engines: z.object({ node: z.string() }).strict()
  })
  .passthrough()

const packageLockSchema = z
  .object({
    packages: z.record(
      z
        .object({
          version: z.string().optional(),
          resolved: z.string().optional(),
          integrity: z.string().optional()
        })
        .passthrough()
    )
  })
  .passthrough()

const expectedDevelopmentAdvisories = [
  'GHSA-23c5-xmqv-rm74',
  'GHSA-25h7-pfq9-p65f',
  'GHSA-3jxr-9vmj-r5cp',
  'GHSA-3ppc-4f35-3m26',
  'GHSA-3v7f-55p6-f55p',
  'GHSA-4cwx-7wf7-3272',
  'GHSA-52cp-r559-cp3m',
  'GHSA-5p4m-2wfm-xmqj',
  'GHSA-7p8r-x3mc-p8w7',
  'GHSA-7r86-cg39-jmmj',
  'GHSA-8xcm-r25x-g524',
  'GHSA-c2c7-rcm5-vvqj',
  'GHSA-f886-m6hf-6m8v',
  'GHSA-h67p-54hq-rp68',
  'GHSA-jr45-8vmc-qm54',
  'GHSA-m8rv-5g2x-5cg5',
  'GHSA-mh99-v99m-4gvg',
  'GHSA-mw96-cpmx-2vgc',
  'GHSA-rf6f-7fwh-wjgh',
  'GHSA-rgw5-rvv9-x895',
  'GHSA-v3r7-h72x-cjcm'
] as const

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
}

function readText(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

test('compatibility matrix v2 strictly matches locked package and toolchain metadata', () => {
  const matrix = readCompatibilityMatrix()
  const manifest = packageManifestSchema.parse(readJson('../../package.json'))
  const lock = packageLockSchema.parse(readJson('../../package-lock.json'))

  assert.equal(matrix.schemaVersion, 2)
  assert.equal(matrix.adapter.package, manifest.name)
  assert.equal(matrix.adapter.version, manifest.version)
  assert.equal(matrix.node.minimumVersion, manifest.engines.node.replace(/^>=/, ''))
  assert.equal(readText('../../.node-version'), `${matrix.node.minimumVersion}\n`)
  assert.equal(matrix.ci.nodeVersion, matrix.node.minimumVersion)
  assert.equal(matrix.node.npmVersion, matrix.dependencyAudit.tool.version)

  assert.equal(manifest.dependencies['@agentclientprotocol/sdk'], matrix.acp.sdkVersion)
  assert.equal(manifest.devDependencies['@earendil-works/pi-coding-agent'], matrix.pi.baselineVersion)
  assert.deepEqual(
    {
      version: lock.packages['node_modules/@agentclientprotocol/sdk']?.version,
      resolved: lock.packages['node_modules/@agentclientprotocol/sdk']?.resolved,
      integrity: lock.packages['node_modules/@agentclientprotocol/sdk']?.integrity
    },
    {
      version: matrix.acp.sdkVersion,
      resolved: `https://registry.npmjs.org/@agentclientprotocol/sdk/-/sdk-${matrix.acp.sdkVersion}.tgz`,
      integrity: matrix.acp.sdkIntegrity
    }
  )
  assert.deepEqual(
    {
      version: lock.packages['node_modules/@earendil-works/pi-coding-agent']?.version,
      resolved: lock.packages['node_modules/@earendil-works/pi-coding-agent']?.resolved,
      integrity: lock.packages['node_modules/@earendil-works/pi-coding-agent']?.integrity
    },
    {
      version: matrix.pi.baselineVersion,
      resolved:
        `https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/` +
        `pi-coding-agent-${matrix.pi.baselineVersion}.tgz`,
      integrity: matrix.pi.baselineIntegrity
    }
  )
})

test('compatibility matrix accepts only canonical statuses and strict v2 provenance identities', () => {
  const matrix = readCompatibilityMatrix()
  const verificationStatuses = [
    'todo',
    'in_progress',
    'blocked',
    'in_review',
    'verified',
    'regressed',
    'waived',
    'retired'
  ] as const

  for (const status of verificationStatuses) {
    assert.equal(
      compatibilityMatrixSchema.safeParse({
        ...matrix,
        e2eStatus: status
      }).success,
      true,
      `verification status ${status} must be accepted`
    )
  }

  assert.equal(
    compatibilityMatrixSchema.safeParse({
      ...matrix,
      untrackedAxis: 'must fail'
    }).success,
    false
  )
  assert.equal(
    compatibilityMatrixSchema.safeParse({
      ...matrix,
      pi: {
        ...matrix.pi,
        baselineGitHead: 'not-a-git-sha'
      }
    }).success,
    false
  )
  assert.equal(
    compatibilityMatrixSchema.safeParse({
      ...matrix,
      e2eStatus: 'planned'
    }).success,
    false
  )

  const rejectedVariants: readonly [label: string, value: unknown][] = [
    ['schema v1', { ...matrix, schemaVersion: 1 }],
    [
      'wrong Pi repository',
      {
        ...matrix,
        pi: { ...matrix.pi, repository: 'example/pi' }
      }
    ],
    [
      'wrong ACP repository',
      {
        ...matrix,
        acp: { ...matrix.acp, repository: 'example/typescript-sdk' }
      }
    ],
    [
      'non-SHA-512 Pi minimum integrity',
      {
        ...matrix,
        pi: { ...matrix.pi, minimumIntegrity: 'sha256-not-an-sri' }
      }
    ],
    [
      'non-SHA-512 Pi baseline integrity',
      {
        ...matrix,
        pi: { ...matrix.pi, baselineIntegrity: 'sha512-contains spaces' }
      }
    ],
    [
      'short SHA-512 Pi baseline integrity',
      {
        ...matrix,
        pi: { ...matrix.pi, baselineIntegrity: 'sha512-YQ==' }
      }
    ],
    [
      'non-SHA-512 ACP integrity',
      {
        ...matrix,
        acp: { ...matrix.acp, sdkIntegrity: 'sha1-deadbeef' }
      }
    ],
    [
      'CI Node drift',
      {
        ...matrix,
        ci: { ...matrix.ci, nodeVersion: matrix.node.baselineVersion }
      }
    ],
    [
      'audit npm drift',
      {
        ...matrix,
        dependencyAudit: {
          ...matrix.dependencyAudit,
          tool: { ...matrix.dependencyAudit.tool, version: '10.9.2' }
        }
      }
    ],
    [
      'runtime audit total drift',
      {
        ...matrix,
        dependencyAudit: {
          ...matrix.dependencyAudit,
          runtime: { ...matrix.dependencyAudit.runtime, total: 1 }
        }
      }
    ],
    [
      'development audit total drift',
      {
        ...matrix,
        dependencyAudit: {
          ...matrix.dependencyAudit,
          development: { ...matrix.dependencyAudit.development, total: 5 }
        }
      }
    ],
    [
      'duplicate advisory',
      {
        ...matrix,
        dependencyAudit: {
          ...matrix.dependencyAudit,
          developmentAdvisories: [
            ...matrix.dependencyAudit.developmentAdvisories,
            matrix.dependencyAudit.developmentAdvisories.at(-1)
          ]
        }
      }
    ],
    [
      'unsorted advisories',
      {
        ...matrix,
        dependencyAudit: {
          ...matrix.dependencyAudit,
          developmentAdvisories: [...matrix.dependencyAudit.developmentAdvisories].reverse()
        }
      }
    ],
    [
      'malformed advisory',
      {
        ...matrix,
        dependencyAudit: {
          ...matrix.dependencyAudit,
          runtimeAdvisories: ['CVE-2026-0001']
        }
      }
    ],
    [
      'execution policy drift',
      {
        ...matrix,
        ci: { ...matrix.ci, executionNetwork: 'best-effort-offline' }
      }
    ],
    [
      'gate policy drift',
      {
        ...matrix,
        ci: { ...matrix.ci, requiredGates: [...matrix.ci.requiredGates].reverse() }
      }
    ]
  ]

  for (const [label, value] of rejectedVariants) {
    assert.equal(compatibilityMatrixSchema.safeParse(value).success, false, `${label} must be rejected`)
  }
})

test('compatibility matrix pins the exact repositories, source identities, and npm SRIs', () => {
  const matrix = readCompatibilityMatrix()

  assert.deepEqual(matrix.pi, {
    package: '@earendil-works/pi-coding-agent',
    repository: 'earendil-works/pi',
    minimumVersion: '0.80.5',
    minimumGitHead: 'cc62baa442b5c0333923fdfdcc1d7264f445b5b0',
    minimumIntegrity: 'sha512-GPYFuHw1BN+3m5Gzw1HGH41WdFDzbplLauS0zYSf1ZOkgKFd6wtEAcjchB/vmz9YtTGbQOwECbsVj6GxZxungA==',
    baselineVersion: '0.83.0',
    baselineGitHead: '845d6ff1f6643aba440341cce877ce1c43ebbc39',
    baselineIntegrity:
      'sha512-uYhF+FsZxogoSX/AxBcUdiY+ZklubwaXyAoEGA2eQwsHcyEAhUYIKh/WLXe/a8+k8eTCmxb+ZN2Zo9mzQtzbWw==',
    headRef: 'main',
    outsideWindow: 'best-effort'
  })
  assert.deepEqual(matrix.acp, {
    protocolVersion: 1,
    sdkPackage: '@agentclientprotocol/sdk',
    repository: 'agentclientprotocol/typescript-sdk',
    sdkVersion: '0.26.0',
    sdkGitHead: '73bc30649b650de320340c782733bf69a545bd28',
    sdkIntegrity: 'sha512-ialrcI+RzKOYe+fw+TfpyTdRmEoqIkXLlwbTi6XgaXXfdhNcdod7TmE1VsTnG3yTlox8TMTSMQgWbLLbz3r86Q=='
  })
})

test('compatibility matrix pins the C0.3 execution and checkout policy', () => {
  const matrix = readCompatibilityMatrix()

  assert.equal(matrix.e2eStatus, 'verified')
  assert.deepEqual(matrix.ci, {
    checkpoint: 'C0.3',
    runner: 'ubuntu-24.04',
    nodeVersion: '22.19.0',
    containerImage: 'node:22.19.0-bookworm@sha256:afff6d8c97964a438d2e6a9c96509367e45d8bf93f790ad561a1eaea926303d9',
    checkoutActionSha: '11d5960a326750d5838078e36cf38b85af677262',
    setupNodeActionSha: '49933ea5288caeca8642d1e84afbd3f7d6820020',
    requiredGates: ['provenance', 'typecheck', 'lint', 'test', 'build', 'real-pi-e2e'],
    dependencyAcquisitionNetwork: 'networked-preflight',
    executionNetwork: 'docker-none-loopback-only',
    testedAdapterShaSource: 'git-rev-parse-head',
    expectedAdapterShaSource: 'github-event-head-sha'
  })
})

test('compatibility docs bind every pin and status to its canonical role', () => {
  const matrix = readCompatibilityMatrix()
  const baseline = readText('../../docs/command-compatibility/BASELINE.md')
  const tracker = readText('../../docs/command-compatibility/TRACKER.md')
  const readme = readText('../../README.md')

  const labeledBaselineLines = [
    `pi-acp ${matrix.adapter.version} @ ${matrix.adapter.baselineSha}`,
    `× Pi ${matrix.pi.minimumVersion} (minimum) / ${matrix.pi.baselineVersion} (baseline)`,
    `× ACP protocol ${matrix.acp.protocolVersion} / TypeScript SDK ${matrix.acp.sdkVersion}`,
    `× Node ${matrix.node.minimumVersion} minimum / ${matrix.node.baselineVersion} baseline / ${matrix.node.recordedVersion} recorded`,
    `× Zed ${matrix.clients.zed.version} build ${matrix.clients.zed.build}`,
    `× ${matrix.clients.nonZed.name} ${matrix.clients.nonZed.version} @ ${matrix.clients.nonZed.commit}`,
    `- \`e2eStatus\`: \`${matrix.e2eStatus}\``,
    `- \`clients.zed.status\`: \`${matrix.clients.zed.status}\` (\`${matrix.clients.zed.verification}\`)`,
    `- \`clients.nonZed.status\`: \`${matrix.clients.nonZed.status}\` (\`${matrix.clients.nonZed.verification}\`)`,
    `- Pi \`${matrix.pi.minimumVersion}\` (\`${matrix.pi.repository}\`): \`${matrix.pi.minimumGitHead}\`; npm SRI \`${matrix.pi.minimumIntegrity}\``,
    `- Pi \`${matrix.pi.baselineVersion}\` (\`${matrix.pi.repository}\`): \`${matrix.pi.baselineGitHead}\`; npm SRI \`${matrix.pi.baselineIntegrity}\``,
    `- ACP SDK \`${matrix.acp.sdkVersion}\` (\`${matrix.acp.repository}\`): \`${matrix.acp.sdkGitHead}\`; npm SRI \`${matrix.acp.sdkIntegrity}\``,
    `- Zed \`${matrix.clients.zed.ref}\`: \`${matrix.clients.zed.commit}\``,
    `- ${matrix.clients.nonZed.name} \`${matrix.clients.nonZed.ref}\`: \`${matrix.clients.nonZed.commit}\``,
    `- \`.node-version\`: \`${matrix.ci.nodeVersion}\`; npm: \`${matrix.node.npmVersion}\``,
    `- CI image: \`${matrix.ci.containerImage}\` (\`linux/amd64\`)`,
    `- Acquisition/provenance network: \`${matrix.ci.dependencyAcquisitionNetwork}\`; execution network: \`${matrix.ci.executionNetwork}\``
  ]

  const normalizedBaseline = baseline.replace(/\s+/gu, ' ')
  for (const expectedLine of labeledBaselineLines) {
    assert.ok(normalizedBaseline.includes(expectedLine), `BASELINE.md must bind its canonical role as: ${expectedLine}`)
  }

  assert.ok(
    readme.includes(`npm install -g ${matrix.pi.package}@${matrix.pi.baselineVersion}`),
    'README must use a reproducible pinned Pi install command'
  )
  assert.ok(
    readme.includes(`${matrix.pi.minimumVersion}–${matrix.pi.baselineVersion}`),
    'README must contain the target Pi test window'
  )
  assert.match(readme, /target test window/i)
  assert.match(readme, /G5/)

  assert.match(tracker, /\| `C0\.3`[^\n]+\| `verified`\s+\|/u)
  assert.match(tracker, /\| `C0\.7`[^\n]+\| `verified`\s+\|/u)
  for (const phrase of [
    'testedCheckoutSha',
    'expectedCheckoutSha',
    'Linux/amd64',
    'Pi `0.83.0`',
    'networked preflight',
    'loopback-only'
  ]) {
    assert.ok(tracker.includes(phrase), `TRACKER.md must document the C0.3 boundary: ${phrase}`)
  }
})

test('compatibility matrix records exact live audit totals, advisories, and follow-up', () => {
  const matrix = readCompatibilityMatrix()

  assert.deepEqual(matrix.dependencyAudit.runtime, {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
    total: 0
  })
  assert.deepEqual(matrix.dependencyAudit.runtimeAdvisories, [])
  assert.deepEqual(matrix.dependencyAudit.development, {
    info: 0,
    low: 0,
    moderate: 1,
    high: 8,
    critical: 0,
    total: 9
  })
  assert.deepEqual(matrix.dependencyAudit.developmentAdvisories, expectedDevelopmentAdvisories)
  assert.deepEqual(matrix.dependencyAudit.tool, {
    name: 'npm',
    version: '10.9.3',
    registry: 'https://registry.npmjs.org/'
  })
  assert.equal(matrix.dependencyAudit.followUpCheckpoint, 'C5.8')
})
