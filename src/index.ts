import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'
import { PiAcpAgent } from './acp/agent.js'
import { createAdapterOutputGate } from './adapter-output.js'
import { createAdapterShutdown } from './adapter-shutdown.js'
import { bindAdapterShutdownTriggers, createAdapterInputStream } from './adapter-transport.js'
import { getPiCommand, shouldUseShellForPiCommand } from './pi-rpc/command.js'
// Terminal Auth entrypoint. The ACP client launches the agent with `--terminal-login`.
if (process.argv.includes('--terminal-login')) {
  const { spawnSync } = await import('node:child_process')
  const cmd = getPiCommand(process.env.PI_ACP_PI_COMMAND)
  const res = spawnSync(cmd, [], {
    stdio: 'inherit',
    env: process.env,
    shell: shouldUseShellForPiCommand(cmd)
  })

  if ((res as any).error && (res as any).error.code === 'ENOENT') {
    process.stderr.write(
      `pi-acp: could not start pi (command not found: ${cmd}). Install it via \`npm install -g @earendil-works/pi-coding-agent\` or ensure \`pi\` is on your PATH.\n`
    )
    process.exit(1)
  }

  process.exit(typeof res.status === 'number' ? res.status : 1)
}

const adapterOutput = createAdapterOutputGate(process.stdout)
let acpAgent: PiAcpAgent | undefined
const requestShutdown = createAdapterShutdown({
  fenceOutput: () => adapterOutput.fence(),
  dispose: () => acpAgent?.dispose(),
  exit: () => process.exit(0)
})

function shutdown(): void {
  void requestShutdown()
}

const input = new WritableStream<Uint8Array>({
  write: chunk => adapterOutput.write(chunk)
})

const output = createAdapterInputStream(process.stdin, shutdown)

const stream = ndJsonStream(input, output)

const connection = new AgentSideConnection(conn => {
  acpAgent = new PiAcpAgent(conn)
  return acpAgent
}, stream)
bindAdapterShutdownTriggers({ output: process.stdout, connectionSignal: connection.signal, shutdown })

process.stdin.resume()
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
