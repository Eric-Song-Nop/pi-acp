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

export const COMMAND_NAME_MAX_LENGTH = 128
export const COMMAND_SOURCE_ID_MAX_LENGTH =
  Math.max(...COMMAND_SOURCES.map(source => source.length)) + 1 + COMMAND_NAME_MAX_LENGTH
export const COMMAND_ID_MAX_LENGTH = COMMAND_SOURCE_ID_MAX_LENGTH + 1 + COMMAND_NAME_MAX_LENGTH

const COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const OPAQUE_SOURCE_ID_PATTERN = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]{0,127}$/
const STABLE_COMMAND_ID_PATTERN = /^[a-z][a-z0-9-]*(?::[a-z0-9][a-z0-9._-]*){2,}$/
const FORBIDDEN_TEXT_CODE_POINT_PATTERN = /[\p{Cc}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Bidi_Control}\u2800\u3164]/u
const FORMAT_CODE_POINT_PATTERN = /\p{Cf}/u
const DEFAULT_IGNORABLE_CODE_POINT_PATTERN = /\p{Default_Ignorable_Code_Point}/u
const CONTEXTUAL_JOINER_PATTERN = /[\u200c\u200d]/u
const VARIATION_SELECTOR_PATTERN = /\p{Variation_Selector}/u
const VISIBLE_CODE_POINT_PATTERN = /[\p{L}\p{N}\p{P}\p{S}]/u

function isAllowedContextualCodePoint(codePoint: string): boolean {
  return CONTEXTUAL_JOINER_PATTERN.test(codePoint) || VARIATION_SELECTOR_PATTERN.test(codePoint)
}

function isVisibleText(value: string): boolean {
  if (!VISIBLE_CODE_POINT_PATTERN.test(value)) return false

  return Array.from(value).every(codePoint => {
    if (FORBIDDEN_TEXT_CODE_POINT_PATTERN.test(codePoint)) return false

    const allowedContextualCodePoint = isAllowedContextualCodePoint(codePoint)
    if (FORMAT_CODE_POINT_PATTERN.test(codePoint) && !allowedContextualCodePoint) return false
    if (DEFAULT_IGNORABLE_CODE_POINT_PATTERN.test(codePoint) && !allowedContextualCodePoint) return false
    return true
  })
}

function visibleText(maxLength: number) {
  return z
    .string()
    .min(1)
    .refine(value => Array.from(value).length <= maxLength, `must contain at most ${maxLength} Unicode code points`)
    .refine(value => value === value.trim(), 'must not contain leading or trailing whitespace')
    .refine(isVisibleText, 'must contain visible text without control, bidi, or spoofing characters')
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
    id: z.string().max(COMMAND_ID_MAX_LENGTH).regex(STABLE_COMMAND_ID_PATTERN),
    name: z.string().regex(COMMAND_NAME_PATTERN),
    source: commandSourceSchema,
    sourceId: z.string().max(COMMAND_SOURCE_ID_MAX_LENGTH).regex(OPAQUE_SOURCE_ID_PATTERN),
    compatibility: commandCompatibilityTierSchema,
    execution: commandExecutionKindSchema,
    exposure: commandExposureSchema,
    interactions: z.array(commandInteractionSchema),
    evidence: z.array(commandEvidenceSchema),
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

    if (command.execution === 'unknown') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['execution'],
        message: 'stable commands require a known completion lifecycle'
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

  if (interactionSet.has('external-url') && command.compatibility !== 'external-ui') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['compatibility'],
      message: 'external-url interactions require the external-ui tier'
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

export const EXPERIMENTAL_COMMAND_WARNING_CODE = 'compatibility-unverified' as const
export const EXPERIMENTAL_COMMAND_WARNING_MESSAGE =
  'Compatibility has not been verified; this command is experimental.' as const

export type SafeCommandWarning = {
  code: typeof EXPERIMENTAL_COMMAND_WARNING_CODE
  message: typeof EXPERIMENTAL_COMMAND_WARNING_MESSAGE
}

export type SafeCommandMetadata = Pick<
  CommandCompatibility,
  'schemaVersion' | 'id' | 'source' | 'sourceId' | 'compatibility' | 'execution' | 'exposure' | 'interactions'
> & {
  warning?: SafeCommandWarning
}

export function defaultCommandExposure(
  compatibility: CommandCompatibilityTier,
  execution: CommandExecutionKind,
  hasEvidence: boolean
): CommandExposure {
  if (compatibility === 'tui-only' || compatibility === 'unknown') return 'hidden'
  return hasEvidence && execution !== 'unknown' ? 'stable' : 'experimental'
}

export function toSafeCommandMetadata(command: CommandCompatibility): SafeCommandMetadata {
  const metadata: SafeCommandMetadata = {
    schemaVersion: command.schemaVersion,
    id: command.id,
    source: command.source,
    sourceId: command.sourceId,
    compatibility: command.compatibility,
    execution: command.execution,
    exposure: command.exposure,
    interactions: [...command.interactions]
  }

  if (command.compatibility === 'unknown' && command.exposure === 'experimental') {
    metadata.warning = {
      code: EXPERIMENTAL_COMMAND_WARNING_CODE,
      message: EXPERIMENTAL_COMMAND_WARNING_MESSAGE
    }
  }
  return metadata
}
