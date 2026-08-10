import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FIXTURE_AGENT_COMMAND_NAME,
  FIXTURE_AGENT_SAFE_COMMAND_METADATA,
  FIXTURE_STATE_COMMAND_NAME,
  FIXTURE_STATE_SAFE_COMMAND_METADATA,
  freezePiCommandCatalog
} from '../../src/acp/pi-commands.js'

const nestedSourceInfo = {
  path: '/private/project/.pi/extensions/fixture.ts',
  source: 'project-settings',
  scope: 'project',
  origin: 'top-level',
  baseDir: '/private/project'
}

test('freezePiCommandCatalog parses nested source metadata but keeps fixture-state hidden by default', () => {
  const catalog = freezePiCommandCatalog({
    commands: [
      {
        name: FIXTURE_STATE_COMMAND_NAME,
        description: 'Fixture state',
        source: 'extension',
        sourceInfo: nestedSourceInfo
      },
      {
        name: 'project-prompt',
        description: 'Project prompt',
        source: 'prompt',
        sourceInfo: { ...nestedSourceInfo, path: '/private/project/.pi/prompts/project-prompt.md' }
      }
    ]
  })

  assert.equal(catalog.hasFixtureStateExtension, true)
  assert.equal(catalog.fixtureStateExtensionCount, 1)
  assert.deepEqual(
    catalog.commands.map(command => command.name),
    ['project-prompt']
  )
  assert.deepEqual(catalog.raw[0], {
    name: FIXTURE_STATE_COMMAND_NAME,
    description: 'Fixture state',
    source: 'extension',
    sourceInfo: nestedSourceInfo
  })
})

test('freezePiCommandCatalog exposes only one unambiguous exact extension command with safe metadata', () => {
  const catalog = freezePiCommandCatalog(
    {
      commands: [
        {
          name: FIXTURE_STATE_COMMAND_NAME,
          description: 'Fixture state',
          source: 'extension',
          sourceInfo: nestedSourceInfo
        },
        {
          name: ' fixture-state ',
          description: 'Whitespace-distinct extension command',
          source: 'extension',
          sourceInfo: nestedSourceInfo
        },
        {
          name: 'skill:fixture-helper',
          description: 'Fixture helper',
          source: 'skill',
          sourceInfo: nestedSourceInfo
        }
      ]
    },
    { enableFixtureStateCommand: true }
  )

  assert.equal(catalog.hasFixtureStateExtension, true)
  assert.deepEqual(
    catalog.raw.map(command => command.name),
    [FIXTURE_STATE_COMMAND_NAME, ' fixture-state ', 'skill:fixture-helper']
  )
  assert.deepEqual(
    catalog.commands.map(command => command.name),
    [FIXTURE_STATE_COMMAND_NAME, 'skill:fixture-helper']
  )

  const fixture = catalog.commands[0] as any
  assert.deepEqual(fixture._meta?.piAcp?.command, FIXTURE_STATE_SAFE_COMMAND_METADATA)
  assert.equal(JSON.stringify(fixture._meta).includes('/private/project'), false)
})

test('freezePiCommandCatalog hides fixture-state when any exact-name source collision exists', () => {
  const catalog = freezePiCommandCatalog(
    {
      commands: [
        { name: FIXTURE_STATE_COMMAND_NAME, source: 'extension', sourceInfo: nestedSourceInfo },
        { name: FIXTURE_STATE_COMMAND_NAME, source: 'prompt', sourceInfo: nestedSourceInfo }
      ]
    },
    { enableFixtureStateCommand: true }
  )

  assert.equal(catalog.fixtureStateExtensionCount, 1)
  assert.equal(catalog.hasFixtureStateExtension, false)
  assert.deepEqual(catalog.commands, [])
})

for (const sourceOrder of ['generic-first', 'extension-first'] as const) {
  test(`freezePiCommandCatalog hides normalized fixture-state source collision (${sourceOrder})`, () => {
    const extension = {
      name: FIXTURE_STATE_COMMAND_NAME,
      source: 'extension',
      sourceInfo: nestedSourceInfo
    }
    const genericAlias = {
      name: ' fixture-state ',
      source: 'prompt',
      sourceInfo: nestedSourceInfo
    }
    const commands = sourceOrder === 'generic-first' ? [genericAlias, extension] : [extension, genericAlias]
    const catalog = freezePiCommandCatalog({ commands }, { enableFixtureStateCommand: true })

    assert.equal(catalog.fixtureStateExtensionCount, 1)
    assert.equal(catalog.hasFixtureStateExtension, false)
    assert.deepEqual(
      catalog.raw.map(command => command.name),
      commands.map(command => command.name)
    )
    assert.deepEqual(catalog.commands, [])
  })
}

for (const source of ['prompt', 'skill'] as const) {
  test(`freezePiCommandCatalog reserves a lone normalized ${source} alias without enabling execution`, () => {
    const data = {
      commands: [{ name: ' fixture-state ', description: 'Generic alias', source }]
    }
    const reserved = freezePiCommandCatalog(data, {
      enableFixtureStateCommand: false,
      reserveFixtureStateName: true
    })

    assert.equal(reserved.fixtureStateExtensionCount, 0)
    assert.equal(reserved.hasFixtureStateExtension, false)
    assert.deepEqual(reserved.commands, [])

    const defaultOff = freezePiCommandCatalog(data)
    assert.equal(defaultOff.fixtureStateExtensionCount, 0)
    assert.equal(defaultOff.hasFixtureStateExtension, false)
    assert.deepEqual(
      defaultOff.commands.map(command => ({ name: command.name, description: command.description })),
      [{ name: FIXTURE_STATE_COMMAND_NAME, description: 'Generic alias' }]
    )
  })
}

test('freezePiCommandCatalog name reservation does not expose an exact extension command', () => {
  const catalog = freezePiCommandCatalog(
    { commands: [{ name: FIXTURE_STATE_COMMAND_NAME, source: 'extension' }] },
    { enableFixtureStateCommand: false, reserveFixtureStateName: true }
  )

  assert.equal(catalog.fixtureStateExtensionCount, 1)
  assert.equal(catalog.hasFixtureStateExtension, true)
  assert.deepEqual(catalog.commands, [])
})

test('freezePiCommandCatalog preserves case and whitespace in invocation identities', () => {
  const catalog = freezePiCommandCatalog(
    {
      commands: [
        { name: 'Fixture-State', source: 'extension', sourceInfo: nestedSourceInfo },
        { name: 'fixture-state ', source: 'extension', sourceInfo: nestedSourceInfo }
      ]
    },
    { enableFixtureStateCommand: true }
  )

  assert.deepEqual(
    catalog.raw.map(command => command.name),
    ['Fixture-State', 'fixture-state ']
  )
  assert.equal(catalog.fixtureStateExtensionCount, 0)
  assert.equal(catalog.hasFixtureStateExtension, false)
  assert.deepEqual(catalog.commands, [])
})

test('freezePiCommandCatalog preserves C2.2 generic display normalization without changing raw identity', () => {
  const catalog = freezePiCommandCatalog({
    commands: [
      {
        name: '  project-prompt  ',
        description: '  Project prompt  ',
        source: 'prompt',
        path: '/legacy/project-prompt.md',
        location: 'project',
        sourceInfo: {}
      },
      { name: '  skill:fixture-helper  ', source: 'skill' }
    ]
  })

  assert.deepEqual(
    catalog.raw.map(command => command.name),
    ['  project-prompt  ', '  skill:fixture-helper  ']
  )
  assert.deepEqual(
    catalog.commands.map(command => ({ name: command.name, description: command.description })),
    [
      { name: 'project-prompt', description: 'Project prompt' },
      { name: 'skill:fixture-helper', description: '(skill)' }
    ]
  )
  assert.deepEqual(catalog.raw[0]?.sourceInfo, {
    path: '/legacy/project-prompt.md',
    scope: 'project'
  })

  const skillsDisabled = freezePiCommandCatalog(
    { commands: [{ name: '  skill:fixture-helper  ', source: 'skill' }] },
    { enableSkillCommands: false }
  )
  assert.deepEqual(skillsDisabled.commands, [])
})

test('freezePiCommandCatalog exposes fixture-agent independently with exact agent metadata', () => {
  const data = {
    commands: [
      {
        name: FIXTURE_STATE_COMMAND_NAME,
        description: 'Fixture state',
        source: 'extension',
        sourceInfo: nestedSourceInfo
      },
      {
        name: FIXTURE_AGENT_COMMAND_NAME,
        description: 'Run fixture agent',
        source: 'extension',
        sourceInfo: nestedSourceInfo
      },
      { name: 'project-prompt', description: 'Project prompt', source: 'prompt' }
    ]
  }

  const stateOnly = freezePiCommandCatalog(data, { enableFixtureStateCommand: true })
  assert.deepEqual(
    stateOnly.commands.map(command => command.name),
    [FIXTURE_STATE_COMMAND_NAME, 'project-prompt']
  )

  const agentOnly = freezePiCommandCatalog(data, { enableFixtureAgentCommand: true })
  assert.equal(agentOnly.hasFixtureStateExtension, true)
  assert.equal(agentOnly.fixtureStateExtensionCount, 1)
  assert.equal(agentOnly.hasFixtureAgentExtension, true)
  assert.equal(agentOnly.fixtureAgentExtensionCount, 1)
  assert.deepEqual(
    agentOnly.commands.map(command => command.name),
    [FIXTURE_AGENT_COMMAND_NAME, 'project-prompt']
  )

  const fixtureAgent = agentOnly.commands[0] as any
  assert.deepEqual(fixtureAgent._meta?.piAcp?.command, FIXTURE_AGENT_SAFE_COMMAND_METADATA)
  assert.deepEqual(fixtureAgent._meta?.piAcp?.command, {
    schemaVersion: 1,
    id: 'extension:pi-acp-fixture:fixture-agent',
    source: 'extension',
    sourceId: 'extension:pi-acp-fixture',
    compatibility: 'rpc-native',
    execution: 'agent',
    exposure: 'experimental',
    interactions: []
  })
  assert.equal(JSON.stringify(fixtureAgent._meta).includes('/private/project'), false)

  const both = freezePiCommandCatalog(data, {
    enableFixtureStateCommand: true,
    enableFixtureAgentCommand: true
  })
  assert.deepEqual(
    both.commands.map(command => command.name),
    [FIXTURE_STATE_COMMAND_NAME, FIXTURE_AGENT_COMMAND_NAME, 'project-prompt']
  )
})

for (const collisionSource of ['extension', 'prompt', 'skill'] as const) {
  test(`freezePiCommandCatalog fences normalized fixture-agent ${collisionSource} collisions`, () => {
    const aliasName = collisionSource === 'extension' ? ' fixture-agent ' : 'fixture-agent '
    const catalog = freezePiCommandCatalog(
      {
        commands: [
          { name: FIXTURE_AGENT_COMMAND_NAME, source: 'extension', sourceInfo: nestedSourceInfo },
          { name: aliasName, source: collisionSource, sourceInfo: nestedSourceInfo },
          { name: 'unrelated-prompt', source: 'prompt' }
        ]
      },
      { enableFixtureAgentCommand: true }
    )

    assert.equal(catalog.fixtureAgentExtensionCount, 1)
    assert.equal(catalog.hasFixtureAgentExtension, false)
    assert.deepEqual(
      catalog.commands.map(command => command.name),
      ['unrelated-prompt']
    )
  })
}

test('freezePiCommandCatalog rejects duplicate exact fixture-agent extensions', () => {
  const catalog = freezePiCommandCatalog(
    {
      commands: [
        { name: FIXTURE_AGENT_COMMAND_NAME, source: 'extension' },
        { name: FIXTURE_AGENT_COMMAND_NAME, source: 'extension' }
      ]
    },
    { enableFixtureAgentCommand: true }
  )

  assert.equal(catalog.fixtureAgentExtensionCount, 2)
  assert.equal(catalog.hasFixtureAgentExtension, false)
  assert.deepEqual(catalog.commands, [])
})

test('freezePiCommandCatalog reserves fixture-agent without enabling it or the fixture-state preview', () => {
  const data = {
    commands: [{ name: ' fixture-agent ', description: 'Generic alias', source: 'prompt' }]
  }
  const reserved = freezePiCommandCatalog(data, {
    reserveFixtureAgentName: true,
    enableFixtureStateCommand: true
  })
  assert.equal(reserved.fixtureAgentExtensionCount, 0)
  assert.equal(reserved.hasFixtureAgentExtension, false)
  assert.deepEqual(reserved.commands, [])

  const defaultOff = freezePiCommandCatalog(data)
  assert.deepEqual(
    defaultOff.commands.map(command => command.name),
    [FIXTURE_AGENT_COMMAND_NAME]
  )
})
