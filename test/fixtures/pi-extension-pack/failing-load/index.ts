import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export const FAILING_EXTENSION_SAFE_REASON = 'C1.1_SAFE_EXTENSION_LOAD_REASON'
export const FAILING_EXTENSION_SOURCE = 'global:extensions/pi-acp-failing-load/index.ts'
export const FAILING_EXTENSION_FAKE_CREDENTIAL = 'sk-proj-dummy-internal-hyphens-123456789012'

const OVERSIZED_UNTRUSTED_OUTPUT = 'x'.repeat(24 * 1024)

export default function failDuringExtensionLoad(_pi: ExtensionAPI): never {
  throw new Error(
    [
      `reason=${FAILING_EXTENSION_SAFE_REASON}`,
      `source=${FAILING_EXTENSION_SOURCE}`,
      `untrusted-output=${OVERSIZED_UNTRUSTED_OUTPUT}`,
      `reason=${FAILING_EXTENSION_SAFE_REASON}`,
      `source=${FAILING_EXTENSION_SOURCE}`,
      `fake-credential=${FAILING_EXTENSION_FAKE_CREDENTIAL}`,
      'ansi=\u001b[31mred\u001b[0m\u009b32mgreen\u009b0m',
      'controls=nul:\u0000 bell:\u0007 vertical-tab:\u000b delete:\u007f'
    ].join('\n')
  )
}
