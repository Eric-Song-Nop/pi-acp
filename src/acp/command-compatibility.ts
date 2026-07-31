import { z } from 'zod'

export const COMMAND_COMPATIBILITY_SCHEMA_VERSION = 1 as const

export const COMMAND_SOURCES = ['adapter', 'pi-builtin', 'extension', 'prompt', 'skill'] as const
export const COMMAND_COMPATIBILITY_TIERS = ['rpc-native', 'basic-dialog', 'external-ui', 'tui-only', 'unknown'] as const
export const COMMAND_EXECUTION_KINDS = ['local', 'agent', 'session', 'unknown'] as const
export const COMMAND_EXPOSURES = ['stable', 'experimental', 'hidden'] as const
export const COMMAND_INTERACTIONS = [
  'notify',
  'select',
  'confirm',
  'input',
  'editor',
  'external-url',
  'custom-tui'
] as const
export const COMMAND_EVIDENCE_KINDS = ['fixture', 'unit', 'e2e', 'manual', 'upstream'] as const

export const commandSourceSchema = z.enum(COMMAND_SOURCES)
export const commandCompatibilityTierSchema = z.enum(COMMAND_COMPATIBILITY_TIERS)
export const commandExecutionKindSchema = z.enum(COMMAND_EXECUTION_KINDS)
export const commandExposureSchema = z.enum(COMMAND_EXPOSURES)
export const commandInteractionSchema = z.enum(COMMAND_INTERACTIONS)
export const commandEvidenceKindSchema = z.enum(COMMAND_EVIDENCE_KINDS)

export type CommandSource = z.infer<typeof commandSourceSchema>
export type CommandCompatibilityTier = z.infer<typeof commandCompatibilityTierSchema>
export type CommandExecutionKind = z.infer<typeof commandExecutionKindSchema>
export type CommandExposure = z.infer<typeof commandExposureSchema>
export type CommandInteraction = z.infer<typeof commandInteractionSchema>
export type CommandEvidenceKind = z.infer<typeof commandEvidenceKindSchema>

const COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const OPAQUE_SOURCE_ID_PATTERN = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]{0,127}$/
const STABLE_COMMAND_ID_PATTERN = /^[a-z][a-z0-9-]*(?::[a-z0-9][a-z0-9._-]*){2,}$/

function isVisibleText(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return false
  }
  return true
}

function visibleText(maxLength: number) {
  return z.string().trim().min(1).max(maxLength).refine(isVisibleText, 'must not contain control characters')
}

const commandEvidenceSchema = z
  .object({
    kind: commandEvidenceKindSchema,
    ref: visibleText(512),
    verifiedAgainst: visibleText(512).optional()
  })
  .strict()

const commandCompatibilityObjectSchema = z
  .object({
    schemaVersion: z.literal(COMMAND_COMPATIBILITY_SCHEMA_VERSION),
    id: z.string().regex(STABLE_COMMAND_ID_PATTERN),
    name: z.string().regex(COMMAND_NAME_PATTERN),
    source: commandSourceSchema,
    sourceId: z.string().regex(OPAQUE_SOURCE_ID_PATTERN),
    compatibility: commandCompatibilityTierSchema,
    execution: commandExecutionKindSchema,
    exposure: commandExposureSchema,
    interactions: z.array(commandInteractionSchema).default([]),
    evidence: z.array(commandEvidenceSchema).default([]),
    description: visibleText(512).optional(),
    argumentHint: visibleText(256).optional(),
    warning: visibleText(512).optional()
  })
  .strict()

const DIALOG_INTERACTIONS = new Set<CommandInteraction>(['select', 'confirm', 'input', 'editor'])
const HEADLESS_TIERS = new Set<CommandCompatibilityTier>(['rpc-native', 'basic-dialog', 'external-ui'])

export const commandCompatibilitySchema = commandCompatibilityObjectSchema.superRefine((command, context) => {
  const interactionSet = new Set(command.interactions)

  if (interactionSet.size !== command.interactions.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['interactions'],
      message: 'interactions must not contain duplicates'
    })
  }

  if (!command.sourceId.startsWith(`${command.source}:`)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sourceId'],
      message: 'sourceId must be an opaque identifier prefixed by the command source'
    })
  }

  if (!command.id.startsWith(`${command.sourceId}:`)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['id'],
      message: 'id must be derived from the opaque sourceId'
    })
  }

  if (command.compatibility === 'tui-only' && command.exposure !== 'hidden') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['exposure'],
      message: 'tui-only commands must be hidden'
    })
  }

  if (command.compatibility === 'unknown' && command.exposure === 'stable') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['exposure'],
      message: 'unknown commands cannot be exposed as stable'
    })
  }

  if (command.compatibility === 'unknown' && command.exposure === 'experimental' && !command.warning) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['warning'],
      message: 'experimental unknown commands require a visible warning'
    })
  }

  if (command.exposure === 'stable') {
    if (!HEADLESS_TIERS.has(command.compatibility)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['compatibility'],
        message: 'stable commands require a headless-compatible tier'
      })
    }

    if (command.evidence.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence'],
        message: 'stable commands require verification evidence'
      })
    }
  }

  if (command.compatibility === 'rpc-native' && command.interactions.some(interaction => interaction !== 'notify')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['interactions'],
      message: 'rpc-native commands may only declare notify interactions'
    })
  }

  if (
    command.compatibility === 'basic-dialog' &&
    !command.interactions.some(interaction => DIALOG_INTERACTIONS.has(interaction))
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['interactions'],
      message: 'basic-dialog commands must declare a dialog interaction'
    })
  }

  if (command.compatibility === 'external-ui' && !interactionSet.has('external-url')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['interactions'],
      message: 'external-ui commands must declare an external-url interaction'
    })
  }

  if (interactionSet.has('custom-tui') && command.compatibility !== 'tui-only') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['compatibility'],
      message: 'custom-tui interactions require the tui-only tier'
    })
  }
})

export type CommandCompatibility = z.infer<typeof commandCompatibilitySchema>

export type SafeCommandMetadata = Pick<
  CommandCompatibility,
  'schemaVersion' | 'id' | 'source' | 'sourceId' | 'compatibility' | 'execution' | 'exposure' | 'interactions'
>

export function defaultCommandExposure(compatibility: CommandCompatibilityTier, hasEvidence: boolean): CommandExposure {
  if (compatibility === 'tui-only' || compatibility === 'unknown') return 'hidden'
  return hasEvidence ? 'stable' : 'experimental'
}

export function toSafeCommandMetadata(command: CommandCompatibility): SafeCommandMetadata {
  return {
    schemaVersion: command.schemaVersion,
    id: command.id,
    source: command.source,
    sourceId: command.sourceId,
    compatibility: command.compatibility,
    execution: command.execution,
    exposure: command.exposure,
    interactions: [...command.interactions]
  }
}
