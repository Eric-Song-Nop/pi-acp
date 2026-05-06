import { spawn } from 'node:child_process'

const agent = spawn('node', ['dist/index.js'], { stdio: ['pipe', 'pipe', 'inherit'] })

let buf = ''
agent.stdout.on('data', d => {
  buf += d.toString('utf8')
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx)
    buf = buf.slice(idx + 1)
    if (!line.trim()) continue
    try {
      const msg = JSON.parse(line)
      if (msg.id === 2) {
        const startupInfo = msg.result?._meta?.piAcp?.startupInfo
        if (typeof startupInfo === 'string' && startupInfo.trim()) {
          console.log('OK: got startup info in session/new _meta')
          agent.kill('SIGTERM')
          process.exit(0)
        }
      }
    } catch {
      // ignore
    }
  }
})

function send(obj) {
  agent.stdin.write(JSON.stringify(obj) + '\n')
}

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } })
send({
  jsonrpc: '2.0',
  id: 2,
  method: 'session/new',
  params: { cwd: process.cwd(), mcpServers: [] }
})

setTimeout(() => {
  console.error('FAIL: did not observe startup info in session/new _meta')
  agent.kill('SIGTERM')
  process.exit(1)
}, 5000)
