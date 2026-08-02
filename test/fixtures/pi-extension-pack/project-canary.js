import { appendFileSync } from 'node:fs'

export default function projectTrustCanary() {
  const sentinelPath = process.env.PI_ACP_PROJECT_CANARY_PATH
  if (!sentinelPath) throw new Error('project trust canary requires PI_ACP_PROJECT_CANARY_PATH')

  appendFileSync(sentinelPath, `${String(process.pid)}\n`, { encoding: 'utf8', mode: 0o600 })
}
