import type { AvailableCommand } from '@agentclientprotocol/sdk'

export type PiRpcCommandInfo = {
  name?: unknown
  description?: unknown
  source?: unknown
  sourceInfo?: unknown
  location?: unknown
  path?: unknown
}

function describeFallback(c: PiRpcCommandInfo): string {
  const source = typeof c.source === 'string' ? c.source : ''
  const location = typeof c.location === 'string' ? c.location : ''

  const parts: string[] = []
  if (source) parts.push(source)
  if (location) parts.push(location)

  return parts.length ? `(${parts.join(':')})` : '(command)'
}

export function toAvailableCommandsFromPiGetCommands(
  data: unknown,
  opts?: { enableSkillCommands?: boolean; includeExtensionCommands?: boolean }
): {
  commands: AvailableCommand[]
  raw: PiRpcCommandInfo[]
} {
  const enableSkillCommands = opts?.enableSkillCommands ?? true
  const includeExtensionCommands = opts?.includeExtensionCommands ?? true

  const root: any = data
  const commandsRaw = piCommandsRawFromGetCommands(root)

  const out: AvailableCommand[] = []

  for (const c of commandsRaw) {
    const name = typeof c?.name === 'string' ? c.name.trim() : ''
    if (!name) continue

    const source = typeof c?.source === 'string' ? c.source : ''
    if (!includeExtensionCommands && source === 'extension') continue

    if (!enableSkillCommands && name.startsWith('skill:')) continue

    const desc = typeof c?.description === 'string' ? c.description.trim() : ''

    out.push({
      name,
      description: desc || describeFallback(c),
      _meta: {
        piAcp: {
          source: source || null,
          sourceInfo: c.sourceInfo ?? null,
          location: typeof c.location === 'string' ? c.location : null,
          path: typeof c.path === 'string' ? c.path : null
        }
      }
    })
  }

  return { commands: out, raw: commandsRaw }
}

export function piCommandsRawFromGetCommands(data: unknown): PiRpcCommandInfo[] {
  const root: any = data
  return Array.isArray(root?.commands) ? root.commands : Array.isArray(root?.data?.commands) ? root.data.commands : []
}

export function extensionCommandNamesFromPiCommands(commands: PiRpcCommandInfo[]): Set<string> {
  const names = new Set<string>()

  for (const c of commands) {
    if (c.source !== 'extension') continue
    const name = typeof c.name === 'string' ? c.name.trim() : ''
    if (name) names.add(name)
  }

  return names
}
