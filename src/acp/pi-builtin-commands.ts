import type { PromptResponse } from '@agentclientprotocol/sdk'

type PiBuiltinCommandDisposition = 'adapter' | 'unsupported'

type PiBuiltinCommandDefinition = Readonly<{
  name: string
  disposition: PiBuiltinCommandDisposition
}>

type CommandNames<T extends readonly PiBuiltinCommandDefinition[]> = {
  readonly [Index in keyof T]: T[Index] extends { name: infer Name extends string } ? Name : never
}

type CommandNamesWithDisposition<
  T extends readonly PiBuiltinCommandDefinition[],
  Disposition extends PiBuiltinCommandDisposition
> = T extends readonly [infer Head, ...infer Tail]
  ? Head extends PiBuiltinCommandDefinition
    ? Tail extends readonly PiBuiltinCommandDefinition[]
      ? Head['disposition'] extends Disposition
        ? readonly [Head['name'], ...CommandNamesWithDisposition<Tail, Disposition>]
        : CommandNamesWithDisposition<Tail, Disposition>
      : readonly []
    : readonly []
  : readonly []

// Pi RPC get_commands omits built-ins, so keep the pinned 0.80.5/0.83.0
// interactive catalog and the adapter disposition in one exhaustive table.
export const PI_BUILTIN_COMMANDS = [
  { name: 'settings', disposition: 'unsupported' },
  { name: 'model', disposition: 'unsupported' },
  { name: 'scoped-models', disposition: 'unsupported' },
  { name: 'export', disposition: 'adapter' },
  { name: 'import', disposition: 'unsupported' },
  { name: 'share', disposition: 'unsupported' },
  { name: 'copy', disposition: 'unsupported' },
  { name: 'name', disposition: 'adapter' },
  { name: 'session', disposition: 'adapter' },
  { name: 'changelog', disposition: 'adapter' },
  { name: 'hotkeys', disposition: 'unsupported' },
  { name: 'fork', disposition: 'unsupported' },
  { name: 'clone', disposition: 'unsupported' },
  { name: 'tree', disposition: 'unsupported' },
  { name: 'trust', disposition: 'unsupported' },
  { name: 'login', disposition: 'unsupported' },
  { name: 'logout', disposition: 'unsupported' },
  { name: 'new', disposition: 'unsupported' },
  { name: 'compact', disposition: 'adapter' },
  { name: 'resume', disposition: 'unsupported' },
  { name: 'reload', disposition: 'unsupported' },
  { name: 'quit', disposition: 'unsupported' }
] as const satisfies readonly PiBuiltinCommandDefinition[]

export type PiBuiltinCommandName = (typeof PI_BUILTIN_COMMANDS)[number]['name']
export type UnsupportedPiBuiltinCommandName = Extract<
  (typeof PI_BUILTIN_COMMANDS)[number],
  { disposition: 'unsupported' }
>['name']

export const PI_BUILTIN_COMMAND_NAMES = PI_BUILTIN_COMMANDS.map(command => command.name) as unknown as CommandNames<
  typeof PI_BUILTIN_COMMANDS
>

export const SUPPORTED_PI_BUILTIN_COMMAND_NAMES = PI_BUILTIN_COMMANDS.filter(
  command => command.disposition === 'adapter'
).map(command => command.name) as unknown as CommandNamesWithDisposition<typeof PI_BUILTIN_COMMANDS, 'adapter'>

export const REJECTED_PI_BUILTIN_COMMAND_NAMES = PI_BUILTIN_COMMANDS.filter(
  command => command.disposition === 'unsupported'
).map(command => command.name) as unknown as CommandNamesWithDisposition<typeof PI_BUILTIN_COMMANDS, 'unsupported'>

export const ADAPTER_ONLY_COMMAND_NAMES = ['autocompact', 'steering', 'follow-up'] as const

export const PI_ACP_UNSUPPORTED_PI_BUILTIN_CODE = 'PI_ACP_UNSUPPORTED_PI_BUILTIN' as const
export const PI_UNSUPPORTED_BUILTIN_SUMMARY_LIMIT_BYTES = 256 as const

const unsupportedPiBuiltinNames = new Set<string>(REJECTED_PI_BUILTIN_COMMAND_NAMES)

export function isUnsupportedPiBuiltinCommand(name: string): name is UnsupportedPiBuiltinCommandName {
  return unsupportedPiBuiltinNames.has(name)
}

export function findUnsupportedPiBuiltinCommand(message: string): UnsupportedPiBuiltinCommandName | null {
  const leading = message.trimStart()
  if (!leading.startsWith('/')) return null

  for (const name of REJECTED_PI_BUILTIN_COMMAND_NAMES) {
    const invocation = `/${name}`
    if (!leading.startsWith(invocation)) continue

    const delimiter = leading.charAt(invocation.length)
    if (delimiter === '' || /\s/u.test(delimiter)) return name
  }

  return null
}

export function unsupportedPiBuiltinPromptResponse(command: UnsupportedPiBuiltinCommandName): PromptResponse {
  const summary = `Pi built-in /${command} is not supported over ACP; it was not sent to Pi or the model.`

  return {
    stopReason: 'refusal',
    _meta: {
      piAcp: {
        diagnostic: {
          schemaVersion: 1,
          code: PI_ACP_UNSUPPORTED_PI_BUILTIN_CODE,
          phase: 'routing',
          source: 'pi-builtin',
          command,
          summary,
          summaryLimitBytes: PI_UNSUPPORTED_BUILTIN_SUMMARY_LIMIT_BYTES,
          truncated: false,
          redacted: false
        },
        routing: {
          promptForwardedToPi: false,
          sentToModel: false
        }
      }
    }
  }
}
