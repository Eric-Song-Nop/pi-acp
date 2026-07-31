import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  COMMAND_COMPATIBILITY_TIERS,
  COMMAND_EVIDENCE_KINDS,
  COMMAND_EXECUTION_KINDS,
  COMMAND_EXPOSURES,
  COMMAND_INTERACTIONS,
  COMMAND_SOURCES,
  commandCompatibilitySchema,
  defaultCommandExposure,
  toSafeCommandMetadata
} from '../../src/acp/command-compatibility.js'

type JsonSchemaEnum = {
  enum: string[]
}

type CompanionJsonSchema = {
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
  assert.equal(defaultCommandExposure('rpc-native', false), 'experimental')
  assert.equal(defaultCommandExposure('basic-dialog', false), 'experimental')
  assert.equal(defaultCommandExposure('external-ui', true), 'stable')
  assert.equal(defaultCommandExposure('tui-only', true), 'hidden')
  assert.equal(defaultCommandExposure('unknown', true), 'hidden')
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
    compatibility: 'unknown',
    exposure: 'experimental',
    evidence: []
  })

  assert.equal(
    commandCompatibilitySchema.safeParse({
      ...stableCommand,
      compatibility: 'unknown',
      execution: 'unknown',
      exposure: 'experimental',
      evidence: [],
      warning: 'Compatibility is unknown and this command is experimental'
    }).success,
    true
  )
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
  const schema = JSON.parse(
    readFileSync(new URL('../../docs/command-compatibility/command-compatibility.schema.json', import.meta.url), 'utf8')
  ) as CompanionJsonSchema

  assert.deepEqual(schema.$defs.source.enum, [...COMMAND_SOURCES])
  assert.deepEqual(schema.$defs.compatibility.enum, [...COMMAND_COMPATIBILITY_TIERS])
  assert.deepEqual(schema.$defs.execution.enum, [...COMMAND_EXECUTION_KINDS])
  assert.deepEqual(schema.$defs.exposure.enum, [...COMMAND_EXPOSURES])
  assert.deepEqual(schema.$defs.interaction.enum, [...COMMAND_INTERACTIONS])
  assert.deepEqual(schema.$defs.evidenceKind.enum, [...COMMAND_EVIDENCE_KINDS])
})
