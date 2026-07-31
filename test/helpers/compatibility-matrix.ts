import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { z } from 'zod'

const exactVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/)
const gitShaSchema = z.string().regex(/^[0-9a-f]{40}$/)
const sha512IntegritySchema = z
  .string()
  .regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/)
  .refine(value => {
    const encoded = value.slice('sha512-'.length)
    const digest = Buffer.from(encoded, 'base64')
    return digest.length === 64 && digest.toString('base64') === encoded
  }, 'expected a canonical 64-byte SHA-512 digest')
const githubAdvisorySchema = z.string().regex(/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/)
const verificationStatusSchema = z.enum([
  'todo',
  'in_progress',
  'blocked',
  'in_review',
  'verified',
  'regressed',
  'waived',
  'retired'
])
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

function parseVersion(value: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value)
  if (!match) throw new Error(`Expected an exact semantic version, received ${value}`)
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

export const compatibilityMatrixSchema = z
  .object({
    schemaVersion: z.literal(2),
    planId: z.literal('PACP-CMD-2026-01'),
    recordedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    e2eStatus: verificationStatusSchema,
    adapter: z
      .object({
        package: z.literal('pi-acp'),
        version: exactVersionSchema,
        baselineSha: gitShaSchema
      })
      .strict(),
    pi: z
      .object({
        package: z.literal('@earendil-works/pi-coding-agent'),
        repository: z.literal('earendil-works/pi'),
        minimumVersion: exactVersionSchema,
        minimumGitHead: gitShaSchema,
        minimumIntegrity: sha512IntegritySchema,
        baselineVersion: exactVersionSchema,
        baselineGitHead: gitShaSchema,
        baselineIntegrity: sha512IntegritySchema,
        headRef: z.literal('main'),
        outsideWindow: z.literal('best-effort')
      })
      .strict(),
    acp: z
      .object({
        protocolVersion: z.literal(1),
        sdkPackage: z.literal('@agentclientprotocol/sdk'),
        repository: z.literal('agentclientprotocol/typescript-sdk'),
        sdkVersion: exactVersionSchema,
        sdkGitHead: gitShaSchema,
        sdkIntegrity: sha512IntegritySchema
      })
      .strict(),
    node: z
      .object({
        minimumVersion: exactVersionSchema,
        baselineVersion: exactVersionSchema,
        recordedVersion: exactVersionSchema,
        npmVersion: exactVersionSchema
      })
      .strict(),
    clients: z
      .object({
        zed: z
          .object({
            version: exactVersionSchema,
            build: z.string().regex(/^\d{8}\.\d{6}$/),
            repository: z.literal('zed-industries/zed'),
            ref: z.string(),
            commit: gitShaSchema,
            status: verificationStatusSchema,
            verification: z.literal('manual')
          })
          .strict(),
        nonZed: z
          .object({
            name: z.literal('CodeCompanion.nvim'),
            repository: z.literal('olimorris/codecompanion.nvim'),
            version: exactVersionSchema,
            ref: z.string(),
            commit: gitShaSchema,
            status: verificationStatusSchema,
            verification: z.literal('manual')
          })
          .strict()
      })
      .strict(),
    dependencyAudit: z
      .object({
        tool: z
          .object({
            name: z.literal('npm'),
            version: exactVersionSchema,
            registry: z.literal('https://registry.npmjs.org/')
          })
          .strict(),
        runtime: auditCountsSchema,
        runtimeAdvisories: z.array(githubAdvisorySchema),
        development: auditCountsSchema,
        developmentAdvisories: z.array(githubAdvisorySchema),
        followUpCheckpoint: z.literal('C5.8')
      })
      .strict(),
    ci: z
      .object({
        checkpoint: z.literal('C0.3'),
        runner: z.literal('ubuntu-24.04'),
        nodeVersion: exactVersionSchema,
        containerImage: z.literal(
          'node:22.19.0-bookworm@sha256:afff6d8c97964a438d2e6a9c96509367e45d8bf93f790ad561a1eaea926303d9'
        ),
        checkoutActionSha: gitShaSchema,
        setupNodeActionSha: gitShaSchema,
        requiredGates: z.tuple([
          z.literal('provenance'),
          z.literal('typecheck'),
          z.literal('lint'),
          z.literal('test'),
          z.literal('build'),
          z.literal('real-pi-e2e')
        ]),
        dependencyAcquisitionNetwork: z.literal('networked-preflight'),
        executionNetwork: z.literal('docker-none-loopback-only'),
        testedAdapterShaSource: z.literal('git-rev-parse-head'),
        expectedAdapterShaSource: z.literal('github-event-head-sha')
      })
      .strict()
  })
  .strict()
  .superRefine((matrix, context) => {
    if (compareVersions(matrix.pi.minimumVersion, matrix.pi.baselineVersion) > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pi', 'minimumVersion'],
        message: 'Pi minimumVersion must not exceed baselineVersion'
      })
    }

    if (compareVersions(matrix.node.minimumVersion, matrix.node.baselineVersion) > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['node', 'minimumVersion'],
        message: 'Node minimumVersion must not exceed baselineVersion'
      })
    }

    if (compareVersions(matrix.node.baselineVersion, matrix.node.recordedVersion) > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['node', 'baselineVersion'],
        message: 'Node baselineVersion must not exceed recordedVersion'
      })
    }

    if (matrix.node.minimumVersion !== matrix.ci.nodeVersion) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ci', 'nodeVersion'],
        message: 'C0.3 CI nodeVersion must equal the declared minimum Node version'
      })
    }

    if (matrix.node.npmVersion !== matrix.dependencyAudit.tool.version) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['dependencyAudit', 'tool', 'version'],
        message: 'dependency audit npm version must match the pinned Node toolchain npm version'
      })
    }

    for (const [path, counts] of [
      [['dependencyAudit', 'runtime'], matrix.dependencyAudit.runtime],
      [['dependencyAudit', 'development'], matrix.dependencyAudit.development]
    ] as const) {
      const calculatedTotal = counts.info + counts.low + counts.moderate + counts.high + counts.critical
      if (counts.total !== calculatedTotal) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, 'total'],
          message: 'audit total must equal the sum of every severity'
        })
      }
    }

    for (const [path, advisories] of [
      [['dependencyAudit', 'runtimeAdvisories'], matrix.dependencyAudit.runtimeAdvisories],
      [['dependencyAudit', 'developmentAdvisories'], matrix.dependencyAudit.developmentAdvisories]
    ] as const) {
      const sorted = [...advisories].sort()
      if (
        new Set(advisories).size !== advisories.length ||
        advisories.some((value, index) => value !== sorted[index])
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path],
          message: 'audit advisory identifiers must be unique and sorted'
        })
      }
    }

    if (matrix.clients.zed.ref !== `v${matrix.clients.zed.version}`) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['clients', 'zed', 'ref'],
        message: 'Zed ref must match its exact version'
      })
    }

    if (matrix.clients.nonZed.ref !== `v${matrix.clients.nonZed.version}`) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['clients', 'nonZed', 'ref'],
        message: 'non-Zed ref must match its exact version'
      })
    }
  })

export type CompatibilityMatrix = z.infer<typeof compatibilityMatrixSchema>

export function readCompatibilityMatrix(
  path: URL = new URL('../e2e/compatibility-matrix.json', import.meta.url)
): CompatibilityMatrix {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
  return compatibilityMatrixSchema.parse(raw)
}
