import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
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
  'test/fixtures/pi-extension-pack/index.ts',
  'test/fixtures/pi-extension-pack/project-canary.js',
  'test/helpers/acp-process-client.ts',
  'test/helpers/immutable-transcript.ts',
  'test/helpers/real-pi-baseline-scenarios.ts',
  'test/helpers/real-pi-fixture.ts',
  'test/helpers/strict-catalog-client.ts'
] as const

type CliOptions = {
  cases: BaselineCaseId[]
  expectedOldManifestSha256: string | 'absent'
  recheckDate: string
}

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

async function gitOutput(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8'
  })
  return stdout.trim()
}

export async function assertRuntimeSourcesMatchGitHead(gitHead: string): Promise<void> {
  if (!/^[0-9a-f]{40}$/u.test(gitHead)) throw new TypeError('C0.7 runtime source Git head must be 40 lowercase hex')
  const changed = await gitOutput(['diff', '--name-only', gitHead, '--', ...RUNTIME_SOURCE_PATHS])
  const untrackedOrModified = await gitOutput([
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--',
    ...RUNTIME_SOURCE_PATHS
  ])
  if (changed !== '' || untrackedOrModified !== '') {
    throw new Error('C0.7 runtime-bearing sources do not match the declared baseline Git head')
  }
}

async function assertCleanCaptureCheckout(): Promise<string> {
  if (process.versions.node !== '22.19.0') {
    throw new Error('C0.7 immutable publication must run on exact Node 22.19.0')
  }
  const gitHead = await gitOutput(['rev-parse', 'HEAD'])
  if (!/^[0-9a-f]{40}$/u.test(gitHead)) throw new Error('C0.7 capture checkout has no exact Git commit')
  const status = await gitOutput(['status', '--porcelain=v1', '--untracked-files=all'])
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
      reason: 'C0.7 cannot pass G0 until C0.3 wires the required CI gates and proves OS-level network denial.',
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
