import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual, promisify } from 'node:util'
import {
  C0_7_TRANSCRIPT_ROOT,
  isCanonicalUtcDate,
  publishTranscriptUpdate,
  readVerifiedManifest,
  sha256,
  type ImmutableTranscriptCase,
  type ImmutableTranscriptManifest
} from '../test/helpers/immutable-transcript.js'
import {
  C0_7_ACP_SDK_GIT_HEAD,
  C0_7_ACP_SDK_INSTALLED_TREE_SHA256,
  C0_7_ACP_SDK_LOCK_INTEGRITY,
  C0_7_CLIENT_REPOSITORY,
  C0_7_PI_GIT_HEAD,
  C0_7_PI_INSTALLED_TREE_SHA256,
  C0_7_PI_LOCK_INTEGRITY,
  baselineClientSources,
  runRealPiBaselineCase,
  type BaselineCaseId,
  type ObservedBaseline
} from '../test/helpers/real-pi-baseline-scenarios.js'

const ALL_CASE_IDS: readonly BaselineCaseId[] = ['C0.7-XF01', 'C0.7-XF02', 'C0.7-XF03']
const execFileAsync = promisify(execFile)
const fixtureSourcePath = fileURLToPath(new URL('../test/fixtures/pi-extension-pack/index.ts', import.meta.url))
const projectCanarySourcePath = fileURLToPath(
  new URL('../test/fixtures/pi-extension-pack/project-canary.js', import.meta.url)
)
const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url))
const packageLockPath = fileURLToPath(new URL('../package-lock.json', import.meta.url))
const installedPiPackageJsonPath = fileURLToPath(
  new URL('../node_modules/@earendil-works/pi-coding-agent/package.json', import.meta.url)
)
const installedSdkPackageJsonPath = fileURLToPath(
  new URL('../node_modules/@agentclientprotocol/sdk/package.json', import.meta.url)
)
const installedPiPackageRoot = fileURLToPath(
  new URL('../node_modules/@earendil-works/pi-coding-agent/', import.meta.url)
)
const installedSdkPackageRoot = fileURLToPath(new URL('../node_modules/@agentclientprotocol/sdk/', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const MAX_INSTALLED_PACKAGE_FILES = 10_000
const MAX_INSTALLED_PACKAGE_BYTES = 256 * 1024 * 1024
const RUNTIME_SOURCE_PATHS = [
  'src',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'scripts/check-command-transcripts.ts',
  'scripts/update-command-transcripts.ts',
  'test/fixtures/pi-extension-pack',
  'test/helpers'
] as const

type CliOptions = {
  cases: BaselineCaseId[]
  expectedOldManifestSha256: string | 'absent'
  recheckDate: string
}

type RuntimeSourceGitOptions = {
  cwd?: string
  paths?: readonly string[]
}

type GitRepository = {
  gitDir: string
  workTree: string
}

type GitTreeEntry = {
  mode: string
  objectId: string
  path: string
  type: 'blob' | 'commit'
}

type WorktreeEntry = {
  bytes: Buffer
  mode: string
  type: 'blob'
}

const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024
const MAX_RUNTIME_SOURCE_BYTES = 64 * 1024 * 1024
const MAX_RUNTIME_SOURCE_ENTRIES = 10_000
const RUNTIME_SOURCE_GIT_OBJECT_FORMAT = 'sha1'
const RUNTIME_SOURCE_MISMATCH = 'C0.7 runtime-bearing sources do not match the declared Git head'

export async function installedPackageTreeSha256(root: string): Promise<string> {
  const rootStat = await lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('C0.7 installed package root must be a real directory')
  }
  const canonicalRoot = await realpath(root)
  const hash = createHash('sha256')
  let fileCount = 0
  let byteLength = 0

  const visit = async (directory: string, relativePrefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))
    for (const entry of entries) {
      if (relativePrefix === '' && entry.name === 'node_modules') continue
      const path = join(directory, entry.name)
      const relativePath = relativePrefix === '' ? entry.name : `${relativePrefix}/${entry.name}`
      const stat = await lstat(path)
      if (stat.isSymbolicLink()) {
        throw new Error(`C0.7 installed package tree contains a symlink: ${relativePath}`)
      }
      if (stat.isDirectory()) {
        await visit(path, relativePath)
        continue
      }
      if (!stat.isFile() || stat.nlink !== 1) {
        throw new Error(`C0.7 installed package tree contains an unsupported entry: ${relativePath}`)
      }
      const bytes = await readFile(path)
      const finalStat = await lstat(path)
      if (
        finalStat.dev !== stat.dev ||
        finalStat.ino !== stat.ino ||
        finalStat.size !== stat.size ||
        finalStat.mtimeMs !== stat.mtimeMs ||
        bytes.length !== stat.size
      ) {
        throw new Error(`C0.7 installed package file changed while hashing: ${relativePath}`)
      }
      fileCount += 1
      byteLength += bytes.length
      if (fileCount > MAX_INSTALLED_PACKAGE_FILES || byteLength > MAX_INSTALLED_PACKAGE_BYTES) {
        throw new Error('C0.7 installed package tree exceeds its hashing bounds')
      }
      const executable = (stat.mode & 0o111) === 0 ? '0' : '1'
      hash.update(`file\u0000${relativePath}\u0000${executable}\u0000${String(bytes.length)}\u0000`)
      hash.update(bytes)
      hash.update('\u0000')
    }
  }

  await visit(canonicalRoot, '')
  if (fileCount === 0) throw new Error('C0.7 installed package tree is empty')
  return hash.digest('hex')
}

function requireValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

export function parseTranscriptUpdateArgs(
  args: readonly string[],
  recordingDate = new Date().toISOString().slice(0, 10)
): CliOptions {
  if (!isCanonicalUtcDate(recordingDate)) throw new TypeError('recording date must be a canonical UTC date')
  const cases: BaselineCaseId[] = []
  let expectedOldManifestSha256: string | 'absent' | undefined
  let recheckDate: string | undefined
  let accepted = false

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    switch (flag) {
      case '--case': {
        const value = requireValue(args, index, flag)
        index += 1
        if (!ALL_CASE_IDS.includes(value as BaselineCaseId)) {
          throw new Error(`unknown C0.7 case: ${value}`)
        }
        if (cases.includes(value as BaselineCaseId)) {
          throw new Error(`duplicate --case value: ${value}`)
        }
        cases.push(value as BaselineCaseId)
        break
      }
      case '--expected-old-manifest-sha': {
        if (expectedOldManifestSha256 !== undefined) {
          throw new Error('duplicate --expected-old-manifest-sha')
        }
        expectedOldManifestSha256 = requireValue(args, index, flag)
        index += 1
        break
      }
      case '--recheck-date': {
        if (recheckDate !== undefined) throw new Error('duplicate --recheck-date')
        recheckDate = requireValue(args, index, flag)
        index += 1
        if (!isCanonicalUtcDate(recheckDate)) {
          throw new Error('invalid --recheck-date')
        }
        break
      }
      case '--accept-baseline-change':
        if (accepted) throw new Error('duplicate --accept-baseline-change')
        accepted = true
        break
      default:
        throw new Error(`unknown transcript updater argument: ${flag}`)
    }
  }

  if (
    cases.length !== ALL_CASE_IDS.length ||
    [...cases].sort().some((caseId, index) => caseId !== ALL_CASE_IDS[index])
  ) {
    throw new Error('C0.7 publication requires all three explicit --case values')
  }
  if (expectedOldManifestSha256 === undefined) {
    throw new Error('--expected-old-manifest-sha is required')
  }
  if (expectedOldManifestSha256 !== 'absent' && !/^[0-9a-f]{64}$/u.test(expectedOldManifestSha256)) {
    throw new Error('--expected-old-manifest-sha must be 64 lowercase hex or absent')
  }
  if (recheckDate === undefined) throw new Error('--recheck-date is required')
  if (recheckDate < recordingDate) {
    throw new Error('--recheck-date must not precede the recording date')
  }
  if (!accepted) throw new Error('--accept-baseline-change is required')

  return {
    cases: [...cases].sort(),
    expectedOldManifestSha256,
    recheckDate
  }
}

async function captureTwice(caseId: BaselineCaseId, baselineGitHead: string): Promise<ObservedBaseline> {
  const first = await runRealPiBaselineCase(caseId, { baselineGitHead })
  const second = await runRealPiBaselineCase(caseId, { baselineGitHead })
  if (
    !first.canonicalTranscript.bytes.equals(second.canonicalTranscript.bytes) ||
    !isDeepStrictEqual(first.expectedFailure, second.expectedFailure) ||
    !isDeepStrictEqual(first.networkBoundary, second.networkBoundary) ||
    !isDeepStrictEqual(first.runtime, second.runtime)
  ) {
    throw new Error(`${caseId} produced nondeterministic fresh captures`)
  }
  return first
}

function caseMetadata(
  observed: ObservedBaseline
): Omit<ImmutableTranscriptCase, 'clientBehavior' | 'runtime' | 'expectedFailure' | 'networkBoundary' | 'artifact'> {
  switch (observed.id) {
    case 'C0.7-XF01':
      return {
        id: observed.id,
        title: 'Real Pi extension command is absent from the ACP catalog',
        status: 'xfail',
        upstreamLedgerId: 'X-01',
        trackingUrl: 'https://github.com/svkozak/pi-acp/pull/20',
        ownerCheckpoints: ['C2.3'],
        recheckTrigger: 'Recheck when extension commands are exposed with source/compatibility metadata.'
      }
    case 'C0.7-XF02':
      return {
        id: observed.id,
        title: 'Untrusted project prompt is expanded and submitted to the model',
        status: 'xfail',
        upstreamLedgerId: null,
        trackingUrl: 'https://github.com/Eric-Song-Nop/pi-acp/issues/6',
        ownerCheckpoints: ['C1.6', 'C2.2', 'C5.8'],
        recheckTrigger: 'Recheck when adapter-side project prompt loading honors authoritative Pi trust.'
      }
    case 'C0.7-XF03':
      return {
        id: observed.id,
        title: 'State-only output arrives while ACP prompt remains pending through 1500ms',
        status: 'xfail',
        upstreamLedgerId: 'X-03',
        trackingUrl: 'https://github.com/svkozak/pi-acp/issues/84',
        ownerCheckpoints: ['C3.4'],
        recheckTrigger: 'Recheck when Pi RPC/adapter command completion distinguishes no-agent-run commands.'
      }
  }
}

function isolatedGitEnvironment(repository: GitRepository): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^GIT_/iu.test(key) && value !== undefined) environment[key] = value
  }
  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null'
  return {
    ...environment,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: repository.workTree,
    GIT_CONFIG_COUNT: '0',
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: nullDevice,
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0'
  }
}

function gitArguments(repository: GitRepository, args: readonly string[]): string[] {
  return [
    '--no-pager',
    '--no-replace-objects',
    '--literal-pathspecs',
    `--git-dir=${repository.gitDir}`,
    `--work-tree=${repository.workTree}`,
    '-c',
    'core.fsmonitor=false',
    '-c',
    `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
    '-c',
    'core.untrackedCache=false',
    '-c',
    'core.useReplaceRefs=false',
    ...args
  ]
}

async function gitOutput(repository: GitRepository, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', gitArguments(repository, args), {
    cwd: repository.workTree,
    encoding: 'utf8',
    env: isolatedGitEnvironment(repository),
    maxBuffer: MAX_GIT_OUTPUT_BYTES
  })
  return stdout.trim()
}

async function gitBytes(repository: GitRepository, args: readonly string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync('git', gitArguments(repository, args), {
    cwd: repository.workTree,
    encoding: 'buffer',
    env: isolatedGitEnvironment(repository),
    maxBuffer: MAX_GIT_OUTPUT_BYTES
  })
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout)
}

async function readGitDirectory(
  dotGitPath: string,
  workTree: string,
  stat: Awaited<ReturnType<typeof lstat>>
): Promise<string> {
  if (stat.isSymbolicLink()) throw new Error('C0.7 repository .git entry must not be a symlink')
  if (stat.isDirectory()) {
    const gitDir = await realpath(dotGitPath)
    if (!sameFilesystemEntry(stat, await lstat(dotGitPath))) {
      throw new Error('C0.7 repository .git directory changed during discovery')
    }
    return gitDir
  }
  if (!stat.isFile()) throw new Error('C0.7 repository .git entry has an unsupported type')
  const pointer = await readFile(dotGitPath, 'utf8')
  if (!sameFilesystemEntry(stat, await lstat(dotGitPath))) {
    throw new Error('C0.7 repository .git file changed during discovery')
  }
  const match = /^gitdir: ([^\r\n]+)\r?\n?$/u.exec(pointer)
  if (!match) throw new Error('C0.7 repository .git file is malformed')
  const gitDir = await realpath(resolve(workTree, match[1]))
  if (!(await lstat(gitDir)).isDirectory()) throw new Error('C0.7 repository Git directory is not a directory')
  return gitDir
}

async function discoverGitRepository(cwd: string): Promise<GitRepository> {
  const canonicalCwd = await realpath(cwd)
  if (!(await lstat(canonicalCwd)).isDirectory()) throw new Error('C0.7 repository cwd is not a directory')
  let candidate = canonicalCwd
  while (true) {
    const dotGitPath = join(candidate, '.git')
    let stat: Awaited<ReturnType<typeof lstat>>
    try {
      stat = await lstat(dotGitPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(candidate)
      if (parent === candidate) throw new Error('C0.7 repository cwd is not inside a Git worktree')
      candidate = parent
      continue
    }
    return {
      gitDir: await readGitDirectory(dotGitPath, candidate, stat),
      workTree: candidate
    }
  }
}

function normalizeRuntimeSourcePaths(paths: readonly string[]): string[] {
  if (paths.length === 0) throw new TypeError('C0.7 runtime source paths must not be empty')
  const normalized = new Set<string>()
  for (const path of paths) {
    const components = path.split('/')
    if (
      path === '' ||
      path.includes('\0') ||
      path.includes('\\') ||
      path.startsWith('/') ||
      components.some(component => component === '' || component === '.' || component === '..') ||
      components[0] === '.git'
    ) {
      throw new TypeError('C0.7 runtime source paths must be canonical repository-relative paths')
    }
    normalized.add(path)
  }
  const sorted = [...normalized].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  return sorted.filter((path, index) => !sorted.slice(0, index).some(parent => path.startsWith(`${parent}/`)))
}

function selectedRuntimePath(path: string, paths: readonly string[]): boolean {
  return paths.some(selected => selected === '' || path === selected || path.startsWith(`${selected}/`))
}

function parseGitTreeEntries(output: Buffer, paths: readonly string[]): Map<string, GitTreeEntry> {
  const result = new Map<string, GitTreeEntry>()
  for (const record of output.toString('utf8').split('\0')) {
    if (record === '') continue
    const match = /^([0-7]{6}) (blob|commit) ([0-9a-f]{40,64})\t(.+)$/su.exec(record)
    if (!match) throw new Error('C0.7 Git tree output is malformed')
    const [, mode, type, objectId, path] = match
    if (!selectedRuntimePath(path, paths)) continue
    if (result.has(path)) throw new Error('C0.7 Git tree contains a duplicate runtime path')
    result.set(path, {
      mode,
      objectId,
      path,
      type: type as GitTreeEntry['type']
    })
  }
  return result
}

async function verifyCommit(repository: GitRepository, gitHead: string): Promise<void> {
  const objectFormat = await gitOutput(repository, ['rev-parse', '--show-object-format=storage'])
  if (objectFormat !== RUNTIME_SOURCE_GIT_OBJECT_FORMAT) {
    throw new Error('C0.7 runtime-source provenance requires a SHA-1 Git repository')
  }
  const verified = await gitOutput(repository, ['rev-parse', '--verify', '--end-of-options', `${gitHead}^{commit}`])
  if (verified !== gitHead) throw new Error('C0.7 repository Git head did not resolve exactly')
}

async function readGitTreeEntries(
  repository: GitRepository,
  gitHead: string,
  paths: readonly string[]
): Promise<Map<string, GitTreeEntry>> {
  await verifyCommit(repository, gitHead)
  const entries = parseGitTreeEntries(
    await gitBytes(repository, ['ls-tree', '-r', '-z', '--full-tree', `${gitHead}^{tree}`]),
    paths
  )
  return entries
}

function parseIndexEntries(output: Buffer, paths: readonly string[]): Map<string, GitTreeEntry> {
  const result = new Map<string, GitTreeEntry>()
  for (const record of output.toString('utf8').split('\0')) {
    if (record === '') continue
    const match = /^([0-7]{6}) ([0-9a-f]{40,64}) ([0-3])\t(.+)$/su.exec(record)
    if (!match) throw new Error('C0.7 Git index output is malformed')
    const [, mode, objectId, stage, path] = match
    if (!selectedRuntimePath(path, paths)) continue
    if (stage !== '0' || result.has(path) || !['100644', '100755', '120000', '160000'].includes(mode)) {
      throw new Error(RUNTIME_SOURCE_MISMATCH)
    }
    result.set(path, {
      mode,
      objectId,
      path,
      type: mode === '160000' ? 'commit' : 'blob'
    })
  }
  return result
}

function gitTreeEntriesEqual(left: Map<string, GitTreeEntry>, right: Map<string, GitTreeEntry>): boolean {
  if (left.size !== right.size) return false
  for (const [path, leftEntry] of left) {
    const rightEntry = right.get(path)
    if (
      !rightEntry ||
      leftEntry.mode !== rightEntry.mode ||
      leftEntry.objectId !== rightEntry.objectId ||
      leftEntry.type !== rightEntry.type
    ) {
      return false
    }
  }
  return true
}

function gitBlobObjectId(bytes: Buffer): string {
  const header = Buffer.from(`blob ${String(bytes.length)}\0`)
  return createHash(RUNTIME_SOURCE_GIT_OBJECT_FORMAT).update(header).update(bytes).digest('hex')
}

async function assertIndexMatchesGitTree(
  repository: GitRepository,
  expected: Map<string, GitTreeEntry>,
  paths: readonly string[]
): Promise<void> {
  const indexEntries = parseIndexEntries(await gitBytes(repository, ['ls-files', '--stage', '-z']), paths)
  if (!gitTreeEntriesEqual(indexEntries, expected)) throw new Error(RUNTIME_SOURCE_MISMATCH)

  for (const flag of ['-v', '-f'] as const) {
    const flaggedPaths = new Set<string>()
    for (const record of (await gitBytes(repository, ['ls-files', flag, '-z'])).toString('utf8').split('\0')) {
      if (record === '') continue
      if (record.length < 3 || record[1] !== ' ') throw new Error('C0.7 Git index flags output is malformed')
      const path = record.slice(2)
      if (!selectedRuntimePath(path, paths)) continue
      if (record[0] !== 'H' || flaggedPaths.has(path)) throw new Error(RUNTIME_SOURCE_MISMATCH)
      flaggedPaths.add(path)
    }
    if (flaggedPaths.size !== expected.size) throw new Error(RUNTIME_SOURCE_MISMATCH)
  }
}

function sameFilesystemEntry(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

async function readStableBlob(path: string, initialStat: Awaited<ReturnType<typeof lstat>>): Promise<Buffer> {
  const bytes = await readFile(path)
  if (!sameFilesystemEntry(initialStat, await lstat(path))) throw new Error(RUNTIME_SOURCE_MISMATCH)
  return bytes
}

async function readRepositoryGitHead(repository: GitRepository): Promise<string> {
  const gitHead = await gitOutput(repository, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'])
  if (!/^[0-9a-f]{40}$/u.test(gitHead)) {
    throw new Error('C0.7 repository HEAD is not an exact Git commit')
  }
  return gitHead
}

async function assertNoRuntimeResolverShadows(
  repository: GitRepository,
  expected: Map<string, GitTreeEntry>
): Promise<void> {
  // Bare package imports search node_modules at every source ancestor before the
  // repository-root installed dependency graph. A nearer ignored directory can
  // otherwise execute while the selected source bytes still match Git exactly.
  const shadowPaths = new Set<string>()
  for (const path of expected.keys()) {
    const components = path.split('/')
    for (let length = 1; length < components.length; length += 1) {
      shadowPaths.add(join(repository.workTree, ...components.slice(0, length), 'node_modules'))
    }
  }

  for (const shadowPath of [...shadowPaths].sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right))
  )) {
    try {
      await lstat(shadowPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    throw new Error(RUNTIME_SOURCE_MISMATCH)
  }
}

async function collectWorktreeEntries(
  repository: GitRepository,
  expected: Map<string, GitTreeEntry>,
  paths: readonly string[]
): Promise<Map<string, WorktreeEntry>> {
  const workTreeStat = await lstat(repository.workTree)
  if (!workTreeStat.isDirectory() || workTreeStat.isSymbolicLink()) {
    throw new Error(RUNTIME_SOURCE_MISMATCH)
  }
  await assertNoRuntimeResolverShadows(repository, expected)
  const result = new Map<string, WorktreeEntry>()
  let byteLength = 0
  let entryCount = 0
  const visit = async (absolutePath: string, relativePath: string): Promise<void> => {
    let stat: Awaited<ReturnType<typeof lstat>>
    try {
      stat = await lstat(absolutePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    entryCount += 1
    if (entryCount > MAX_RUNTIME_SOURCE_ENTRIES) throw new Error(RUNTIME_SOURCE_MISMATCH)
    const expectedEntry = expected.get(relativePath)
    if (stat.isDirectory()) {
      if (expectedEntry) throw new Error(RUNTIME_SOURCE_MISMATCH)
      if (![...expected.keys()].some(path => path.startsWith(`${relativePath}/`))) {
        throw new Error(RUNTIME_SOURCE_MISMATCH)
      }
      const entries = await readdir(absolutePath, { withFileTypes: true })
      entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))
      for (const entry of entries) {
        if (relativePath === '' && entry.name === '.git') continue
        const childRelativePath = relativePath === '' ? entry.name : `${relativePath}/${entry.name}`
        await visit(join(absolutePath, entry.name), childRelativePath)
      }
      if (!sameFilesystemEntry(stat, await lstat(absolutePath))) throw new Error(RUNTIME_SOURCE_MISMATCH)
      return
    }
    if (!stat.isFile()) throw new Error(RUNTIME_SOURCE_MISMATCH)
    if (!expectedEntry || expectedEntry.type !== 'blob' || !['100644', '100755'].includes(expectedEntry.mode)) {
      throw new Error(RUNTIME_SOURCE_MISMATCH)
    }
    byteLength += stat.size
    if (stat.nlink !== 1 || byteLength > MAX_RUNTIME_SOURCE_BYTES) throw new Error(RUNTIME_SOURCE_MISMATCH)
    if (result.has(relativePath)) throw new Error(RUNTIME_SOURCE_MISMATCH)
    result.set(relativePath, {
      bytes: await readStableBlob(absolutePath, stat),
      mode: (stat.mode & 0o111) === 0 ? '100644' : '100755',
      type: 'blob'
    })
  }

  for (const path of paths) {
    const components = path.split('/')
    const ancestors: Array<{
      path: string
      stat: Awaited<ReturnType<typeof lstat>>
    }> = []
    let ancestorPath = repository.workTree
    for (const component of components.slice(0, -1)) {
      ancestorPath = join(ancestorPath, component)
      let ancestorStat: Awaited<ReturnType<typeof lstat>>
      try {
        ancestorStat = await lstat(ancestorPath)
      } catch {
        throw new Error(RUNTIME_SOURCE_MISMATCH)
      }
      if (!ancestorStat.isDirectory() || ancestorStat.isSymbolicLink()) {
        throw new Error(RUNTIME_SOURCE_MISMATCH)
      }
      ancestors.push({ path: ancestorPath, stat: ancestorStat })
    }

    await visit(join(repository.workTree, ...components), path)
    for (const ancestor of ancestors.reverse()) {
      if (!sameFilesystemEntry(ancestor.stat, await lstat(ancestor.path))) {
        throw new Error(RUNTIME_SOURCE_MISMATCH)
      }
    }
  }
  if (!sameFilesystemEntry(workTreeStat, await lstat(repository.workTree))) {
    throw new Error(RUNTIME_SOURCE_MISMATCH)
  }
  await assertNoRuntimeResolverShadows(repository, expected)
  return result
}

async function assertWorktreeMatchesGitTree(
  repository: GitRepository,
  expected: Map<string, GitTreeEntry>,
  paths: readonly string[]
): Promise<void> {
  const actual = await collectWorktreeEntries(repository, expected, paths)
  if (actual.size !== expected.size) throw new Error(RUNTIME_SOURCE_MISMATCH)
  for (const [path, expectedEntry] of expected) {
    const actualEntry = actual.get(path)
    if (!actualEntry || actualEntry.mode !== expectedEntry.mode || actualEntry.type !== expectedEntry.type) {
      throw new Error(RUNTIME_SOURCE_MISMATCH)
    }
    const expectedBytes = await gitBytes(repository, ['cat-file', 'blob', expectedEntry.objectId])
    if (gitBlobObjectId(expectedBytes) !== expectedEntry.objectId || !actualEntry.bytes.equals(expectedBytes)) {
      throw new Error(RUNTIME_SOURCE_MISMATCH)
    }
  }
}

async function assertRepositoryStateMatchesGitHead(
  repository: GitRepository,
  gitHead: string,
  paths: readonly string[]
): Promise<void> {
  const expected = await readGitTreeEntries(repository, gitHead, paths)
  for (const path of paths) {
    if (![...expected.keys()].some(entry => entry === path || entry.startsWith(`${path}/`))) {
      throw new Error(RUNTIME_SOURCE_MISMATCH)
    }
  }
  // Symlinks and gitlinks expand execution beyond the declared runtime-source allowlist.
  if ([...expected.values()].some(entry => entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode))) {
    throw new Error(RUNTIME_SOURCE_MISMATCH)
  }
  await assertIndexMatchesGitTree(repository, expected, paths)
  await assertWorktreeMatchesGitTree(repository, expected, paths)
}

export async function readCurrentRepositoryGitHead(cwd = repositoryRoot): Promise<string> {
  return readRepositoryGitHead(await discoverGitRepository(cwd))
}

export async function assertRuntimeSourcesMatchGitHead(
  gitHead: string,
  options: RuntimeSourceGitOptions = {}
): Promise<void> {
  if (!/^[0-9a-f]{40}$/u.test(gitHead)) throw new TypeError('C0.7 runtime source Git head must be 40 lowercase hex')
  const repository = await discoverGitRepository(options.cwd ?? repositoryRoot)
  const paths = normalizeRuntimeSourcePaths(options.paths ?? RUNTIME_SOURCE_PATHS)
  await assertRepositoryStateMatchesGitHead(repository, gitHead, paths)
}

export async function runtimeSourceTreesMatchGitHeads(
  leftGitHead: string,
  rightGitHead: string,
  options: RuntimeSourceGitOptions = {}
): Promise<boolean> {
  if (!/^[0-9a-f]{40}$/u.test(leftGitHead) || !/^[0-9a-f]{40}$/u.test(rightGitHead)) {
    throw new TypeError('C0.7 runtime source Git heads must be 40 lowercase hex')
  }
  const repository = await discoverGitRepository(options.cwd ?? repositoryRoot)
  const paths = normalizeRuntimeSourcePaths(options.paths ?? RUNTIME_SOURCE_PATHS)
  const [left, right] = await Promise.all([
    readGitTreeEntries(repository, leftGitHead, paths),
    readGitTreeEntries(repository, rightGitHead, paths)
  ])
  return gitTreeEntriesEqual(left, right)
}

async function assertCleanCaptureCheckout(): Promise<string> {
  if (process.versions.node !== '22.19.0') {
    throw new Error('C0.7 immutable publication must run on exact Node 22.19.0')
  }
  const repository = await discoverGitRepository(repositoryRoot)
  const gitHead = await readRepositoryGitHead(repository)
  const status = await gitOutput(repository, ['status', '--porcelain=v1', '--untracked-files=all'])
  if (status !== '') throw new Error('C0.7 capture checkout must be completely clean before recording')
  await assertRuntimeSourcesMatchGitHead(gitHead)
  return gitHead
}

async function compatibility(baselineGitHead: string): Promise<ImmutableTranscriptManifest['compatibility']> {
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
    name?: unknown
    version?: unknown
    dependencies?: Record<string, unknown>
    devDependencies?: Record<string, unknown>
  }
  const packageLock = JSON.parse(await readFile(packageLockPath, 'utf8')) as {
    packages?: Record<
      string,
      {
        version?: unknown
        integrity?: unknown
      }
    >
  }
  const installedPi = JSON.parse(await readFile(installedPiPackageJsonPath, 'utf8')) as {
    name?: unknown
    version?: unknown
  }
  const installedSdk = JSON.parse(await readFile(installedSdkPackageJsonPath, 'utf8')) as {
    name?: unknown
    version?: unknown
  }
  const piLock = packageLock.packages?.['node_modules/@earendil-works/pi-coding-agent']
  const sdkLock = packageLock.packages?.['node_modules/@agentclientprotocol/sdk']
  const [piInstalledTreeSha256, sdkInstalledTreeSha256] = await Promise.all([
    installedPackageTreeSha256(installedPiPackageRoot),
    installedPackageTreeSha256(installedSdkPackageRoot)
  ])
  if (
    packageJson.name !== 'pi-acp' ||
    packageJson.version !== '0.0.33' ||
    packageJson.devDependencies?.['@earendil-works/pi-coding-agent'] !== '0.83.0' ||
    packageJson.dependencies?.['@agentclientprotocol/sdk'] !== '0.26.0' ||
    piLock?.version !== '0.83.0' ||
    piLock.integrity !== C0_7_PI_LOCK_INTEGRITY ||
    sdkLock?.version !== '0.26.0' ||
    sdkLock.integrity !== C0_7_ACP_SDK_LOCK_INTEGRITY ||
    installedPi.name !== '@earendil-works/pi-coding-agent' ||
    installedPi.version !== '0.83.0' ||
    installedSdk.name !== '@agentclientprotocol/sdk' ||
    installedSdk.version !== '0.26.0' ||
    piInstalledTreeSha256 !== C0_7_PI_INSTALLED_TREE_SHA256 ||
    sdkInstalledTreeSha256 !== C0_7_ACP_SDK_INSTALLED_TREE_SHA256
  ) {
    throw new Error('C0.7 updater compatibility pins do not match package metadata')
  }

  return {
    adapter: {
      package: 'pi-acp',
      version: '0.0.33',
      baselineGitHead
    },
    pi: {
      package: '@earendil-works/pi-coding-agent',
      version: '0.83.0',
      gitHead: C0_7_PI_GIT_HEAD,
      lockIntegrity: C0_7_PI_LOCK_INTEGRITY,
      installedTreeSha256: piInstalledTreeSha256
    },
    acp: {
      protocolVersion: 1,
      sdkPackage: '@agentclientprotocol/sdk',
      sdkVersion: '0.26.0',
      sdkGitHead: C0_7_ACP_SDK_GIT_HEAD,
      lockIntegrity: C0_7_ACP_SDK_LOCK_INTEGRITY,
      installedTreeSha256: sdkInstalledTreeSha256
    },
    clients: {
      repository: C0_7_CLIENT_REPOSITORY,
      raw: {
        id: 'raw-process-client',
        version: {
          kind: 'git',
          commit: baselineGitHead
        },
        sources: await baselineClientSources('raw')
      },
      strict: {
        id: 'strict-catalog-client',
        version: {
          kind: 'git',
          commit: baselineGitHead
        },
        sources: await baselineClientSources('strict')
      }
    },
    fixture: {
      id: 'pi-extension-pack-v1',
      sources: [
        {
          path: 'test/fixtures/pi-extension-pack/index.ts',
          sha256: sha256(await readFile(fixtureSourcePath))
        },
        {
          path: 'test/fixtures/pi-extension-pack/project-canary.js',
          sha256: sha256(await readFile(projectCanarySourcePath))
        }
      ]
    }
  }
}

export async function assertInstalledPackageTreesMatchManifest(manifest: ImmutableTranscriptManifest): Promise<void> {
  const [piInstalledTreeSha256, sdkInstalledTreeSha256] = await Promise.all([
    installedPackageTreeSha256(installedPiPackageRoot),
    installedPackageTreeSha256(installedSdkPackageRoot)
  ])
  if (
    piInstalledTreeSha256 !== C0_7_PI_INSTALLED_TREE_SHA256 ||
    sdkInstalledTreeSha256 !== C0_7_ACP_SDK_INSTALLED_TREE_SHA256 ||
    piInstalledTreeSha256 !== manifest.compatibility.pi.installedTreeSha256 ||
    sdkInstalledTreeSha256 !== manifest.compatibility.acp.installedTreeSha256
  ) {
    throw new Error('C0.7 installed Pi/ACP package trees do not match the immutable manifest')
  }
}

async function existingManifest(expected: string | 'absent'): Promise<ImmutableTranscriptManifest | undefined> {
  try {
    const existing = await readVerifiedManifest()
    if (existing.sha256 !== expected) {
      throw new Error(`existing manifest SHA is ${existing.sha256}, not requested ${expected}`)
    }
    return existing.manifest
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (expected !== 'absent') throw error
    return undefined
  }
}

async function main(): Promise<void> {
  const recordingDate = new Date().toISOString().slice(0, 10)
  const options = parseTranscriptUpdateArgs(process.argv.slice(2), recordingDate)
  await existingManifest(options.expectedOldManifestSha256)
  const baselineGitHead = await assertCleanCaptureCheckout()
  const compatibilityTuple = await compatibility(baselineGitHead)

  const selected = new Map<BaselineCaseId, ObservedBaseline>()
  for (const caseId of options.cases) {
    selected.set(caseId, await captureTwice(caseId, baselineGitHead))
  }

  const artifacts = new Map<string, Buffer>()
  const cases: ImmutableTranscriptCase[] = []
  for (const caseId of ALL_CASE_IDS) {
    const observed = selected.get(caseId)
    if (!observed) throw new Error(`C0.7 capture omitted ${caseId}`)
    const transcript = observed.canonicalTranscript
    artifacts.set(transcript.sha256, transcript.bytes)
    cases.push({
      ...caseMetadata(observed),
      clientBehavior: observed.clientBehavior,
      runtime: observed.runtime,
      expectedFailure: observed.expectedFailure,
      networkBoundary: observed.networkBoundary,
      artifact: {
        path: `artifacts/sha256-${transcript.sha256}.ndjson`,
        sha256: transcript.sha256,
        byteLength: transcript.bytes.length,
        recordCount: transcript.recordCount
      }
    })
  }

  const finalGitHead = await assertCleanCaptureCheckout()
  if (finalGitHead !== baselineGitHead) {
    throw new Error('C0.7 capture Git head changed while recording')
  }
  const finalCompatibilityTuple = await compatibility(baselineGitHead)
  if (!isDeepStrictEqual(finalCompatibilityTuple, compatibilityTuple)) {
    throw new Error('C0.7 compatibility tuple changed while recording')
  }
  const manifest: ImmutableTranscriptManifest = {
    schemaVersion: 1,
    planId: 'PACP-CMD-2026-01',
    checkpoint: 'C0.7',
    status: 'blocked',
    blockedBy: {
      checkpoint: 'C0.3',
      reason: "C0.7 cannot pass G0 until C0.3's exact pushed network-denied CI evidence is independently verified.",
      owner: '@Hiton (#Pi-ACP task #2)',
      trackingUrl: 'https://github.com/Eric-Song-Nop/pi-acp/issues/7',
      recheckDate: options.recheckDate
    },
    recordedAt: recordingDate,
    storagePolicy: 'linux-darwin-localfs-nofollow-cas-v1',
    capturePolicy: {
      freshCaptureCount: 2,
      caseHardDeadlineMs: 30_000,
      loopbackBodyByteLimit: 65_536,
      loopbackBodyTimeoutMs: 2_000,
      loopbackCloseTimeoutMs: 1_000
    },
    compatibility: compatibilityTuple,
    recordingNodeVersions: [...new Set(cases.map(item => item.runtime.nodeVersion))].sort(),
    cases
  }

  await mkdir(C0_7_TRANSCRIPT_ROOT, {
    recursive: true,
    mode: 0o700
  })
  await chmod(C0_7_TRANSCRIPT_ROOT, 0o700)
  await mkdir(fileURLToPath(new URL('../test/e2e/transcripts/c0.7/artifacts/', import.meta.url)), {
    recursive: true,
    mode: 0o700
  })
  if ((await realpath(C0_7_TRANSCRIPT_ROOT)) !== C0_7_TRANSCRIPT_ROOT) {
    throw new Error('C0.7 transcript root is not canonical after preparation')
  }
  const result = await publishTranscriptUpdate({
    expectedOldManifestSha256: options.expectedOldManifestSha256,
    manifest,
    artifacts
  })
  process.stdout.write(`${result.manifestSha256}\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main()
}
