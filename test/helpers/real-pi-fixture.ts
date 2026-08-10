import { createHash, randomBytes } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import {
  access,
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AcpProcessClient, type AcpTranscriptMetadata } from './acp-process-client.js'

export const REAL_PI_VERSION = '0.83.0'
export const REAL_PI_FIXTURE_PROVIDER_ID = 'pi-acp-fixture'
export const REAL_PI_FIXTURE_MODEL_ID = 'fixture-model-v1'
export const REAL_PI_FIXTURE_COMMAND_ID = 'fixture-state'
export const REAL_PI_FIXTURE_AGENT_COMMAND_ID = 'fixture-agent'
export const C3_5_FIXTURE_AGENT_USER_TEXT = 'Run the deterministic Pi ACP C3.5 fixture agent turn.'
export const C3_5_FIXTURE_AGENT_RESPONSE_TEXT = 'Pi ACP C3.5 fixture agent response'
const C3_5_RELEASE_TEXT = 'release\n'
export const C1_2_RUNTIME_EXTENSION_RESPONSE_TEXT = 'C1.2 deterministic agent response'
export const C1_3_RECOVERY_RESPONSE_TEXT = 'C1.3 deterministic recovery response'
export const C1_4_LF_JSONL_RESPONSE_TEXT = 'BEFORE\u2028MIDDLE\u2029AFTER'
export const C1_4_LF_JSONL_LIVENESS_RESPONSE_TEXT = 'C1.4 post-turn liveness response'
export const C1_4_LF_JSONL_USER_TEXT = 'Return the deterministic C1.4 LF JSONL response.'
export const C1_4_LF_JSONL_LIVENESS_USER_TEXT = 'Return the deterministic C1.4 liveness response.'
export const C3_4_FIXTURE_HANG_SENTINEL = 'hang-after-receipt'
const LOOPBACK_CLOSE_TIMEOUT_MS = 1_000
const LOOPBACK_BODY_TIMEOUT_MS = 2_000
export const MAX_LOOPBACK_BODY_BYTES = 64 * 1024

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

export type RealPiC1_3SessionStartReceipt = {
  schemaVersion: 1
  checkpoint: 'C1.3'
  phase: 'session_start'
  nonce: string
  piVersion: '0.83.0'
  piPid: number
  sessionId: string
  sessionFile: string | null
}

export type RealPiC3_4SessionStartReceipt = {
  schemaVersion: 1
  checkpoint: 'C3.4'
  phase: 'session_start'
  nonce: string
  piVersion: '0.83.0'
  piPid: number
  sessionId: string
  sessionFile: string | null
}

export type RealPiC3_4InvocationReceipt = {
  schemaVersion: 1
  checkpoint: 'C3.4'
  phase: 'command_invocation'
  nonce: string
  piVersion: '0.83.0'
  piPid: number
  sessionId: string
  sessionFile: string | null
  invocationCount: number
  name: 'fixture-state'
  args: string
  argsUtf8ByteLength: number
  argsSha256: string
  argsBase64: string
}

export type RealPiC3_4ShutdownReceipt = {
  schemaVersion: 1
  checkpoint: 'C3.4'
  phase: 'session_shutdown'
  reason: 'quit'
  nonce: string
  piVersion: '0.83.0'
  piPid: number
}

export type RealPiC3_5Schedule = 'preflight' | 'provider-final'

export type RealPiC3_5Receipt = {
  schemaVersion: 1
  checkpoint: 'C3.5'
  phase:
    | 'session-start'
    | 'command-invocation'
    | 'before-agent-start-entered'
    | 'before-agent-start-released'
    | 'agent-start'
    | 'agent-end'
    | 'agent-settled'
    | 'session-shutdown'
  sequence: number
  nonce: string
  schedule: RealPiC3_5Schedule
  piVersion: '0.83.0'
  piPid: number
  sessionId: string
  sessionFile: string | null
  invocationCount?: number
  name?: 'fixture-agent'
  args?: string
  argsUtf8ByteLength?: number
  argsBase64?: string
  reason?: 'quit'
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

export type RealPiFixtureOptions = {
  clientBehavior?: 'raw' | 'strict'
  extensionLoadFailure?: true
  runtimeExtensionError?: true
  childTermination?: true
  lfJsonlResponse?: true
  hardDeadlineMs?: number
  clientShutdownTimeoutMs?: number
  transcriptCheckpoint?: 'C0.6' | 'C0.7' | 'C1.1' | 'C1.2' | 'C1.3' | 'C1.4' | 'C1.5' | 'C2.2' | 'C3.4' | 'C3.5'
  transcriptCaseId?: string
  transcriptMetadata?: AcpTranscriptMetadata
  fixtureMode?: 'c3.4-execute-command' | 'c3.5-agent-run'
  c3_5Schedule?: RealPiC3_5Schedule
  patchedPiPackageRoot?: string
  projectPrompts?: readonly {
    name: string
    contents: string
  }[]
}

export class RealPiFixtureDeadlineError extends Error {
  constructor(
    readonly deadlineMs: number,
    options?: ErrorOptions
  ) {
    super(`real Pi fixture exceeded its ${String(deadlineMs)}ms hard deadline`, options)
    this.name = 'RealPiFixtureDeadlineError'
  }
}

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const agentEntryPath = join(repositoryRoot, 'src', 'index.ts')
const tsxImportPath = fileURLToPath(import.meta.resolve('tsx'))
const piPackageRootPath = join(repositoryRoot, 'node_modules', '@earendil-works', 'pi-coding-agent')
const globalExtensionSourcePath = fileURLToPath(new URL('../fixtures/pi-extension-pack/index.ts', import.meta.url))
const c3_4ExecuteCommandExtensionSourcePath = fileURLToPath(
  new URL('../fixtures/pi-extension-pack/c3.4-execute-command/index.ts', import.meta.url)
)
const c3_5AgentRunExtensionSourcePath = fileURLToPath(
  new URL('../fixtures/pi-extension-pack/c3.5-agent-run/index.ts', import.meta.url)
)
const failingGlobalExtensionSourcePath = fileURLToPath(
  new URL('../fixtures/pi-extension-pack/failing-load/index.ts', import.meta.url)
)
const runtimeErrorExtensionSourcePath = fileURLToPath(
  new URL('../fixtures/pi-extension-pack/runtime-error/index.ts', import.meta.url)
)
const childTerminationExtensionSourcePath = fileURLToPath(
  new URL('../fixtures/pi-extension-pack/child-termination/index.ts', import.meta.url)
)
const projectCanarySourcePath = fileURLToPath(
  new URL('../fixtures/pi-extension-pack/project-canary.js', import.meta.url)
)

export type LoopbackRequest = {
  method: string | undefined
  url: string | undefined
  host: string | undefined
  body: Buffer | undefined
  bodyByteLength: number
  bodyExceededLimit: boolean
  outcome: 'pending' | 'end' | 'timeout' | 'aborted' | 'error'
  authorization?: string
  contentType?: string
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

function createServerCloser(server: Server, sockets: Set<Socket>): () => Promise<void> {
  let closePromise: Promise<void> | undefined
  return async () => {
    closePromise ??= new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      }
      const timer = setTimeout(() => {
        for (const socket of sockets) socket.destroy()
        server.closeAllConnections()
        finish(new Error(`C0.7 loopback listener did not close within ${String(LOOPBACK_CLOSE_TIMEOUT_MS)}ms`))
      }, LOOPBACK_CLOSE_TIMEOUT_MS)
      timer.unref()

      if (server.listening) {
        server.close(error => finish(error ?? undefined))
      } else {
        finish()
      }
      for (const socket of sockets) socket.destroy()
      server.closeIdleConnections()
      server.closeAllConnections()
    })
    await closePromise
  }
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

    let receipt: T
    try {
      receipt = JSON.parse(source) as T
    } catch (error) {
      throw new Error(`C0.6 receipt is not valid JSON: ${path}`, { cause: error })
    }
    await assertReceiptBoundary(boundary, path)
    const parsedPathStat = await lstat(path)
    assertSameFileIdentity(stat, parsedPathStat, 'receipt path after parse')
    return { receipt, stat }
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
  piNode: string
  fixtureStatePreview: boolean
  fixtureAgentPreview: boolean
  c3_5Schedule: RealPiC3_5Schedule | undefined
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
    PI_ACP_FIXTURE_NODE: paths.piNode,
    PI_ACP_FIXTURE_RECEIPT_DIR: paths.receiptDir,
    PI_ACP_FIXTURE_NONCE: paths.nonce,
    PI_ACP_FIXTURE_API_KEY: `pi-acp-fixture-${paths.nonce}`,
    PI_ACP_FIXTURE_BASE_URL: paths.baseUrl,
    PI_ACP_FIXTURE_FORBIDDEN_ENV_NAMES: JSON.stringify(FORBIDDEN_REAL_PI_ENV_NAMES),
    PI_ACP_PROJECT_CANARY_PATH: paths.projectCanaryPath
  })
  if (paths.fixtureStatePreview) env.PI_ACP_EXPERIMENTAL_FIXTURE_STATE = '1'
  if (paths.fixtureAgentPreview) {
    env.PI_ACP_EXPERIMENTAL_FIXTURE_AGENT = '1'
    env.PI_ACP_C3_5_SCHEDULE = paths.c3_5Schedule
  }

  for (const name of ['SYSTEMROOT', 'WINDIR', 'ComSpec', 'PATHEXT']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  return env
}

function posixShellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function windowsCommandQuote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function piWrapperSource(nodePath: string, cliPath: string): string {
  if (process.platform === 'win32') {
    return `@${windowsCommandQuote(nodePath)} ${windowsCommandQuote(cliPath)} %*\r\n`
  }
  return `#!/bin/sh\nexec ${posixShellQuote(nodePath)} ${posixShellQuote(cliPath)} "$@"\n`
}

function validateProjectPrompts(
  prompts: RealPiFixtureOptions['projectPrompts']
): readonly { name: string; contents: string }[] {
  const normalized = prompts ?? []
  const names = new Set<string>()
  for (const prompt of normalized) {
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(prompt.name)) {
      throw new TypeError('C0.7 project prompt names must be lowercase bare command names')
    }
    if (names.has(prompt.name)) {
      throw new TypeError(`C0.7 project prompt name is duplicated: ${prompt.name}`)
    }
    if (prompt.contents.length === 0 || Buffer.byteLength(prompt.contents) > 4_096) {
      throw new TypeError(`C0.7 project prompt ${prompt.name} must contain 1..4096 UTF-8 bytes`)
    }
    names.add(prompt.name)
  }
  return normalized
}

async function throwAfterC3_5ReleaseCleanup(temporaryPath: string, error: unknown): Promise<never> {
  try {
    await rm(temporaryPath, { force: true })
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], 'C3.5 release sentinel publication and cleanup failed')
  }
  throw error
}

async function writeC3_5Release(path: string | undefined): Promise<void> {
  if (!path) return
  const temporaryPath = `${path}.${String(process.pid)}.${randomBytes(8).toString('hex')}.tmp`
  const handle = await open(temporaryPath, 'wx', 0o600)
  let stageError: unknown
  try {
    await handle.writeFile(C3_5_RELEASE_TEXT, 'utf8')
    await handle.sync()
  } catch (error) {
    stageError = error
  }
  try {
    await handle.close()
  } catch (error) {
    stageError =
      stageError === undefined
        ? error
        : new AggregateError([stageError, error], 'C3.5 release sentinel staging and close failed')
  }
  if (stageError !== undefined) await throwAfterC3_5ReleaseCleanup(temporaryPath, stageError)

  try {
    await link(temporaryPath, path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      await throwAfterC3_5ReleaseCleanup(temporaryPath, error)
    }
    let existingContents: string | undefined
    try {
      existingContents = await readFile(path, 'utf8')
    } catch (readError) {
      await throwAfterC3_5ReleaseCleanup(
        temporaryPath,
        new AggregateError([error, readError], 'C3.5 release sentinel publication failed')
      )
    }
    if (existingContents !== C3_5_RELEASE_TEXT) {
      await throwAfterC3_5ReleaseCleanup(
        temporaryPath,
        new Error('C3.5 release sentinel has invalid contents', { cause: error })
      )
    }
  }
  await rm(temporaryPath, { force: true })
}

async function waitForC3_5Release(path: string): Promise<void> {
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      if ((await readFile(path, 'utf8')) !== C3_5_RELEASE_TEXT) {
        throw new Error('C3.5 release sentinel has invalid contents')
      }
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (Date.now() >= deadline) throw new Error('C3.5 provider-final release sentinel timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

export async function startRealPiFixture(options: RealPiFixtureOptions = {}) {
  const projectPrompts = validateProjectPrompts(options.projectPrompts)
  const c3_4ExecuteCommand = options.fixtureMode === 'c3.4-execute-command'
  const c3_5AgentRun = options.fixtureMode === 'c3.5-agent-run'
  const patchedPreview = c3_4ExecuteCommand || c3_5AgentRun
  if (options.patchedPiPackageRoot !== undefined && !patchedPreview) {
    throw new TypeError('patched Pi package root is accepted only by a C3.4/C3.5 execute-command fixture')
  }
  if (patchedPreview && !options.patchedPiPackageRoot) {
    throw new TypeError('C3.4/C3.5 execute-command fixture requires a patched Pi package root')
  }
  if (options.patchedPiPackageRoot !== undefined && !isAbsolute(options.patchedPiPackageRoot)) {
    throw new TypeError('patched Pi package root must be absolute')
  }
  if (c3_5AgentRun && options.c3_5Schedule !== 'preflight' && options.c3_5Schedule !== 'provider-final') {
    throw new TypeError('C3.5 agent-run fixture requires a preflight or provider-final schedule')
  }
  if (!c3_5AgentRun && options.c3_5Schedule !== undefined) {
    throw new TypeError('C3.5 schedule is accepted only by the C3.5 agent-run fixture')
  }
  const extensionLoadFailure = options.extensionLoadFailure === true
  const runtimeExtensionError = options.runtimeExtensionError === true
  const childTermination = options.childTermination === true
  const lfJsonlResponse = options.lfJsonlResponse === true
  if (
    [
      extensionLoadFailure,
      runtimeExtensionError,
      childTermination,
      lfJsonlResponse,
      c3_4ExecuteCommand,
      c3_5AgentRun
    ].filter(Boolean).length > 1
  ) {
    throw new TypeError(
      'real Pi fixture load failure, runtime error, child termination, LF JSONL response, C3.4, and C3.5 modes are mutually exclusive'
    )
  }
  const hardDeadlineMs = options.hardDeadlineMs
  if (
    hardDeadlineMs !== undefined &&
    (!Number.isInteger(hardDeadlineMs) || hardDeadlineMs < 100 || hardDeadlineMs > 120_000)
  ) {
    throw new TypeError('real Pi fixture hard deadline must be an integer from 100ms through 120000ms')
  }
  const clientShutdownTimeoutMs = options.clientShutdownTimeoutMs ?? 5_000
  if (!Number.isInteger(clientShutdownTimeoutMs) || clientShutdownTimeoutMs < 25 || clientShutdownTimeoutMs > 10_000) {
    throw new TypeError('real Pi fixture client shutdown timeout must be an integer from 25ms through 10000ms')
  }
  const rootDir = await mkdtemp(join(await realpath(tmpdir()), 'pi-acp-real-pi-'))
  await chmod(rootDir, 0o700)
  const nonce = randomBytes(16).toString('hex')
  let c3_5PreflightReleasePath: string | undefined
  let c3_5ProviderFinalReleasePath: string | undefined

  const requests: LoopbackRequest[] = []
  const sockets = new Set<Socket>()
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    let bodyByteLength = 0
    let bodyExceededLimit = false
    const observation: LoopbackRequest = {
      method: request.method,
      url: request.url,
      host: request.headers.host,
      body: undefined,
      bodyByteLength: 0,
      bodyExceededLimit: false,
      outcome: 'pending',
      ...(c3_5AgentRun
        ? {
            authorization:
              typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined,
            contentType:
              typeof request.headers['content-type'] === 'string' ? request.headers['content-type'] : undefined
          }
        : {})
    }
    requests.push(observation)

    const settle = (outcome: Exclude<LoopbackRequest['outcome'], 'pending'>): boolean => {
      if (observation.outcome !== 'pending') return false
      observation.body = bodyExceededLimit ? undefined : Buffer.concat(chunks, bodyByteLength)
      observation.bodyByteLength = bodyByteLength
      observation.bodyExceededLimit = bodyExceededLimit
      observation.outcome = outcome
      return true
    }
    const sendC3_5Response = async (): Promise<void> => {
      const fail = (statusCode: number, message: string): void => {
        response.statusCode = statusCode
        response.end(`${message}\n`)
      }
      if (bodyExceededLimit || !observation.body) {
        fail(413, 'C3.5 fixture rejected an oversized provider request')
        return
      }
      if (
        observation.method !== 'POST' ||
        observation.url !== '/v1/chat/completions' ||
        observation.authorization !== `Bearer pi-acp-fixture-${nonce}` ||
        !observation.contentType?.startsWith('application/json')
      ) {
        fail(400, 'C3.5 fixture rejected provider request metadata')
        return
      }

      let requestBody: Record<string, unknown>
      try {
        requestBody = JSON.parse(observation.body.toString('utf8')) as Record<string, unknown>
      } catch {
        fail(400, 'C3.5 fixture rejected malformed provider JSON')
        return
      }
      const messages = Array.isArray(requestBody.messages) ? requestBody.messages : []
      const userMessages = messages.filter(message => {
        const candidate = message as { role?: unknown }
        return candidate && typeof candidate === 'object' && candidate.role === 'user'
      }) as { content?: unknown }[]
      const userContent = userMessages[0]?.content
      const hasExactUserContent =
        userContent === C3_5_FIXTURE_AGENT_USER_TEXT ||
        (Array.isArray(userContent) &&
          userContent.length === 1 &&
          (userContent[0] as { type?: unknown; text?: unknown })?.type === 'text' &&
          (userContent[0] as { type?: unknown; text?: unknown })?.text === C3_5_FIXTURE_AGENT_USER_TEXT)
      if (
        requestBody.model !== REAL_PI_FIXTURE_MODEL_ID ||
        requestBody.stream !== true ||
        userMessages.length !== 1 ||
        !hasExactUserContent ||
        observation.body.includes(Buffer.from('/fixture-agent'))
      ) {
        fail(400, 'C3.5 fixture rejected provider request semantics')
        return
      }

      const chunkBase = {
        id: 'c3.5-fixture-agent-turn',
        object: 'chat.completion.chunk',
        created: 0,
        model: REAL_PI_FIXTURE_MODEL_ID
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'close'
      })
      response.write(
        `data: ${JSON.stringify({
          ...chunkBase,
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                content: C3_5_FIXTURE_AGENT_RESPONSE_TEXT
              },
              finish_reason: null
            }
          ]
        })}\n\n`
      )
      if (options.c3_5Schedule === 'provider-final') {
        if (!c3_5ProviderFinalReleasePath) throw new Error('C3.5 provider-final release path is unavailable')
        await waitForC3_5Release(c3_5ProviderFinalReleasePath)
      }
      response.write(
        `data: ${JSON.stringify({
          ...chunkBase,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: 'stop'
            }
          ],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 7,
            total_tokens: 8
          }
        })}\n\n`
      )
      response.end('data: [DONE]\n\n')
    }
    const finish = (): void => {
      if (!settle('end')) return
      if (c3_5AgentRun) {
        void sendC3_5Response().catch(error => {
          response.destroy(error instanceof Error ? error : new Error(String(error)))
        })
        return
      }
      const lfJsonlResponseText = lfJsonlResponse
        ? observation.body?.includes(Buffer.from(C1_4_LF_JSONL_LIVENESS_USER_TEXT))
          ? C1_4_LF_JSONL_LIVENESS_RESPONSE_TEXT
          : observation.body?.includes(Buffer.from(C1_4_LF_JSONL_USER_TEXT))
            ? C1_4_LF_JSONL_RESPONSE_TEXT
            : undefined
        : undefined
      const responseText = runtimeExtensionError
        ? C1_2_RUNTIME_EXTENSION_RESPONSE_TEXT
        : childTermination
          ? C1_3_RECOVERY_RESPONSE_TEXT
          : lfJsonlResponseText
      if (responseText && !bodyExceededLimit) {
        const chunkBase = {
          id: runtimeExtensionError
            ? 'c1.2-runtime-extension-turn'
            : childTermination
              ? 'c1.3-recovery-turn'
              : 'c1.4-lf-jsonl-turn',
          object: 'chat.completion.chunk',
          created: 0,
          model: REAL_PI_FIXTURE_MODEL_ID
        }
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'close'
        })
        response.write(
          `data: ${JSON.stringify({
            ...chunkBase,
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  content: responseText
                },
                finish_reason: null
              }
            ]
          })}\n\n`
        )
        response.write(
          `data: ${JSON.stringify({
            ...chunkBase,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: 'stop'
              }
            ],
            usage: {
              prompt_tokens: 1,
              completion_tokens: 4,
              total_tokens: 5
            }
          })}\n\n`
        )
        response.end('data: [DONE]\n\n')
        return
      }
      response.statusCode = bodyExceededLimit ? 413 : 503
      response.end('C0.7 fixture refuses model requests\n')
    }
    request.setTimeout(LOOPBACK_BODY_TIMEOUT_MS, () => {
      if (!settle('timeout')) return
      response.statusCode = 408
      response.end('C0.7 fixture request body timed out\n')
      request.destroy()
    })
    request.on('data', chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bodyByteLength += bytes.length
      if (bodyByteLength <= MAX_LOOPBACK_BODY_BYTES) chunks.push(bytes)
      else bodyExceededLimit = true
    })
    request.once('end', finish)
    request.once('aborted', () => {
      settle('aborted')
    })
    request.once('error', () => {
      settle('error')
    })
    request.once('close', () => {
      if (!request.complete) settle('aborted')
    })
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  const closeLoopbackServer = createServerCloser(server, sockets)

  let client: AcpProcessClient | undefined
  let cleanupPromise: Promise<void> | undefined
  let hardDeadlineTimer: NodeJS.Timeout | undefined
  let hardDeadlineExceeded = false
  const hardDeadlineAt = hardDeadlineMs === undefined ? undefined : Date.now() + hardDeadlineMs
  let resolveHardDeadline!: (error: RealPiFixtureDeadlineError) => void
  const hardDeadline = new Promise<RealPiFixtureDeadlineError>(resolve => {
    resolveHardDeadline = resolve
  })
  const cleanup = async (): Promise<void> => {
    if (hardDeadlineTimer) {
      clearTimeout(hardDeadlineTimer)
      hardDeadlineTimer = undefined
    }
    cleanupPromise ??= (async () => {
      const errors: unknown[] = []
      try {
        await Promise.all([writeC3_5Release(c3_5PreflightReleasePath), writeC3_5Release(c3_5ProviderFinalReleasePath)])
      } catch (error) {
        errors.push(error)
      }
      try {
        await client?.close()
      } catch (error) {
        errors.push(error)
      }
      try {
        await closeLoopbackServer()
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
  const triggerHardDeadline = async (): Promise<RealPiFixtureDeadlineError> => {
    if (hardDeadlineMs === undefined) {
      throw new Error('real Pi fixture has no configured hard deadline')
    }
    if (!hardDeadlineExceeded) {
      hardDeadlineExceeded = true
      void cleanup().then(
        () => resolveHardDeadline(new RealPiFixtureDeadlineError(hardDeadlineMs)),
        error =>
          resolveHardDeadline(
            new RealPiFixtureDeadlineError(hardDeadlineMs, {
              cause: error
            })
          )
      )
    }
    return await hardDeadline
  }
  if (hardDeadlineMs !== undefined) {
    hardDeadlineTimer = setTimeout(() => {
      void triggerHardDeadline()
    }, hardDeadlineMs)
    hardDeadlineTimer.unref()
  }
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
    const failingExtensionDir = join(agentDir, 'extensions', 'pi-acp-failing-load')
    const runtimeErrorExtensionDir = join(agentDir, 'extensions', 'pi-acp-runtime-error')
    const childTerminationExtensionDir = join(agentDir, 'extensions', 'pi-acp-child-termination')
    const projectExtensionDir = join(cwd, '.pi', 'extensions')
    const projectPromptDir = join(cwd, '.pi', 'prompts')
    const extensionPath = join(extensionDir, 'index.ts')
    const failingExtensionPath = join(failingExtensionDir, 'index.ts')
    const runtimeErrorExtensionPath = join(runtimeErrorExtensionDir, 'index.ts')
    const childTerminationExtensionPath = join(childTerminationExtensionDir, 'index.ts')
    const projectExtensionPath = join(projectExtensionDir, 'project-canary.js')
    const registrationReceiptPath = join(receiptDir, `pi-acp-c0.6-registration-${nonce}.json`)
    const shutdownReceiptPath = join(receiptDir, `pi-acp-c0.6-shutdown-${nonce}.json`)
    const projectCanaryPath = join(rootDir, 'project-extension-loaded')
    const trustPath = join(agentDir, 'trust.json')
    const authPath = join(agentDir, 'auth.json')
    const sessionMapPath = join(homeDir, '.pi', 'pi-acp', 'session-map.json')
    const piCommand = join(rootDir, process.platform === 'win32' ? 'pi-fixture.cmd' : 'pi-fixture')
    const baseUrl = `http://127.0.0.1:${String(address.port)}/v1`
    const selectedExtensionSourcePath = c3_4ExecuteCommand
      ? c3_4ExecuteCommandExtensionSourcePath
      : c3_5AgentRun
        ? c3_5AgentRunExtensionSourcePath
        : globalExtensionSourcePath
    c3_5PreflightReleasePath = c3_5AgentRun ? join(receiptDir, `pi-acp-c3.5-preflight-release-${nonce}`) : undefined
    c3_5ProviderFinalReleasePath = c3_5AgentRun
      ? join(receiptDir, `pi-acp-c3.5-provider-final-release-${nonce}`)
      : undefined

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
        ...(extensionLoadFailure ? [failingExtensionDir] : []),
        ...(runtimeExtensionError ? [runtimeErrorExtensionDir] : []),
        ...(childTermination ? [childTerminationExtensionDir] : []),
        projectExtensionDir,
        ...(projectPrompts.length > 0 ? [projectPromptDir] : [])
      ].map(path => mkdir(path, { recursive: true }))
    )

    const repositoryRealpath = await realpath(repositoryRoot)
    const nodeModulesRoot = await realpath(join(repositoryRoot, 'node_modules'))
    const selectedPiPackageRootPath = patchedPreview ? options.patchedPiPackageRoot! : piPackageRootPath
    const piPackageRoot = await realpath(selectedPiPackageRootPath)
    const expectedCliRealpath = await realpath(join(piPackageRoot, 'dist', 'cli.js'))
    const expectedNodeRealpath = await realpath(process.execPath)
    assertContainedPath(repositoryRealpath, nodeModulesRoot, 'C0.6 node_modules')
    if (!patchedPreview) assertContainedPath(nodeModulesRoot, piPackageRoot, 'C0.6 Pi package')
    assertContainedPath(piPackageRoot, expectedCliRealpath, 'C0.6 Pi CLI')
    await access(expectedNodeRealpath, constants.X_OK)
    await access(expectedCliRealpath, constants.X_OK)
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
      copyFile(selectedExtensionSourcePath, extensionPath),
      ...(extensionLoadFailure ? [copyFile(failingGlobalExtensionSourcePath, failingExtensionPath)] : []),
      ...(runtimeExtensionError ? [copyFile(runtimeErrorExtensionSourcePath, runtimeErrorExtensionPath)] : []),
      ...(childTermination ? [copyFile(childTerminationExtensionSourcePath, childTerminationExtensionPath)] : []),
      copyFile(projectCanarySourcePath, projectExtensionPath),
      writeFile(piCommand, piWrapperSource(expectedNodeRealpath, expectedCliRealpath), {
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
      }),
      ...projectPrompts.map(prompt =>
        writeFile(join(projectPromptDir, `${prompt.name}.md`), prompt.contents, {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600
        })
      )
    ])

    const extensionSource = await readFile(selectedExtensionSourcePath)
    const expectedExtensionSha256 = createHash('sha256').update(extensionSource).digest('hex')
    const failingExtensionSource = extensionLoadFailure ? await readFile(failingGlobalExtensionSourcePath) : undefined
    const expectedFailingExtensionSha256 = failingExtensionSource
      ? createHash('sha256').update(failingExtensionSource).digest('hex')
      : undefined
    const runtimeErrorExtensionSource = runtimeExtensionError
      ? await readFile(runtimeErrorExtensionSourcePath)
      : undefined
    const expectedRuntimeErrorExtensionSha256 = runtimeErrorExtensionSource
      ? createHash('sha256').update(runtimeErrorExtensionSource).digest('hex')
      : undefined
    const childTerminationExtensionSource = childTermination
      ? await readFile(childTerminationExtensionSourcePath)
      : undefined
    const expectedChildTerminationExtensionSha256 = childTerminationExtensionSource
      ? createHash('sha256').update(childTerminationExtensionSource).digest('hex')
      : undefined
    const projectCanarySource = await readFile(projectCanarySourcePath)
    const expectedProjectCanarySha256 = createHash('sha256').update(projectCanarySource).digest('hex')
    const expectedExtensionRealpath = await realpath(extensionPath)
    const expectedRuntimeErrorExtensionRealpath = runtimeExtensionError
      ? await realpath(runtimeErrorExtensionPath)
      : undefined
    const expectedChildTerminationExtensionRealpath = childTermination
      ? await realpath(childTerminationExtensionPath)
      : undefined
    const receiptBoundary: ReceiptBoundary = {
      rootDir: await realpath(rootDir),
      receiptDir: await realpath(receiptDir),
      rootStat: await lstat(rootDir),
      receiptDirStat: await lstat(receiptDir)
    }
    assertReceiptDirectoryStat(receiptBoundary.rootDir, receiptBoundary.rootStat)
    assertReceiptDirectoryStat(receiptBoundary.receiptDir, receiptBoundary.receiptDirStat)
    assertContainedPath(receiptBoundary.rootDir, receiptBoundary.receiptDir, 'C0.6 receipt directory')
    const fixtureId = c3_4ExecuteCommand
      ? 'pi-extension-pack-c3.4-execute-command'
      : c3_5AgentRun
        ? 'pi-extension-pack-c3.5-agent-run'
        : 'pi-extension-pack-v1'

    const environment = isolatedEnvironment({
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
      piCommand,
      piNode: expectedNodeRealpath,
      fixtureStatePreview: c3_4ExecuteCommand,
      fixtureAgentPreview: c3_5AgentRun,
      c3_5Schedule: options.c3_5Schedule
    })
    client = new AcpProcessClient({
      command: process.execPath,
      args: ['--import', tsxImportPath, agentEntryPath],
      cwd,
      env: environment,
      requestTimeoutMs: 20_000,
      updateTimeoutMs: 10_000,
      shutdownTimeoutMs: clientShutdownTimeoutMs,
      stderrLimitBytes: 16 * 1024,
      clientBehavior: options.clientBehavior ?? 'raw',
      transcriptMetadata: {
        ...(options.transcriptMetadata ?? {}),
        planId: 'PACP-CMD-2026-01',
        checkpoint: options.transcriptCheckpoint ?? (c3_4ExecuteCommand ? 'C3.4' : c3_5AgentRun ? 'C3.5' : 'C0.6'),
        fixtureId,
        fixtureSources: [
          {
            path: c3_4ExecuteCommand
              ? 'test/fixtures/pi-extension-pack/c3.4-execute-command/index.ts'
              : c3_5AgentRun
                ? 'test/fixtures/pi-extension-pack/c3.5-agent-run/index.ts'
                : 'test/fixtures/pi-extension-pack/index.ts',
            sha256: expectedExtensionSha256
          },
          ...(expectedFailingExtensionSha256
            ? [
                {
                  path: 'test/fixtures/pi-extension-pack/failing-load/index.ts',
                  sha256: expectedFailingExtensionSha256
                }
              ]
            : []),
          ...(expectedRuntimeErrorExtensionSha256
            ? [
                {
                  path: 'test/fixtures/pi-extension-pack/runtime-error/index.ts',
                  sha256: expectedRuntimeErrorExtensionSha256
                }
              ]
            : []),
          ...(expectedChildTerminationExtensionSha256
            ? [
                {
                  path: 'test/fixtures/pi-extension-pack/child-termination/index.ts',
                  sha256: expectedChildTerminationExtensionSha256
                }
              ]
            : []),
          {
            path: 'test/fixtures/pi-extension-pack/project-canary.js',
            sha256: expectedProjectCanarySha256
          }
        ],
        piAcpVersion: '0.0.33',
        piVersion: REAL_PI_VERSION,
        client: options.clientBehavior === 'strict' ? 'strict-catalog-client' : 'raw-process-client',
        platform: process.platform,
        arch: process.arch,
        ...(options.transcriptCaseId ? { caseId: options.transcriptCaseId } : {})
      }
    })

    if (hardDeadlineExceeded || (hardDeadlineAt !== undefined && Date.now() >= hardDeadlineAt)) {
      throw await triggerHardDeadline()
    }
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
      piCommandPath: piCommand,
      nonce,
      expectedCliRealpath,
      expectedNodeRealpath,
      expectedExtensionRealpath,
      expectedExtensionSha256,
      ...(runtimeExtensionError
        ? {
            expectedRuntimeErrorExtensionRealpath,
            expectedRuntimeErrorExtensionSha256
          }
        : {}),
      ...(childTermination
        ? {
            expectedChildTerminationExtensionRealpath,
            expectedChildTerminationExtensionSha256
          }
        : {}),
      expectedProjectCanarySha256,
      piPackageRoot,
      packageVersion: REAL_PI_VERSION,
      projectPromptPaths: Object.fromEntries(
        projectPrompts.map(prompt => [prompt.name, join(projectPromptDir, `${prompt.name}.md`)])
      ),
      loopbackAddress: {
        host: '127.0.0.1' as const,
        port: address.port
      },
      requests,
      c3_5Schedule: options.c3_5Schedule,
      async releaseC3_5Preflight(): Promise<void> {
        if (!c3_5AgentRun || !c3_5PreflightReleasePath) {
          throw new Error('C3.5 preflight release is available only in the C3.5 agent-run fixture')
        }
        await writeC3_5Release(c3_5PreflightReleasePath)
      },
      async releaseC3_5ProviderFinal(): Promise<void> {
        if (!c3_5AgentRun || !c3_5ProviderFinalReleasePath) {
          throw new Error('C3.5 provider-final release is available only in the C3.5 agent-run fixture')
        }
        await writeC3_5Release(c3_5ProviderFinalReleasePath)
      },
      async readC3_5Receipts(phase: RealPiC3_5Receipt['phase']): Promise<VerifiedReceipt<RealPiC3_5Receipt>[]> {
        const prefix = `pi-acp-c3.5-${phase}-${nonce}-`
        const names = (await readdir(receiptDir)).filter(name => name.startsWith(prefix) && name.endsWith('.json'))
        names.sort()
        return await Promise.all(
          names.map(name => readVerifiedReceipt<RealPiC3_5Receipt>(join(receiptDir, name), receiptBoundary))
        )
      },
      createRawPiProbeEnvironment(): NodeJS.ProcessEnv {
        const probeNonce = randomBytes(16).toString('hex')
        return Object.assign(Object.create(null) as NodeJS.ProcessEnv, environment, {
          PI_ACP_FIXTURE_NONCE: probeNonce,
          PI_ACP_FIXTURE_API_KEY: `pi-acp-fixture-${probeNonce}`
        })
      },
      hardDeadline,
      get hardDeadlineExceeded(): boolean {
        return hardDeadlineExceeded
      },
      async assertWithinHardDeadline(): Promise<void> {
        if (hardDeadlineAt !== undefined && (hardDeadlineExceeded || Date.now() >= hardDeadlineAt)) {
          throw await triggerHardDeadline()
        }
      },
      async readC1_3SessionStartReceipts(): Promise<VerifiedReceipt<RealPiC1_3SessionStartReceipt>[]> {
        const prefix = `pi-acp-c1.3-session-start-${nonce}-`
        const names = (await readdir(receiptDir)).filter(name => name.startsWith(prefix) && name.endsWith('.json'))
        names.sort()
        return await Promise.all(
          names.map(name => readVerifiedReceipt<RealPiC1_3SessionStartReceipt>(join(receiptDir, name), receiptBoundary))
        )
      },
      async readC3_4SessionStartReceipts(): Promise<VerifiedReceipt<RealPiC3_4SessionStartReceipt>[]> {
        const prefix = `pi-acp-c3.4-session-start-${nonce}-`
        const names = (await readdir(receiptDir)).filter(name => name.startsWith(prefix) && name.endsWith('.json'))
        names.sort()
        return await Promise.all(
          names.map(name => readVerifiedReceipt<RealPiC3_4SessionStartReceipt>(join(receiptDir, name), receiptBoundary))
        )
      },
      async readC3_4InvocationReceipts(): Promise<VerifiedReceipt<RealPiC3_4InvocationReceipt>[]> {
        const prefix = `pi-acp-c3.4-invocation-${nonce}-`
        const names = (await readdir(receiptDir)).filter(name => name.startsWith(prefix) && name.endsWith('.json'))
        names.sort()
        return await Promise.all(
          names.map(name => readVerifiedReceipt<RealPiC3_4InvocationReceipt>(join(receiptDir, name), receiptBoundary))
        )
      },
      async readC3_4ShutdownReceipts(): Promise<VerifiedReceipt<RealPiC3_4ShutdownReceipt>[]> {
        const prefix = `pi-acp-c3.4-shutdown-${nonce}-`
        const names = (await readdir(receiptDir)).filter(name => name.startsWith(prefix) && name.endsWith('.json'))
        names.sort()
        return await Promise.all(
          names.map(name => readVerifiedReceipt<RealPiC3_4ShutdownReceipt>(join(receiptDir, name), receiptBoundary))
        )
      },
      async readRegistrationReceipt(): Promise<VerifiedReceipt<RealPiFixtureReceipt>> {
        return await readVerifiedReceipt<RealPiFixtureReceipt>(registrationReceiptPath, receiptBoundary)
      },
      async readShutdownReceipt(): Promise<VerifiedReceipt<RealPiShutdownReceipt>> {
        return await readVerifiedReceipt<RealPiShutdownReceipt>(shutdownReceiptPath, receiptBoundary)
      },
      async closeLoopback(): Promise<void> {
        await closeLoopbackServer()
      },
      async cleanup(): Promise<void> {
        await cleanup()
      }
    }
  } catch (error) {
    let cleanupError: unknown
    try {
      await cleanup()
    } catch (caughtCleanupError) {
      cleanupError = caughtCleanupError
    }
    if (hardDeadlineExceeded || (hardDeadlineAt !== undefined && Date.now() >= hardDeadlineAt)) {
      throw await triggerHardDeadline()
    }
    if (cleanupError !== undefined) {
      throw new AggregateError([error, cleanupError], 'C0.6 real Pi fixture setup and cleanup failed')
    }
    throw error
  }
}
