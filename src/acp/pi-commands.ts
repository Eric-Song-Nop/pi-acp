import type { AvailableCommand } from '@agentclientprotocol/sdk'
import {
  COMMAND_COMPATIBILITY_SCHEMA_VERSION,
  commandCompatibilitySchema,
  toSafeCommandMetadata
} from './command-compatibility.js'

export const FIXTURE_STATE_COMMAND_NAME = 'fixture-state' as const

export type PiRpcCommandInfo = {
  name?: unknown
  description?: unknown
  source?: unknown
  location?: unknown
  path?: unknown
  sourceInfo?: unknown
}

export type PiRpcCommandSourceInfo = Readonly<{
  path?: string
  source?: string
  scope?: string
  origin?: string
  baseDir?: string
}>

export type NormalizedPiRpcCommandInfo = Readonly<{
  name: string
  description: string
  source: string
  sourceInfo: PiRpcCommandSourceInfo | null
}>

export type FrozenPiCommandCatalog = Readonly<{
  commands: readonly AvailableCommand[]
  raw: readonly NormalizedPiRpcCommandInfo[]
  hasFixtureStateExtension: boolean
  fixtureStateExtensionCount: number
}>

export type PiCommandCatalogOptions = Readonly<{
  enableSkillCommands?: boolean
  enableFixtureStateCommand?: boolean
  reserveFixtureStateName?: boolean
}>

export type PiCommandCatalogState = {
  snapshot: FrozenPiCommandCatalog | null
  discovery: Promise<FrozenPiCommandCatalog> | null
  publishedSnapshot: FrozenPiCommandCatalog | null
  publicationSnapshot: FrozenPiCommandCatalog | null
  publication: Promise<void> | null
}

const fixtureStateCompatibility = commandCompatibilitySchema.parse({
  schemaVersion: COMMAND_COMPATIBILITY_SCHEMA_VERSION,
  id: 'extension:pi-acp-fixture:fixture-state',
  name: FIXTURE_STATE_COMMAND_NAME,
  source: 'extension',
  sourceId: 'extension:pi-acp-fixture',
  compatibility: 'rpc-native',
  execution: 'local',
  exposure: 'experimental',
  interactions: ['notify'],
  evidence: [{ kind: 'fixture', ref: 'test/fixtures/pi-extension-pack/index.ts' }],
  description: 'Report that the deterministic Pi ACP fixture is loaded'
})

export const FIXTURE_STATE_SAFE_COMMAND_METADATA = Object.freeze(toSafeCommandMetadata(fixtureStateCompatibility))

export function createPiCommandCatalogState(): PiCommandCatalogState {
  return {
    snapshot: null,
    discovery: null,
    publishedSnapshot: null,
    publicationSnapshot: null,
    publication: null
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function normalizeSourceInfo(value: unknown): PiRpcCommandSourceInfo | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const normalized = {
    ...(optionalString(source.path) !== undefined ? { path: optionalString(source.path) } : {}),
    ...(optionalString(source.source) !== undefined ? { source: optionalString(source.source) } : {}),
    ...(optionalString(source.scope) !== undefined ? { scope: optionalString(source.scope) } : {}),
    ...(optionalString(source.origin) !== undefined ? { origin: optionalString(source.origin) } : {}),
    ...(optionalString(source.baseDir) !== undefined ? { baseDir: optionalString(source.baseDir) } : {})
  }
  return Object.keys(normalized).length > 0 ? Object.freeze(normalized) : null
}

function normalizeCommandSourceInfo(command: PiRpcCommandInfo): PiRpcCommandSourceInfo | null {
  const nested = normalizeSourceInfo(command.sourceInfo)
  if (nested) return nested

  const path = optionalString(command.path)
  const scope = optionalString(command.location)
  if (path === undefined && scope === undefined) return null
  return Object.freeze({ ...(path !== undefined ? { path } : {}), ...(scope !== undefined ? { scope } : {}) })
}

function extractRawCommands(data: unknown): PiRpcCommandInfo[] {
  const root = data as { commands?: unknown; data?: { commands?: unknown } } | null | undefined
  return (
    Array.isArray(root?.commands) ? root.commands : Array.isArray(root?.data?.commands) ? root.data.commands : []
  ) as PiRpcCommandInfo[]
}

function normalizeCommands(data: unknown): NormalizedPiRpcCommandInfo[] {
  const raw = extractRawCommands(data)

  const normalized: NormalizedPiRpcCommandInfo[] = []
  for (const candidate of raw) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const command = candidate as PiRpcCommandInfo
    const name = typeof command.name === 'string' ? command.name : ''
    if (!name || name.trim().length === 0) continue

    normalized.push(
      Object.freeze({
        name,
        description: typeof command.description === 'string' ? command.description.trim() : '',
        source: typeof command.source === 'string' ? command.source : '',
        sourceInfo: normalizeCommandSourceInfo(command)
      })
    )
  }
  return normalized
}

function describeFallback(c: NormalizedPiRpcCommandInfo): string {
  const source = c.source
  const location = c.sourceInfo?.scope ?? ''

  const parts: string[] = []
  if (source) parts.push(source)
  if (location) parts.push(location)

  return parts.length ? `(${parts.join(':')})` : '(command)'
}

export function freezePiCommandCatalog(data: unknown, opts?: PiCommandCatalogOptions): FrozenPiCommandCatalog {
  const enableSkillCommands = opts?.enableSkillCommands ?? true
  const enableFixtureStateCommand = opts?.enableFixtureStateCommand ?? false
  const reserveFixtureStateName = opts?.reserveFixtureStateName ?? false
  const raw = normalizeCommands(data)
  const fixtureStateExtensionCommands = raw.filter(
    command => command.source === 'extension' && command.name === FIXTURE_STATE_COMMAND_NAME
  )
  const fixtureStateExtensionCount = fixtureStateExtensionCommands.length
  const fixtureStateVisibleNameCommands = raw.filter(command =>
    command.source === 'extension'
      ? command.name === FIXTURE_STATE_COMMAND_NAME
      : command.name.trim() === FIXTURE_STATE_COMMAND_NAME
  )
  const hasFixtureStateExtension = fixtureStateExtensionCount === 1 && fixtureStateVisibleNameCommands.length === 1
  const fixtureStateNameReserved =
    enableFixtureStateCommand || reserveFixtureStateName || fixtureStateExtensionCount > 0
  const commands: AvailableCommand[] = []

  for (const command of raw) {
    const availableName = command.name.trim()
    if (availableName === FIXTURE_STATE_COMMAND_NAME && !hasFixtureStateExtension && fixtureStateNameReserved) {
      continue
    }

    if (command.source === 'extension') {
      if (!enableFixtureStateCommand || !hasFixtureStateExtension || command.name !== FIXTURE_STATE_COMMAND_NAME) {
        continue
      }

      commands.push(
        Object.freeze({
          name: FIXTURE_STATE_COMMAND_NAME,
          description: command.description || fixtureStateCompatibility.description,
          _meta: { piAcp: { command: FIXTURE_STATE_SAFE_COMMAND_METADATA } }
        }) as AvailableCommand
      )
      continue
    }

    // C2.2's client-facing catalog normalizes generic prompt/skill names.
    // Keep that stable while reserving the same visible name projection for
    // the narrow fixture preview collision fence above. Extension execution
    // still requires the raw, byte-exact identity.
    if (!enableSkillCommands && availableName.startsWith('skill:')) continue
    commands.push(
      Object.freeze({
        name: availableName,
        description: command.description || describeFallback(command)
      })
    )
  }

  return Object.freeze({
    commands: Object.freeze(commands),
    raw: Object.freeze(raw),
    hasFixtureStateExtension,
    fixtureStateExtensionCount
  })
}

export function toAvailableCommandsFromPiGetCommands(
  data: unknown,
  opts?: { enableSkillCommands?: boolean; includeExtensionCommands?: boolean }
): {
  commands: AvailableCommand[]
  raw: PiRpcCommandInfo[]
} {
  const raw = extractRawCommands(data)
  const commands: AvailableCommand[] = []
  for (const command of raw) {
    const name = typeof command?.name === 'string' ? command.name.trim() : ''
    if (!name) continue

    const source = typeof command?.source === 'string' ? command.source : ''
    if (!opts?.includeExtensionCommands && source === 'extension') continue
    if (opts?.enableSkillCommands === false && name.startsWith('skill:')) continue

    const description = typeof command?.description === 'string' ? command.description.trim() : ''
    const normalized = Object.freeze({
      name,
      description,
      source,
      sourceInfo: normalizeCommandSourceInfo(command)
    })
    commands.push({
      name,
      description: description || describeFallback(normalized)
    })
  }
  return { commands, raw }
}
