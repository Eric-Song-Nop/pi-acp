import { createHash, randomBytes } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AcpProcessClient } from './acp-process-client.js'

export const REAL_PI_VERSION = '0.83.0'
export const REAL_PI_FIXTURE_PROVIDER_ID = 'pi-acp-fixture'
export const REAL_PI_FIXTURE_MODEL_ID = 'fixture-model-v1'
export const REAL_PI_FIXTURE_COMMAND_ID = 'fixture-state'

export const FORBIDDEN_REAL_PI_ENV_NAMES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_CLOUD_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'OPENROUTER_API_KEY',
  'XAI_API_KEY',
  'COHERE_API_KEY',
  'DEEPSEEK_API_KEY',
  'GROQ_API_KEY',
  'HF_TOKEN',
  'COPILOT_GITHUB_TOKEN',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NPM_CONFIG_USERCONFIG',
  'NPM_CONFIG_REGISTRY',
  'GIT_CONFIG_GLOBAL',
  'GIT_SSH_COMMAND',
  'SSH_AUTH_SOCK',
  'SSL_CERT_FILE',
  'CURL_CA_BUNDLE'
] as const

export const REAL_PI_FIXTURE_ENV_NAMES = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'LANG',
  'LC_ALL',
  'TZ',
  'CI',
  'NO_COLOR',
  'NODE_ENV',
  'PI_OFFLINE',
  'PI_SKIP_VERSION_CHECK',
  'PI_TELEMETRY',
  'PI_PACKAGE_DIR',
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
  'PI_ACP_PI_COMMAND',
  'PI_ACP_FIXTURE_NODE',
  'PI_ACP_FIXTURE_RECEIPT_DIR',
  'PI_ACP_FIXTURE_NONCE',
  'PI_ACP_FIXTURE_API_KEY',
  'PI_ACP_FIXTURE_BASE_URL',
  'PI_ACP_FIXTURE_FORBIDDEN_ENV_NAMES',
  'PI_ACP_PROJECT_CANARY_PATH'
] as const

export type RealPiFixtureReceipt = {
  schemaVersion: 1
  checkpoint: 'C0.6'
  fixtureId: 'pi-extension-pack-v1'
  extensionEvidenceKind: 'cooperative_session_start_on_disk_self_report'
  phase: 'registered_and_started'
  event: 'session_start'
  reason: 'startup'
  nonce: string
  factoryInvocationCount: 1
  piVersion: '0.83.0'
  piPid: number
  nodeVersion: string
  cwd: string
  agentDir: string
  sessionDir: string
  packageDir: string
  extensionRealpath: string
  extensionSha256: string
  cliRealpath: string
  offline: boolean
  versionCheckDisabled: boolean
  telemetryDisabled: boolean
  approveArgPresent: boolean
  extensionArgPresent: boolean
  forbiddenEnvPresent: string[]
  environmentKeys: string[]
  projectTrusted: boolean
  registrations: {
    providers: string[]
    commands: string[]
  }
  model: {
    provider: string
    id: string
    name: string
    available: boolean
    authConfigured: boolean
    selected: boolean
  }
}

export type RealPiShutdownReceipt = {
  schemaVersion: 1
  checkpoint: 'C0.6'
  fixtureId: 'pi-extension-pack-v1'
  phase: 'session_shutdown'
  reason: 'quit'
  nonce: string
  piVersion: '0.83.0'
  piPid: number
}

export type VerifiedReceipt<T> = {
  receipt: T
  stat: Stats
}

type ReceiptBoundary = {
  rootDir: string
  receiptDir: string
  rootStat: Stats
  receiptDirStat: Stats
}

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const agentEntryPath = join(repositoryRoot, 'src', 'index.ts')
const tsxImportPath = fileURLToPath(import.meta.resolve('tsx'))
const piPackageRootPath = join(repositoryRoot, 'node_modules', '@earendil-works', 'pi-coding-agent')
const piCliPath = join(piPackageRootPath, 'dist', 'cli.js')
const globalExtensionSourcePath = fileURLToPath(new URL('../fixtures/pi-extension-pack/index.ts', import.meta.url))
const projectCanarySourcePath = fileURLToPath(
  new URL('../fixtures/pi-extension-pack/project-canary.js', import.meta.url)
)

type LoopbackRequest = {
  method: string | undefined
  url: string | undefined
  host: string | undefined
}

async function listen(server: Server): Promise<AddressInfo> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, '127.0.0.1')
  })

  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('C0.6 loopback server has no TCP address')
  return address
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function assertContainedPath(parent: string, candidate: string, label: string): void {
  const relativePath = relative(parent, candidate)
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`${label} must resolve beneath ${parent}, received ${candidate}`)
  }
}

function assertReceiptStat(path: string, stat: Stats): void {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`C0.6 receipt must be a regular file: ${path}`)
  }
  if (stat.nlink !== 1) throw new Error(`C0.6 receipt must have exactly one hard link: ${path}`)
  if (stat.size <= 0 || stat.size >= 8_192) {
    throw new Error(`C0.6 receipt size is outside the accepted bounds: ${path}`)
  }
  if (process.platform !== 'win32') {
    if ((stat.mode & 0o777) !== 0o600) throw new Error(`C0.6 receipt mode must be 0600: ${path}`)
    if (process.getuid && stat.uid !== process.getuid()) {
      throw new Error(`C0.6 receipt owner must match the test process: ${path}`)
    }
  }
}

function assertReceiptDirectoryStat(path: string, stat: Stats): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`C0.6 receipt ancestor must be a real directory: ${path}`)
  }
  if (process.platform !== 'win32') {
    if ((stat.mode & 0o022) !== 0) {
      throw new Error(`C0.6 receipt ancestor must not be group/world writable: ${path}`)
    }
    if (process.getuid && stat.uid !== process.getuid()) {
      throw new Error(`C0.6 receipt ancestor owner must match the test process: ${path}`)
    }
  }
}

function assertSameFileIdentity(expected: Stats, actual: Stats, label: string): void {
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error(`C0.6 ${label} identity changed`)
  }
}

async function assertReceiptBoundary(boundary: ReceiptBoundary, path: string): Promise<void> {
  const [rootStat, receiptDirStat, canonicalRoot, canonicalReceiptDir, canonicalReceipt] = await Promise.all([
    lstat(boundary.rootDir),
    lstat(boundary.receiptDir),
    realpath(boundary.rootDir),
    realpath(boundary.receiptDir),
    realpath(path)
  ])
  assertReceiptDirectoryStat(boundary.rootDir, rootStat)
  assertReceiptDirectoryStat(boundary.receiptDir, receiptDirStat)
  assertSameFileIdentity(boundary.rootStat, rootStat, 'private root')
  assertSameFileIdentity(boundary.receiptDirStat, receiptDirStat, 'receipt directory')
  if (canonicalRoot !== boundary.rootDir || canonicalReceiptDir !== boundary.receiptDir) {
    throw new Error('C0.6 receipt ancestor canonical path changed')
  }
  assertContainedPath(canonicalRoot, canonicalReceiptDir, 'C0.6 receipt directory')
  assertContainedPath(canonicalReceiptDir, canonicalReceipt, 'C0.6 receipt')
}

async function readVerifiedReceipt<T>(path: string, boundary: ReceiptBoundary): Promise<VerifiedReceipt<T>> {
  await assertReceiptBoundary(boundary, path)
  const pathStat = await lstat(path)
  assertReceiptStat(path, pathStat)

  const noFollowFlag = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW
  const handle = await open(path, constants.O_RDONLY | noFollowFlag)
  try {
    const stat = await handle.stat()
    assertReceiptStat(path, stat)
    if (stat.dev !== pathStat.dev || stat.ino !== pathStat.ino) {
      throw new Error(`C0.6 receipt changed between lstat and no-follow open: ${path}`)
    }

    const source = await handle.readFile('utf8')
    const finalHandleStat = await handle.stat()
    if (
      finalHandleStat.dev !== stat.dev ||
      finalHandleStat.ino !== stat.ino ||
      finalHandleStat.size !== stat.size ||
      finalHandleStat.mtimeMs !== stat.mtimeMs ||
      Buffer.byteLength(source) !== stat.size
    ) {
      throw new Error(`C0.6 receipt changed while it was being read: ${path}`)
    }

    const finalPathStat = await lstat(path)
    if (finalPathStat.dev !== stat.dev || finalPathStat.ino !== stat.ino) {
      throw new Error(`C0.6 receipt path was substituted while it was being read: ${path}`)
    }

    try {
      const receipt = JSON.parse(source) as T
      await assertReceiptBoundary(boundary, path)
      const parsedPathStat = await lstat(path)
      assertSameFileIdentity(stat, parsedPathStat, 'receipt path after parse')
      return { receipt, stat }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('C0.6 ')) throw error
      throw new Error(`C0.6 receipt is not valid JSON: ${path}`, { cause: error })
    }
  } finally {
    await handle.close()
  }
}

function isolatedEnvironment(paths: {
  homeDir: string
  agentDir: string
  sessionDir: string
  tempDir: string
  xdgConfigDir: string
  xdgCacheDir: string
  xdgDataDir: string
  xdgStateDir: string
  emptyBinDir: string
  receiptDir: string
  projectCanaryPath: string
  nonce: string
  baseUrl: string
  piPackageRoot: string
  piCommand: string
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.create(null)
  Object.assign(env, {
    PATH: paths.emptyBinDir,
    HOME: paths.homeDir,
    USERPROFILE: paths.homeDir,
    TMPDIR: paths.tempDir,
    TMP: paths.tempDir,
    TEMP: paths.tempDir,
    XDG_CONFIG_HOME: paths.xdgConfigDir,
    XDG_CACHE_HOME: paths.xdgCacheDir,
    XDG_DATA_HOME: paths.xdgDataDir,
    XDG_STATE_HOME: paths.xdgStateDir,
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    CI: '1',
    NO_COLOR: '1',
    NODE_ENV: 'test',
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    PI_PACKAGE_DIR: paths.piPackageRoot,
    PI_CODING_AGENT_DIR: paths.agentDir,
    PI_CODING_AGENT_SESSION_DIR: paths.sessionDir,
    PI_ACP_PI_COMMAND: paths.piCommand,
    PI_ACP_FIXTURE_NODE: process.execPath,
    PI_ACP_FIXTURE_RECEIPT_DIR: paths.receiptDir,
    PI_ACP_FIXTURE_NONCE: paths.nonce,
    PI_ACP_FIXTURE_API_KEY: `pi-acp-fixture-${paths.nonce}`,
    PI_ACP_FIXTURE_BASE_URL: paths.baseUrl,
    PI_ACP_FIXTURE_FORBIDDEN_ENV_NAMES: JSON.stringify(FORBIDDEN_REAL_PI_ENV_NAMES),
    PI_ACP_PROJECT_CANARY_PATH: paths.projectCanaryPath
  })

  for (const name of ['SYSTEMROOT', 'WINDIR', 'ComSpec', 'PATHEXT']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  return env
}

function piWrapperSource(): string {
  if (process.platform === 'win32') {
    return '@"%PI_ACP_FIXTURE_NODE%" "%PI_PACKAGE_DIR%\\dist\\cli.js" %*\r\n'
  }
  return '#!/bin/sh\nexec "$PI_ACP_FIXTURE_NODE" "$PI_PACKAGE_DIR/dist/cli.js" "$@"\n'
}

export async function startRealPiFixture() {
  const rootDir = await mkdtemp(join(await realpath(tmpdir()), 'pi-acp-real-pi-'))
  await chmod(rootDir, 0o700)

  const requests: LoopbackRequest[] = []
  const server = createServer((request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      host: request.headers.host
    })
    response.statusCode = 503
    response.end('C0.6 fixture does not permit model requests\n')
  })

  let client: AcpProcessClient | undefined
  try {
    const address = await listen(server)
    server.unref()

    const homeDir = join(rootDir, 'home')
    const cwd = join(rootDir, 'workspace')
    const agentDir = join(homeDir, '.pi', 'agent')
    const sessionDir = join(rootDir, 'sessions')
    const tempDir = join(rootDir, 'tmp')
    const xdgConfigDir = join(rootDir, 'xdg', 'config')
    const xdgCacheDir = join(rootDir, 'xdg', 'cache')
    const xdgDataDir = join(rootDir, 'xdg', 'data')
    const xdgStateDir = join(rootDir, 'xdg', 'state')
    const emptyBinDir = join(rootDir, 'empty-bin')
    const receiptDir = join(rootDir, 'artifacts')
    const extensionDir = join(agentDir, 'extensions', 'pi-acp-fixture')
    const projectExtensionDir = join(cwd, '.pi', 'extensions')
    const extensionPath = join(extensionDir, 'index.ts')
    const projectExtensionPath = join(projectExtensionDir, 'project-canary.js')
    const nonce = randomBytes(16).toString('hex')
    const registrationReceiptPath = join(receiptDir, `pi-acp-c0.6-registration-${nonce}.json`)
    const shutdownReceiptPath = join(receiptDir, `pi-acp-c0.6-shutdown-${nonce}.json`)
    const projectCanaryPath = join(rootDir, 'project-extension-loaded')
    const trustPath = join(agentDir, 'trust.json')
    const authPath = join(agentDir, 'auth.json')
    const sessionMapPath = join(homeDir, '.pi', 'pi-acp', 'session-map.json')
    const piCommand = join(rootDir, process.platform === 'win32' ? 'pi-fixture.cmd' : 'pi-fixture')
    const baseUrl = `http://127.0.0.1:${String(address.port)}/v1`

    await Promise.all(
      [
        homeDir,
        cwd,
        agentDir,
        sessionDir,
        tempDir,
        xdgConfigDir,
        xdgCacheDir,
        xdgDataDir,
        xdgStateDir,
        emptyBinDir,
        receiptDir,
        extensionDir,
        projectExtensionDir
      ].map(path => mkdir(path, { recursive: true }))
    )

    const repositoryRealpath = await realpath(repositoryRoot)
    const nodeModulesRoot = await realpath(join(repositoryRoot, 'node_modules'))
    const piPackageRoot = await realpath(piPackageRootPath)
    const expectedCliRealpath = await realpath(piCliPath)
    assertContainedPath(repositoryRealpath, nodeModulesRoot, 'C0.6 node_modules')
    assertContainedPath(nodeModulesRoot, piPackageRoot, 'C0.6 Pi package')
    assertContainedPath(piPackageRoot, expectedCliRealpath, 'C0.6 Pi CLI')
    const packageMetadata = JSON.parse(await readFile(join(piPackageRoot, 'package.json'), 'utf8')) as {
      name?: unknown
      version?: unknown
    }
    if (packageMetadata.name !== '@earendil-works/pi-coding-agent' || packageMetadata.version !== REAL_PI_VERSION) {
      throw new Error(
        `C0.6 requires @earendil-works/pi-coding-agent@${REAL_PI_VERSION}, received ${String(
          packageMetadata.name
        )}@${String(packageMetadata.version)}`
      )
    }

    const settings = {
      defaultProvider: REAL_PI_FIXTURE_PROVIDER_ID,
      defaultModel: REAL_PI_FIXTURE_MODEL_ID,
      defaultThinkingLevel: 'off',
      defaultProjectTrust: 'never',
      quietStartup: true,
      enableInstallTelemetry: false,
      enableAnalytics: false,
      enableSkillCommands: false,
      retry: {
        enabled: false,
        provider: {
          maxRetries: 0
        }
      },
      compaction: {
        enabled: false
      },
      sessionDir
    }

    await Promise.all([
      copyFile(globalExtensionSourcePath, extensionPath),
      copyFile(projectCanarySourcePath, projectExtensionPath),
      writeFile(piCommand, piWrapperSource(), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o700
      }),
      writeFile(join(agentDir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600
      }),
      writeFile(authPath, '{}\n', {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600
      })
    ])

    const extensionSource = await readFile(globalExtensionSourcePath)
    const expectedExtensionSha256 = createHash('sha256').update(extensionSource).digest('hex')
    const expectedExtensionRealpath = await realpath(extensionPath)
    const receiptBoundary: ReceiptBoundary = {
      rootDir: await realpath(rootDir),
      receiptDir: await realpath(receiptDir),
      rootStat: await lstat(rootDir),
      receiptDirStat: await lstat(receiptDir)
    }
    assertReceiptDirectoryStat(receiptBoundary.rootDir, receiptBoundary.rootStat)
    assertReceiptDirectoryStat(receiptBoundary.receiptDir, receiptBoundary.receiptDirStat)
    assertContainedPath(receiptBoundary.rootDir, receiptBoundary.receiptDir, 'C0.6 receipt directory')

    client = new AcpProcessClient({
      command: process.execPath,
      args: ['--import', tsxImportPath, agentEntryPath],
      cwd,
      env: isolatedEnvironment({
        homeDir,
        agentDir,
        sessionDir,
        tempDir,
        xdgConfigDir,
        xdgCacheDir,
        xdgDataDir,
        xdgStateDir,
        emptyBinDir,
        receiptDir,
        projectCanaryPath,
        nonce,
        baseUrl,
        piPackageRoot,
        piCommand
      }),
      requestTimeoutMs: 20_000,
      updateTimeoutMs: 10_000,
      shutdownTimeoutMs: 5_000,
      stderrLimitBytes: 16 * 1024,
      clientBehavior: 'raw',
      transcriptMetadata: {
        planId: 'PACP-CMD-2026-01',
        checkpoint: 'C0.6',
        fixtureId: 'pi-extension-pack-v1',
        piAcpVersion: '0.0.33',
        piVersion: REAL_PI_VERSION,
        client: 'raw-process-client'
      }
    })

    let cleanupPromise: Promise<void> | undefined
    return {
      client,
      rootDir,
      cwd,
      agentDir,
      sessionDir,
      registrationReceiptPath,
      shutdownReceiptPath,
      projectCanaryPath,
      trustPath,
      authPath,
      sessionMapPath,
      nonce,
      expectedCliRealpath,
      expectedExtensionRealpath,
      expectedExtensionSha256,
      piPackageRoot,
      packageVersion: REAL_PI_VERSION,
      requests,
      async readRegistrationReceipt(): Promise<VerifiedReceipt<RealPiFixtureReceipt>> {
        return await readVerifiedReceipt<RealPiFixtureReceipt>(registrationReceiptPath, receiptBoundary)
      },
      async readShutdownReceipt(): Promise<VerifiedReceipt<RealPiShutdownReceipt>> {
        return await readVerifiedReceipt<RealPiShutdownReceipt>(shutdownReceiptPath, receiptBoundary)
      },
      async closeLoopback(): Promise<void> {
        await closeServer(server)
      },
      async cleanup(): Promise<void> {
        cleanupPromise ??= (async () => {
          const errors: unknown[] = []
          try {
            await client?.close()
          } catch (error) {
            errors.push(error)
          }
          try {
            await closeServer(server)
          } catch (error) {
            errors.push(error)
          }
          try {
            await rm(rootDir, { recursive: true, force: true })
          } catch (error) {
            errors.push(error)
          }
          if (errors.length > 0) throw new AggregateError(errors, 'C0.6 real Pi fixture cleanup failed')
        })()
        await cleanupPromise
      }
    }
  } catch (error) {
    try {
      await client?.close()
    } finally {
      await closeServer(server).catch(() => undefined)
      await rm(rootDir, { recursive: true, force: true })
    }
    throw error
  }
}
