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

test('compatibility matrix rejects unknown fields, malformed identities, and non-workflow statuses', () => {
  const matrix = readCompatibilityMatrix()

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

test('compatibility docs contain every pinned version and source identity', () => {
  const matrix = readCompatibilityMatrix()
  const baseline = readText('../../docs/command-compatibility/BASELINE.md')
  const readme = readText('../../README.md')

  const baselinePins = [
    matrix.adapter.version,
    matrix.adapter.baselineSha,
    matrix.pi.minimumVersion,
    matrix.pi.minimumGitHead,
    matrix.pi.baselineVersion,
    matrix.pi.baselineGitHead,
    matrix.acp.sdkVersion,
    matrix.acp.sdkGitHead,
    matrix.node.minimumVersion,
    matrix.node.baselineVersion,
    matrix.node.recordedVersion,
    matrix.clients.zed.version,
    matrix.clients.zed.build,
    matrix.clients.zed.commit,
    matrix.clients.nonZed.version,
    matrix.clients.nonZed.commit
  ]

  for (const pin of baselinePins) {
    assert.ok(baseline.includes(pin), `BASELINE.md must contain ${pin}`)
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
    moderate: 1,
    high: 6,
    critical: 0
  })
  assert.equal(matrix.dependencyAudit.followUpCheckpoint, 'C5.8')
})
