import test from 'node:test'
import assert from 'node:assert/strict'
import { toAvailableCommandsFromPiGetCommands } from '../../src/acp/pi-commands.js'

test('toAvailableCommandsFromPiGetCommands: includes extension commands by default and filters skill commands', () => {
  const data = {
    commands: [
      { name: 'x', description: 'X', source: 'extension', sourceInfo: { source: 'project' } },
      { name: 'skill:foo', description: 'Foo', source: 'skill', location: 'user' },
      { name: 'y', source: 'prompt', location: 'project' }
    ]
  }

  const all = toAvailableCommandsFromPiGetCommands(data, { enableSkillCommands: true }).commands
  assert.deepEqual(all, [
    {
      name: 'x',
      description: 'X',
      _meta: { piAcp: { source: 'extension', sourceInfo: { source: 'project' }, location: null, path: null } }
    },
    {
      name: 'skill:foo',
      description: 'Foo',
      _meta: { piAcp: { source: 'skill', sourceInfo: null, location: 'user', path: null } }
    },
    {
      name: 'y',
      description: '(prompt:project)',
      _meta: { piAcp: { source: 'prompt', sourceInfo: null, location: 'project', path: null } }
    }
  ])

  const hideExt = toAvailableCommandsFromPiGetCommands(data, {
    enableSkillCommands: true,
    includeExtensionCommands: false
  }).commands
  assert.deepEqual(hideExt, [
    {
      name: 'skill:foo',
      description: 'Foo',
      _meta: { piAcp: { source: 'skill', sourceInfo: null, location: 'user', path: null } }
    },
    {
      name: 'y',
      description: '(prompt:project)',
      _meta: { piAcp: { source: 'prompt', sourceInfo: null, location: 'project', path: null } }
    }
  ])

  const noSkills = toAvailableCommandsFromPiGetCommands(data, { enableSkillCommands: false }).commands
  assert.deepEqual(noSkills, [
    {
      name: 'x',
      description: 'X',
      _meta: { piAcp: { source: 'extension', sourceInfo: { source: 'project' }, location: null, path: null } }
    },
    {
      name: 'y',
      description: '(prompt:project)',
      _meta: { piAcp: { source: 'prompt', sourceInfo: null, location: 'project', path: null } }
    }
  ])
})
