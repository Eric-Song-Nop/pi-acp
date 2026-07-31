import { writeFileSync } from 'node:fs'

export default function projectTrustCanary() {
  const sentinelPath = process.env.PI_ACP_PROJECT_CANARY_PATH
  if (!sentinelPath) throw new Error('project trust canary requires PI_ACP_PROJECT_CANARY_PATH')
  writeFileSync(sentinelPath, 'project extension loaded\n', { encoding: 'utf8', flag: 'wx' })
}
