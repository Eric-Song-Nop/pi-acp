import assert from 'node:assert/strict'
import { z } from 'zod'
import type { CompatibilityMatrix } from './compatibility-matrix.js'

const exactVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/u)
const gitShaSchema = z.string().regex(/^[0-9a-f]{40}$/u)
const npmPackageNameSchema = z.string().regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u)
const npmDistTagSchema = z.string().regex(/^[a-z][a-z0-9._-]*$/u)
const githubRepositorySchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)
  .refine(
    value => value.split('/').every(segment => segment !== '.' && segment !== '..'),
    'GitHub repository segments must not traverse paths'
  )
const githubRunIdSchema = z.string().regex(/^[1-9]\d*$/u)
const sha512IntegritySchema = z.string().superRefine((value, context) => {
  const match = /^sha512-([A-Za-z0-9+/]{86}==)$/u.exec(value)
  if (!match) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'expected a canonical SHA-512 SRI value'
    })
    return
  }

  const digest = Buffer.from(match[1], 'base64')
  if (digest.length !== 64 || digest.toString('base64') !== match[1]) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'expected a canonical 64-byte SHA-512 digest'
    })
  }
})
const githubAdvisorySchema = z.string().regex(/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/u)
const auditCountsSchema = z
  .object({
    info: z.number().int().nonnegative(),
    low: z.number().int().nonnegative(),
    moderate: z.number().int().nonnegative(),
    high: z.number().int().nonnegative(),
    critical: z.number().int().nonnegative(),
    total: z.number().int().nonnegative()
  })
  .strict()
const auditReportSchema = z
  .object({
    auditReportVersion: z.literal(2),
    vulnerabilities: z.record(
      z
        .object({
          via: z.array(
            z.union([
              z.string(),
              z
                .object({
                  url: z.string()
                })
                .passthrough()
            ])
          )
        })
        .passthrough()
    ),
    metadata: z
      .object({
        vulnerabilities: auditCountsSchema
      })
      .passthrough()
  })
  .passthrough()
const npmPinExpectationSchema = z
  .object({
    package: npmPackageNameSchema,
    version: exactVersionSchema,
    gitHead: gitShaSchema,
    integrity: sha512IntegritySchema
  })
  .strict()
const npmPackageVersionSchema = z
  .object({
    name: npmPackageNameSchema,
    version: exactVersionSchema,
    gitHead: gitShaSchema,
    dist: z
      .object({
        integrity: sha512IntegritySchema,
        tarball: z.string().url()
      })
      .passthrough()
  })
  .passthrough()
const lockedNpmPackageSchema = z
  .object({
    version: exactVersionSchema,
    resolved: z.string().url(),
    integrity: sha512IntegritySchema
  })
  .passthrough()
const gitHubObjectSchema = z
  .object({
    type: z.enum(['commit', 'tag']),
    sha: gitShaSchema,
    url: z.string().url()
  })
  .strict()
const gitHubRefSchema = z
  .object({
    object: gitHubObjectSchema
  })
  .passthrough()
const gitHubAnnotatedTagSchema = z
  .object({
    sha: gitShaSchema,
    url: z.string().url(),
    object: gitHubObjectSchema
  })
  .passthrough()

export type AuditCounts = z.infer<typeof auditCountsSchema>

export type AuditObservation = {
  counts: AuditCounts
  advisories: string[]
}

export type NpmPinExpectation = z.infer<typeof npmPinExpectationSchema>

export type MutableIdentityObservation = {
  value?: string
  warning?: string
}

export function assertExactToolchain(matrix: CompatibilityMatrix, nodeVersion: string, npmVersion: string): void {
  assert.equal(nodeVersion, matrix.ci.nodeVersion, 'C0.3 requires the exact declared Node runtime')
  assert.equal(npmVersion, matrix.node.npmVersion, 'C0.3 requires the exact declared npm runtime')
  assert.equal(matrix.dependencyAudit.tool.version, npmVersion, 'audit tool identity must match the exact npm runtime')
}

export function assertGitCheckout(expectedSha: string, headSha: string, status: string): void {
  gitShaSchema.parse(expectedSha)
  gitShaSchema.parse(headSha)
  assert.equal(headSha, expectedSha, 'tested checkout SHA must equal the workflow-requested immutable SHA')
  assert.equal(status, '', 'C0.3 provenance must run from a clean checkout')
}

export function parseOptionalGitSha(value: string | undefined): string | null {
  return value === undefined ? null : gitShaSchema.parse(value)
}

export function githubRunUrl(repository: string | undefined, runId: string | undefined): string | null {
  if (repository === undefined && runId === undefined) return null
  const parsedRepository = githubRepositorySchema.parse(repository)
  const parsedRunId = githubRunIdSchema.parse(runId)
  return `https://github.com/${parsedRepository}/actions/runs/${parsedRunId}`
}

export function classifyMutableIdentity(
  label: string,
  kind: 'version' | 'git-sha',
  pinnedValue: string,
  observedValue: unknown
): MutableIdentityObservation {
  const schema = kind === 'version' ? exactVersionSchema : gitShaSchema
  const observed = schema.safeParse(observedValue)
  if (!observed.success) {
    return {
      warning: `${label} returned no valid ${kind} identity; mutable observation unavailable (warn-only)`
    }
  }
  if (observed.data !== pinnedValue) {
    return {
      value: observed.data,
      warning: `${label} observed ${observed.data}, different from pinned ${pinnedValue}; mutable drift is warn-only`
    }
  }
  return { value: observed.data }
}

export function registryVersionUrl(packageName: string, version: string): URL {
  npmPackageNameSchema.parse(packageName)
  exactVersionSchema.parse(version)
  const encodedPackage = encodeURIComponent(packageName).replace(/^%40/u, '@')
  return new URL(`${encodedPackage}/${encodeURIComponent(version)}`, 'https://registry.npmjs.org/')
}

export function registryTagUrl(packageName: string, tag: string): URL {
  npmPackageNameSchema.parse(packageName)
  npmDistTagSchema.parse(tag)
  const encodedPackage = encodeURIComponent(packageName).replace(/^%40/u, '@')
  return new URL(`${encodedPackage}/${encodeURIComponent(tag)}`, 'https://registry.npmjs.org/')
}

export function registryTarballUrl(packageName: string, version: string): URL {
  npmPackageNameSchema.parse(packageName)
  exactVersionSchema.parse(version)
  const tarballName = packageName.slice(packageName.lastIndexOf('/') + 1)
  return new URL(`${packageName}/-/${tarballName}-${version}.tgz`, 'https://registry.npmjs.org/')
}

export function validateNpmPackagePin(expectedValue: NpmPinExpectation, observedValue: unknown): void {
  const expected = npmPinExpectationSchema.parse(expectedValue)
  const observed = npmPackageVersionSchema.parse(observedValue)
  assert.deepEqual(
    {
      package: observed.name,
      version: observed.version,
      gitHead: observed.gitHead,
      integrity: observed.dist.integrity
    },
    expected,
    `${expected.package}@${expected.version} registry provenance drifted`
  )
  assert.equal(
    observed.dist.tarball,
    registryTarballUrl(expected.package, expected.version).href,
    `${expected.package}@${expected.version} registry tarball URL drifted`
  )
}

export function validateLockedNpmPackagePin(expectedValue: NpmPinExpectation, observedValue: unknown): void {
  const expected = npmPinExpectationSchema.parse(expectedValue)
  const observed = lockedNpmPackageSchema.parse(observedValue)
  assert.deepEqual(
    {
      version: observed.version,
      resolved: observed.resolved,
      integrity: observed.integrity
    },
    {
      version: expected.version,
      resolved: registryTarballUrl(expected.package, expected.version).href,
      integrity: expected.integrity
    },
    `${expected.package}@${expected.version} lock provenance drifted`
  )
}

function githubAdvisoryId(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`npm audit returned a malformed advisory URL: ${value}`)
  }
  if (
    url.origin !== 'https://github.com' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error(`npm audit returned a non-canonical GitHub advisory URL: ${value}`)
  }
  const match = /^\/advisories\/(GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/u.exec(url.pathname)
  if (!match) throw new Error(`npm audit returned a malformed GitHub advisory URL: ${value}`)
  return githubAdvisorySchema.parse(match[1])
}

function assertAuditCountsTotal(label: string, counts: AuditCounts): void {
  const calculatedTotal = counts.info + counts.low + counts.moderate + counts.high + counts.critical
  assert.equal(counts.total, calculatedTotal, `${label} audit total must equal the sum of every severity`)
}

export function parseAuditReport(source: string, exitCode: number): AuditObservation {
  assert.ok(exitCode === 0 || exitCode === 1, 'npm audit must exit with status 0 or 1')
  const value: unknown = JSON.parse(source)
  const report = auditReportSchema.parse(value)
  const counts = report.metadata.vulnerabilities
  assertAuditCountsTotal('npm', counts)
  assert.equal(
    exitCode,
    counts.total === 0 ? 0 : 1,
    'npm audit exit status must agree with its exact vulnerability total'
  )

  const advisories = new Set<string>()
  for (const vulnerability of Object.values(report.vulnerabilities)) {
    for (const cause of vulnerability.via) {
      if (typeof cause === 'string') continue
      advisories.add(githubAdvisoryId(cause.url))
    }
  }
  return {
    counts,
    advisories: [...advisories].sort()
  }
}

export function assertAuditSnapshot(
  label: string,
  expectedCounts: AuditCounts,
  expectedAdvisories: readonly string[],
  observed: AuditObservation
): void {
  auditCountsSchema.parse(expectedCounts)
  for (const advisory of expectedAdvisories) githubAdvisorySchema.parse(advisory)
  for (const advisory of observed.advisories) githubAdvisorySchema.parse(advisory)
  assertAuditCountsTotal(label, expectedCounts)
  assertAuditCountsTotal(label, observed.counts)
  assert.deepEqual(
    expectedAdvisories,
    [...new Set(expectedAdvisories)].sort(),
    `${label} expected audit advisory identities must be unique and sorted`
  )
  assert.deepEqual(
    observed.advisories,
    [...new Set(observed.advisories)].sort(),
    `${label} observed audit advisory identities must be unique and sorted`
  )
  assert.deepEqual(observed.counts, expectedCounts, `${label} audit severity counts drifted`)
  assert.deepEqual(observed.advisories, expectedAdvisories, `${label} audit advisory identities drifted`)
}

function assertGitHubObjectUrl(repository: string, object: z.infer<typeof gitHubObjectSchema>): void {
  const url = new URL(object.url)
  const objectKind = object.type === 'commit' ? 'commits' : 'tags'
  const expectedPath = `/repos/${repository}/git/${objectKind}/${object.sha}`
  if (
    url.origin !== 'https://api.github.com' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== expectedPath ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error(`GitHub ${object.type} object escaped the canonical ${repository} API path`)
  }
}

export async function resolveGitHubTagCommit(
  repositoryValue: string,
  initialValue: unknown,
  loadTag: (url: string) => Promise<unknown>
): Promise<string> {
  const repository = githubRepositorySchema.parse(repositoryValue)
  let current = gitHubRefSchema.parse(initialValue).object
  const seenTagObjects = new Set<string>()

  for (let depth = 0; depth < 4; depth += 1) {
    assertGitHubObjectUrl(repository, current)
    if (current.type === 'commit') return current.sha
    if (seenTagObjects.has(current.sha)) {
      throw new Error(`GitHub tag for ${repository} contains a peel cycle`)
    }
    seenTagObjects.add(current.sha)

    const tag = gitHubAnnotatedTagSchema.parse(await loadTag(current.url))
    assert.equal(tag.sha, current.sha, `GitHub tag response SHA changed while peeling ${repository}`)
    assert.equal(tag.url, current.url, `GitHub tag response URL changed while peeling ${repository}`)
    current = tag.object
  }
  throw new Error(`GitHub tag for ${repository} exceeded the maximum peel depth`)
}
