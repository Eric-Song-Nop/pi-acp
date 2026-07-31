import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

type CompatibilityMatrix = {
  e2eStatus: string
  adapter: {
    version: string
    baselineSha: string
  }
  pi: {
    minimumVersion: string
    minimumGitHead: string
    baselineVersion: string
    baselineGitHead: string
  }
  acp: {
    protocolVersion: number
    sdkVersion: string
    sdkGitHead: string
  }
  node: {
    minimumVersion: string
    baselineVersion: string
    recordedVersion: string
  }
  clients: {
    zed: {
      version: string
      build: string
      ref: string
      commit: string
      status: string
    }
    nonZed: {
      version: string
      ref: string
      commit: string
      status: string
    }
  }
  dependencyAudit: {
    runtime: {
      moderate: number
      high: number
      critical: number
    }
    development: {
      moderate: number
      high: number
      critical: number
    }
    followUpCheckpoint: string
  }
}

type PackageManifest = {
  version: string
  dependencies: Record<string, string>
  engines: {
    node: string
  }
}

type PackageLock = {
  packages: Record<string, { version?: string }>
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as T
}

function parseVersion(value: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value)
  assert.ok(match, `expected an exact semantic version, received ${value}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left)
  const rightParts = parseVersion(right)

  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index] - rightParts[index]
    if (difference !== 0) return difference
  }

  return 0
}

test('compatibility matrix matches locked package metadata', () => {
  const matrix = readJson<CompatibilityMatrix>('../e2e/compatibility-matrix.json')
  const manifest = readJson<PackageManifest>('../../package.json')
  const lock = readJson<PackageLock>('../../package-lock.json')

  assert.equal(matrix.adapter.version, manifest.version)
  assert.match(matrix.adapter.baselineSha, /^[0-9a-f]{40}$/)
  assert.equal(matrix.node.minimumVersion, manifest.engines.node.replace(/^>=/, ''))
  assert.equal(manifest.dependencies['@agentclientprotocol/sdk'], matrix.acp.sdkVersion)
  assert.equal(matrix.acp.sdkVersion, lock.packages['node_modules/@agentclientprotocol/sdk']?.version)
  assert.equal(matrix.acp.protocolVersion, 1)
  assert.equal(matrix.e2eStatus, 'planned')
  assert.match(matrix.acp.sdkGitHead, /^[0-9a-f]{40}$/)
})

test('compatibility matrix pins ordered Pi, runtime, and client versions', () => {
  const matrix = readJson<CompatibilityMatrix>('../e2e/compatibility-matrix.json')

  assert.ok(compareVersions(matrix.pi.minimumVersion, matrix.pi.baselineVersion) <= 0)
  assert.match(matrix.pi.minimumGitHead, /^[0-9a-f]{40}$/)
  assert.match(matrix.pi.baselineGitHead, /^[0-9a-f]{40}$/)
  assert.ok(compareVersions(matrix.node.minimumVersion, matrix.node.baselineVersion) <= 0)
  assert.ok(compareVersions(matrix.node.baselineVersion, matrix.node.recordedVersion) <= 0)
  parseVersion(matrix.node.recordedVersion)
  parseVersion(matrix.clients.zed.version)
  assert.match(matrix.clients.zed.build, /^\d{8}\.\d{6}$/)
  assert.equal(matrix.clients.zed.ref, `v${matrix.clients.zed.version}`)
  assert.match(matrix.clients.zed.commit, /^[0-9a-f]{40}$/)
  assert.equal(matrix.clients.zed.status, 'planned')
  parseVersion(matrix.clients.nonZed.version)
  assert.equal(matrix.clients.nonZed.ref, `v${matrix.clients.nonZed.version}`)
  assert.match(matrix.clients.nonZed.commit, /^[0-9a-f]{40}$/)
  assert.equal(matrix.clients.nonZed.status, 'planned')
})

test('compatibility matrix records the dependency audit follow-up', () => {
  const matrix = readJson<CompatibilityMatrix>('../e2e/compatibility-matrix.json')

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
