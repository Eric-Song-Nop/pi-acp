import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

const RUNTIME_ERROR = 'C1.2_SAFE_EXTENSION_RUNTIME_ERROR'
let emitted = false

export default function registerRuntimeErrorFixture(pi: ExtensionAPI) {
  pi.on('before_agent_start', () => {
    if (emitted) return
    emitted = true
    throw new Error(RUNTIME_ERROR)
  })
}
