import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { z } from 'zod'
import { compatibilityMatrixSchema, readCompatibilityMatrix } from '../helpers/compatibility-matrix.js'

const packageManifestSchema = z
  .object({
    version: z.string(),
    dependencies: z.record(z.string()),
    engines: z.object({ node: z.string() }).strict()
  })
  .passthrough()

const packageLockSchema = z
  .object({
    packages: z.record(z.object({ version: z.string().optional() }).passthrough())
  })
  .passthrough()

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
}

function readText(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

test('compatibility matrix strictly matches locked package metadata', () => {
  const matrix = readCompatibilityMatrix()
  const manifest = packageManifestSchema.parse(readJson('../../package.json'))
  const lock = packageLockSchema.parse(readJson('../../package-lock.json'))

  assert.equal(matrix.adapter.version, manifest.version)
  assert.equal(matrix.node.minimumVersion, manifest.engines.node.replace(/^>=/, ''))
  assert.equal(manifest.dependencies['@agentclientprotocol/sdk'], matrix.acp.sdkVersion)
  assert.equal(matrix.acp.sdkVersion, lock.packages['node_modules/@agentclientprotocol/sdk']?.version)
})

test('compatibility matrix accepts only canonical verification statuses and valid source identities', () => {
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
})

test('compatibility docs bind every pin and status to its canonical role', () => {
  const matrix = readCompatibilityMatrix()
  const baseline = readText('../../docs/command-compatibility/BASELINE.md')
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
    `- Pi \`${matrix.pi.minimumVersion}\`: \`${matrix.pi.minimumGitHead}\``,
    `- Pi \`${matrix.pi.baselineVersion}\`: \`${matrix.pi.baselineGitHead}\``,
    `- ACP SDK \`${matrix.acp.sdkVersion}\`: \`${matrix.acp.sdkGitHead}\``,
    `- Zed \`${matrix.clients.zed.ref}\`: \`${matrix.clients.zed.commit}\``,
    `- ${matrix.clients.nonZed.name} \`${matrix.clients.nonZed.ref}\`: \`${matrix.clients.nonZed.commit}\``
  ]

  const baselineLines = new Set(baseline.split(/\r?\n/))
  for (const expectedLine of labeledBaselineLines) {
    assert.ok(baselineLines.has(expectedLine), `BASELINE.md must bind its canonical role as: ${expectedLine}`)
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
})

test('compatibility matrix records the dependency audit follow-up', () => {
  const matrix = readCompatibilityMatrix()

  assert.deepEqual(matrix.dependencyAudit.runtime, {
    moderate: 0,
    high: 0,
    critical: 0
  })
  assert.deepEqual(matrix.dependencyAudit.development, {
    moderate: 0,
    high: 6,
    critical: 0
  })
  assert.equal(matrix.dependencyAudit.followUpCheckpoint, 'C5.8')
})
