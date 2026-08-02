import { appendFileSync, readFileSync } from 'node:fs'

export default function projectTrustCanary() {
  const sentinelPath = process.env.PI_ACP_PROJECT_CANARY_PATH
  if (!sentinelPath) throw new Error('project trust canary requires PI_ACP_PROJECT_CANARY_PATH')

  let recordedPids = []
  try {
    recordedPids = readFileSync(sentinelPath, 'utf8').split('\n').filter(Boolean)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  const pid = String(process.pid)
  if (!recordedPids.includes(pid)) {
    appendFileSync(sentinelPath, `${pid}\n`, { encoding: 'utf8', mode: 0o600 })
  }
}
