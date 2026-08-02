import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSideConnection, AvailableCommand } from '@agentclientprotocol/sdk'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

const ADAPTER_COMMAND_NAMES = [
  'compact',
  'autocompact',
  'export',
  'session',
  'name',
  'steering',
  'follow-up',
  'changelog'
] as const

const REJECTED_PI_BUILTIN_NAMES = [
  'settings',
  'model',
  'scoped-models',
  'import',
  'share',
  'copy',
  'hotkeys',
  'fork',
  'clone',
  'tree',
  'trust',
  'login',
  'logout',
  'new',
  'resume',
  'reload',
  'quit'
] as const

type CatalogPath = 'new' | 'load'
type CatalogSource = 'primary' | 'fallback'
type SessionUpdateMessage = Parameters<AgentSideConnection['sessionUpdate']>[0]

class CatalogConnection extends FakeAgentSideConnection {
  private resolveCatalog!: (message: SessionUpdateMessage) => void
  readonly catalogPublished = new Promise<SessionUpdateMessage>(resolve => {
    this.resolveCatalog = resolve
  })

  override async sessionUpdate(message: SessionUpdateMessage): Promise<void> {
    await super.sessionUpdate(message)
    if (message.update.sessionUpdate === 'available_commands_update') this.resolveCatalog(message)
  }
}

class NewSessionManager {
  constructor(private readonly session: ReturnType<typeof createSession>) {}

  async create() {
    return this.session
  }

  async closeAllExcept() {}

  maybeGet(sessionId: string) {
    return sessionId === this.session.sessionId ? this.session : undefined
  }
}

class LoadSessionManager {
  constructor(private readonly session: ReturnType<typeof createSession>) {}

  async close() {}

  async closeAllExcept() {}

  maybeGet(sessionId: string) {
    return sessionId === this.session.sessionId ? this.session : undefined
  }
}

function createSession(sessionId: string, cwd: string, source: CatalogSource, getCommandsCalls: { value: number }) {
  const sessionFile = join(cwd, `${sessionId}.jsonl`)
  const state = {
    sessionId,
    sessionFile,
    thinkingLevel: 'medium',
    model: { provider: 'test', id: 'model' }
  }
  const proc = {
    isAlive: () => true,
    async getState() {
      return state
    },
    async getAvailableModels() {
      return { models: [{ provider: 'test', id: 'model', name: 'Model' }] }
    },
    async getMessages() {
      return { messages: [] }
    },
    async getCommands() {
      getCommandsCalls.value += 1
      if (source === 'fallback') throw new Error('force builtin-only fallback')
      return {
        commands: [
          ...REJECTED_PI_BUILTIN_NAMES.map(name => ({
            name,
            description: `Rejected /${name} collision`,
            source: 'prompt'
          })),
          { name: 'primary-visible', description: 'Primary marker', source: 'prompt' }
        ]
      }
    }
  }

  return {
    sessionId,
    sessionFile,
    initialState: state,
    cwd,
    proc,
    isAlive: () => true,
    async runRpc<T>(operation: (candidate: typeof proc) => Promise<T>) {
      return operation(proc)
    },
    setStartupInfo() {},
    sendStartupInfoIfPending() {}
  }
}

async function withDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 1_000)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

async function exerciseCatalog(path: CatalogPath, source: CatalogSource): Promise<AvailableCommand[]> {
  const root = mkdtempSync(join(tmpdir(), `pi-acp-c2.2-catalog-${path}-${source}-`))
  const cwd = join(root, 'project')
  const promptDir = join(cwd, '.pi', 'prompts')
  const agentDir = join(root, 'agent')
  const emptyBin = join(root, 'empty-bin')
  mkdirSync(promptDir, { recursive: true })
  mkdirSync(agentDir, { recursive: true })
  mkdirSync(emptyBin, { recursive: true })
  writeFileSync(join(cwd, '.pi', 'settings.json'), JSON.stringify({ quietStartup: true }), 'utf8')
  for (const name of REJECTED_PI_BUILTIN_NAMES) {
    writeFileSync(join(promptDir, `${name}.md`), `Rejected /${name} fallback collision`, 'utf8')
  }
  writeFileSync(join(promptDir, 'fallback-visible.md'), 'Fallback marker', 'utf8')

  const previousHome = process.env.HOME
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  const previousPath = process.env.PATH
  process.env.HOME = root
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PATH = emptyBin

  try {
    const sessionId = `catalog-${path}-${source}`
    const getCommandsCalls = { value: 0 }
    const session = createSession(sessionId, cwd, source, getCommandsCalls)
    const conn = new CatalogConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))

    if (path === 'new') {
      ;(agent as any).sessions = new NewSessionManager(session) as any
      await agent.newSession({ cwd, mcpServers: [] } as any)
    } else {
      ;(agent as any).sessions = new LoadSessionManager(session) as any
      ;(agent as any).store = {
        get: () => ({ sessionId, cwd, sessionFile: session.sessionFile, updatedAt: new Date(0).toISOString() }),
        upsert() {}
      }
      ;(agent as any).restoreSession = async () => session
      await agent.loadSession({ sessionId, cwd, mcpServers: [] } as any)
    }

    const notification = await withDeadline(conn.catalogPublished, `${path}/${source} catalog publication`)
    assert.equal(getCommandsCalls.value, 1)
    assert.equal(notification.update.sessionUpdate, 'available_commands_update')
    if (notification.update.sessionUpdate !== 'available_commands_update') throw new Error('catalog update expected')
    return notification.update.availableCommands
  } finally {
    restoreEnvironment('HOME', previousHome)
    restoreEnvironment('PI_CODING_AGENT_DIR', previousAgentDir)
    restoreEnvironment('PATH', previousPath)
    rmSync(root, { recursive: true, force: true })
  }
}

test('PiAcpAgent: new/load catalogs use Pi discovery or adapter builtins only', async t => {
  for (const path of ['new', 'load'] as const) {
    for (const source of ['primary', 'fallback'] as const) {
      await t.test(`${path} uses filtered ${source} catalog`, async () => {
        const commands = await exerciseCatalog(path, source)
        const names = commands.map(command => command.name)
        const adapterNames = names.filter(name => (ADAPTER_COMMAND_NAMES as readonly string[]).includes(name))

        assert.deepEqual(
          names.filter(name => (REJECTED_PI_BUILTIN_NAMES as readonly string[]).includes(name)),
          []
        )
        assert.equal(names.includes('primary-visible'), source === 'primary')
        assert.equal(names.includes('fallback-visible'), false)
        assert.deepEqual(adapterNames, ADAPTER_COMMAND_NAMES)
        assert.equal(new Set(names).size, names.length)
      })
    }
  }
})
