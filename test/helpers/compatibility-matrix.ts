import { readFileSync } from 'node:fs'
import { z } from 'zod'

const exactVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/)
const gitShaSchema = z.string().regex(/^[0-9a-f]{40}$/)
const workflowStatusSchema = z.enum(['proposed', 'ready', 'active', 'blocked', 'in_review', 'verified', 'deferred'])
const auditCountsSchema = z
  .object({
    moderate: z.number().int().nonnegative(),
    high: z.number().int().nonnegative(),
    critical: z.number().int().nonnegative()
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
    schemaVersion: z.literal(1),
    planId: z.literal('PACP-CMD-2026-01'),
    recordedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    e2eStatus: workflowStatusSchema,
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
        minimumVersion: exactVersionSchema,
        minimumGitHead: gitShaSchema,
        baselineVersion: exactVersionSchema,
        baselineGitHead: gitShaSchema,
        headRef: z.literal('main'),
        outsideWindow: z.literal('best-effort')
      })
      .strict(),
    acp: z
      .object({
        protocolVersion: z.literal(1),
        sdkPackage: z.literal('@agentclientprotocol/sdk'),
        sdkVersion: exactVersionSchema,
        sdkGitHead: gitShaSchema
      })
      .strict(),
    node: z
      .object({
        minimumVersion: exactVersionSchema,
        baselineVersion: exactVersionSchema,
        recordedVersion: exactVersionSchema
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
            status: workflowStatusSchema,
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
            status: workflowStatusSchema,
            verification: z.literal('manual')
          })
          .strict()
      })
      .strict(),
    dependencyAudit: z
      .object({
        runtime: auditCountsSchema,
        development: auditCountsSchema,
        followUpCheckpoint: z.literal('C5.8')
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
