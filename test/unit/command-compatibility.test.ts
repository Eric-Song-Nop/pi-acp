import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import {
  COMMAND_COMPATIBILITY_TIERS,
  COMMAND_EVIDENCE_KINDS,
  COMMAND_EXECUTION_KINDS,
  COMMAND_EXPOSURES,
  COMMAND_ID_MAX_LENGTH,
  COMMAND_INTERACTIONS,
  COMMAND_SOURCE_ID_MAX_LENGTH,
  COMMAND_SOURCES,
  commandCompatibilitySchema,
  defaultCommandExposure,
  toSafeCommandMetadata
} from '../../src/acp/command-compatibility.js'

type JsonSchemaEnum = {
  enum: string[]
}

type CompanionJsonSchema = Record<string, unknown> & {
  $defs: {
    source: JsonSchemaEnum
    compatibility: JsonSchemaEnum
    execution: JsonSchemaEnum
    exposure: JsonSchemaEnum
    interaction: JsonSchemaEnum
    evidenceKind: JsonSchemaEnum
  }
}

const stableCommand = {
  schemaVersion: 1,
  id: 'adapter:pi-acp:compact',
  name: 'compact',
  source: 'adapter',
  sourceId: 'adapter:pi-acp',
  compatibility: 'rpc-native',
  execution: 'local',
  exposure: 'stable',
  interactions: [],
  evidence: [{ kind: 'unit', ref: 'test/unit/builtin-commands.test.ts' }],
  description: 'Compact the current Pi session'
} as const

function expectInvalid(candidate: unknown): void {
  assert.equal(commandCompatibilitySchema.safeParse(candidate).success, false)
}

function readCompanionSchema(): CompanionJsonSchema {
  return JSON.parse(
    readFileSync(new URL('../../docs/command-compatibility/command-compatibility.schema.json', import.meta.url), 'utf8')
  ) as CompanionJsonSchema
}

test('command compatibility schema accepts evidence-backed headless commands', () => {
  const command = commandCompatibilitySchema.parse(stableCommand)

  assert.deepEqual(toSafeCommandMetadata(command), {
    schemaVersion: 1,
    id: 'adapter:pi-acp:compact',
    source: 'adapter',
    sourceId: 'adapter:pi-acp',
    compatibility: 'rpc-native',
    execution: 'local',
    exposure: 'stable',
    interactions: []
  })
})

test('default command exposure is conservative and evidence-aware', () => {
  assert.equal(defaultCommandExposure('rpc-native', 'local', false), 'experimental')
  assert.equal(defaultCommandExposure('basic-dialog', 'agent', false), 'experimental')
  assert.equal(defaultCommandExposure('external-ui', 'session', true), 'stable')
  assert.equal(defaultCommandExposure('external-ui', 'unknown', true), 'experimental')
  assert.equal(defaultCommandExposure('tui-only', 'local', true), 'hidden')
  assert.equal(defaultCommandExposure('unknown', 'unknown', true), 'hidden')
})

test('schema rejects unsafe or inconsistent stable identifiers', () => {
  expectInvalid({
    ...stableCommand,
    sourceId: '/Users/example/private-extension',
    id: 'extension:private:compact'
  })
  expectInvalid({
    ...stableCommand,
    source: 'extension',
    sourceId: 'adapter:pi-acp'
  })
  expectInvalid({
    ...stableCommand,
    id: 'adapter:other:compact'
  })
  expectInvalid({
    ...stableCommand,
    description: 'unsafe\nmultiline metadata'
  })
  expectInvalid({
    ...stableCommand,
    id: `adapter:pi-acp:${'a'.repeat(COMMAND_ID_MAX_LENGTH)}`
  })
})

test('schema enforces compatibility exposure policy', () => {
  expectInvalid({
    ...stableCommand,
    compatibility: 'tui-only',
    exposure: 'experimental',
    evidence: [],
    interactions: ['custom-tui']
  })
  expectInvalid({
    ...stableCommand,
    compatibility: 'unknown',
    evidence: []
  })
  expectInvalid({
    ...stableCommand,
    exposure: 'stable',
    evidence: []
  })
  expectInvalid({
    ...stableCommand,
    execution: 'unknown'
  })
  expectInvalid({
    ...stableCommand,
    compatibility: 'unknown',
    exposure: 'experimental',
    evidence: []
  })

  const experimentalUnknown = commandCompatibilitySchema.parse({
    ...stableCommand,
    compatibility: 'unknown',
    execution: 'unknown',
    exposure: 'experimental',
    evidence: [],
    warning: 'Compatibility is unknown and this command is experimental'
  })

  assert.equal(
    toSafeCommandMetadata(experimentalUnknown).warning,
    'Compatibility is unknown and this command is experimental'
  )
  expectInvalid({
    ...experimentalUnknown,
    warning: '\u200b'
  })
})

test('schema enforces interaction requirements for each compatibility tier', () => {
  expectInvalid({
    ...stableCommand,
    compatibility: 'rpc-native',
    exposure: 'experimental',
    evidence: [],
    interactions: ['confirm']
  })
  expectInvalid({
    ...stableCommand,
    compatibility: 'basic-dialog',
    exposure: 'experimental',
    evidence: [],
    interactions: ['notify']
  })
  expectInvalid({
    ...stableCommand,
    compatibility: 'external-ui',
    exposure: 'experimental',
    evidence: [],
    interactions: ['confirm']
  })
  expectInvalid({
    ...stableCommand,
    compatibility: 'basic-dialog',
    exposure: 'experimental',
    evidence: [],
    interactions: ['confirm', 'external-url']
  })
  expectInvalid({
    ...stableCommand,
    exposure: 'experimental',
    evidence: [],
    interactions: ['custom-tui']
  })
  expectInvalid({
    ...stableCommand,
    exposure: 'experimental',
    evidence: [],
    interactions: ['notify', 'notify']
  })

  assert.equal(
    commandCompatibilitySchema.safeParse({
      ...stableCommand,
      compatibility: 'basic-dialog',
      exposure: 'experimental',
      evidence: [],
      interactions: ['notify', 'select']
    }).success,
    true
  )
  assert.equal(
    commandCompatibilitySchema.safeParse({
      ...stableCommand,
      compatibility: 'external-ui',
      exposure: 'experimental',
      evidence: [],
      interactions: ['confirm', 'external-url']
    }).success,
    true
  )
})

test('JSON Schema companion uses the canonical compatibility vocabulary', () => {
  const schema = readCompanionSchema()

  assert.deepEqual(schema.$defs.source.enum, [...COMMAND_SOURCES])
  assert.deepEqual(schema.$defs.compatibility.enum, [...COMMAND_COMPATIBILITY_TIERS])
  assert.deepEqual(schema.$defs.execution.enum, [...COMMAND_EXECUTION_KINDS])
  assert.deepEqual(schema.$defs.exposure.enum, [...COMMAND_EXPOSURES])
  assert.deepEqual(schema.$defs.interaction.enum, [...COMMAND_INTERACTIONS])
  assert.deepEqual(schema.$defs.evidenceKind.enum, [...COMMAND_EVIDENCE_KINDS])
})

test('JSON Schema compiles strictly under draft 2020 and matches Zod invariants', () => {
  const schema = readCompanionSchema()
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: true })
  const validate = ajv.compile(schema)
  const { interactions: _interactions, ...withoutInteractions } = stableCommand
  const { evidence: _evidence, ...withoutEvidence } = stableCommand
  const maximumSourceId = `pi-builtin:${'a'.repeat(128)}`
  const maximumIdCommand = {
    ...stableCommand,
    id: `${maximumSourceId}:${'b'.repeat(128)}`,
    name: 'b'.repeat(128),
    source: 'pi-builtin',
    sourceId: maximumSourceId
  }

  assert.equal(maximumSourceId.length, COMMAND_SOURCE_ID_MAX_LENGTH)
  assert.equal(maximumIdCommand.id.length, COMMAND_ID_MAX_LENGTH)

  const parityCases: Array<{ label: string; candidate: unknown; valid: boolean }> = [
    { label: 'valid evidence-backed stable command', candidate: stableCommand, valid: true },
    { label: 'maximum wire identifier length is valid', candidate: maximumIdCommand, valid: true },
    { label: 'interactions are required', candidate: withoutInteractions, valid: false },
    { label: 'evidence is required', candidate: withoutEvidence, valid: false },
    {
      label: 'tui-only commands are hidden',
      candidate: { ...stableCommand, compatibility: 'tui-only', interactions: ['custom-tui'] },
      valid: false
    },
    {
      label: 'unknown commands are never stable',
      candidate: { ...stableCommand, compatibility: 'unknown', execution: 'unknown' },
      valid: false
    },
    {
      label: 'experimental unknown commands require warnings',
      candidate: {
        ...stableCommand,
        compatibility: 'unknown',
        execution: 'unknown',
        exposure: 'experimental',
        evidence: []
      },
      valid: false
    },
    {
      label: 'experimental warnings must be genuinely visible',
      candidate: {
        ...stableCommand,
        compatibility: 'unknown',
        execution: 'unknown',
        exposure: 'experimental',
        evidence: [],
        warning: '\u200b'
      },
      valid: false
    },
    {
      label: 'default-ignorable warnings are not visible',
      candidate: {
        ...stableCommand,
        compatibility: 'unknown',
        execution: 'unknown',
        exposure: 'experimental',
        evidence: [],
        warning: '\u3164'
      },
      valid: false
    },
    {
      label: 'blank braille warnings are not visible',
      candidate: {
        ...stableCommand,
        compatibility: 'unknown',
        execution: 'unknown',
        exposure: 'experimental',
        evidence: [],
        warning: '\u2800'
      },
      valid: false
    },
    {
      label: 'visible experimental warning is valid',
      candidate: {
        ...stableCommand,
        compatibility: 'unknown',
        execution: 'unknown',
        exposure: 'experimental',
        evidence: [],
        warning: 'Compatibility is unknown'
      },
      valid: true
    },
    {
      label: 'visible text counts Unicode code points at the maximum',
      candidate: {
        ...stableCommand,
        compatibility: 'unknown',
        execution: 'unknown',
        exposure: 'experimental',
        evidence: [],
        warning: '😀'.repeat(512)
      },
      valid: true
    },
    {
      label: 'visible text rejects one Unicode code point over the maximum',
      candidate: {
        ...stableCommand,
        compatibility: 'unknown',
        execution: 'unknown',
        exposure: 'experimental',
        evidence: [],
        warning: '😀'.repeat(513)
      },
      valid: false
    },
    {
      label: 'stable commands require evidence',
      candidate: { ...stableCommand, evidence: [] },
      valid: false
    },
    {
      label: 'stable commands require a known execution lifecycle',
      candidate: { ...stableCommand, execution: 'unknown' },
      valid: false
    },
    {
      label: 'stable commands require a headless tier',
      candidate: {
        ...stableCommand,
        compatibility: 'tui-only',
        exposure: 'stable',
        interactions: ['custom-tui']
      },
      valid: false
    },
    {
      label: 'rpc-native only permits notify',
      candidate: { ...stableCommand, interactions: ['confirm'] },
      valid: false
    },
    {
      label: 'basic-dialog requires a dialog',
      candidate: {
        ...stableCommand,
        compatibility: 'basic-dialog',
        exposure: 'experimental',
        evidence: [],
        interactions: ['notify']
      },
      valid: false
    },
    {
      label: 'basic-dialog accepts a dialog',
      candidate: {
        ...stableCommand,
        compatibility: 'basic-dialog',
        exposure: 'experimental',
        evidence: [],
        interactions: ['confirm']
      },
      valid: true
    },
    {
      label: 'external-ui requires external-url',
      candidate: {
        ...stableCommand,
        compatibility: 'external-ui',
        exposure: 'experimental',
        evidence: [],
        interactions: ['confirm']
      },
      valid: false
    },
    {
      label: 'external-url requires external-ui',
      candidate: {
        ...stableCommand,
        compatibility: 'basic-dialog',
        exposure: 'experimental',
        evidence: [],
        interactions: ['confirm', 'external-url']
      },
      valid: false
    },
    {
      label: 'external-ui with external-url is valid',
      candidate: {
        ...stableCommand,
        compatibility: 'external-ui',
        exposure: 'experimental',
        evidence: [],
        interactions: ['external-url']
      },
      valid: true
    },
    {
      label: 'custom-tui requires tui-only',
      candidate: { ...stableCommand, exposure: 'experimental', evidence: [], interactions: ['custom-tui'] },
      valid: false
    },
    {
      label: 'interactions are unique',
      candidate: { ...stableCommand, interactions: ['notify', 'notify'] },
      valid: false
    },
    {
      label: 'wire IDs are bounded',
      candidate: { ...maximumIdCommand, id: `${maximumIdCommand.id}c` },
      valid: false
    },
    {
      label: 'source IDs are bounded',
      candidate: {
        ...maximumIdCommand,
        id: `pi-builtin:${'a'.repeat(129)}:b`,
        name: 'b',
        sourceId: `pi-builtin:${'a'.repeat(129)}`
      },
      valid: false
    },
    {
      label: 'visible fields reject leading whitespace',
      candidate: { ...stableCommand, description: ' leading whitespace' },
      valid: false
    }
  ]

  for (const { label, candidate, valid } of parityCases) {
    const zodValid = commandCompatibilitySchema.safeParse(candidate).success
    const jsonValid = validate(candidate)
    assert.equal(zodValid, valid, `${label}: unexpected Zod result`)
    assert.equal(jsonValid, valid, `${label}: JSON Schema errors: ${ajv.errorsText(validate.errors)}`)
  }
})

test('source-derived prefix checks remain explicitly Zod-only', () => {
  const ajv = new Ajv2020({ strict: true, strictTypes: true })
  const validate = ajv.compile(readCompanionSchema())
  const candidates = [
    { ...stableCommand, source: 'extension', sourceId: 'adapter:pi-acp' },
    { ...stableCommand, id: 'adapter:other:compact' }
  ]

  for (const candidate of candidates) {
    assert.equal(commandCompatibilitySchema.safeParse(candidate).success, false)
    assert.equal(validate(candidate), true)
  }
})
