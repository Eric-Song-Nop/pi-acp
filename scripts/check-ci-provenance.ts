import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  assertAuditSnapshot,
  assertExactToolchain,
  assertGitCheckout,
  classifyMutableIdentity,
  githubRunUrl,
  parseAuditReport,
  parseOptionalGitSha,
  registryTagUrl,
  registryVersionUrl,
  resolveGitHubTagCommit,
  validateLockedNpmPackagePin,
  validateNpmPackagePin,
  type NpmPinExpectation
} from '../test/helpers/ci-provenance.js'
import { readCompatibilityMatrix } from '../test/helpers/compatibility-matrix.js'

const execFileAsync = promisify(execFile)
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const MAX_METADATA_BYTES = 1024 * 1024
const MAX_AUDIT_BYTES = 4 * 1024 * 1024
const FETCH_TIMEOUT_MS = 10_000
const COMMAND_TIMEOUT_MS = 60_000
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u

type CliOptions = {
  expectedAdapterSha: string
}

type CommandResult = {
  code: number
  stdout: string
}

export function parseArgs(argv: readonly string[]): CliOptions {
  if (argv.length !== 2 || argv[0] !== '--expected-adapter-sha' || !GIT_SHA_PATTERN.test(argv[1] ?? '')) {
    throw new TypeError('usage: node --import tsx scripts/check-ci-provenance.ts --expected-adapter-sha <40-hex-sha>')
  }
  return { expectedAdapterSha: argv[1] }
}

function sanitizedCommandEnvironment(cacheDir: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: cacheDir,
    CI: '1',
    NO_COLOR: '1',
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_userconfig: '/dev/null',
    npm_config_globalconfig: '/dev/null',
    npm_config_cache: join(cacheDir, 'npm-cache'),
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false'
  }
}

async function runCommand(
  file: string,
  args: readonly string[],
  options: {
    allowedExitCodes?: readonly number[]
    maxBuffer?: number
    env: NodeJS.ProcessEnv
  }
): Promise<CommandResult> {
  try {
    const { stdout } = await execFileAsync(file, [...args], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: options.env,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: options.maxBuffer ?? MAX_METADATA_BYTES
    })
    return { code: 0, stdout }
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      code?: number | string
      stdout?: string
    }
    const code = typeof failure.code === 'number' ? failure.code : undefined
    if (code !== undefined && (options.allowedExitCodes ?? []).includes(code)) {
      return { code, stdout: failure.stdout ?? '' }
    }
    throw new Error(`${file} ${args.join(' ')} did not complete with an allowed exit status`, {
      cause: error
    })
  }
}

async function fetchJson(url: URL, headers: Record<string, string> = {}): Promise<unknown> {
  if (url.protocol !== 'https:') throw new Error(`C0.3 metadata URL must use HTTPS: ${url.href}`)
  const response = await fetch(url, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`C0.3 metadata request failed with HTTP ${String(response.status)}: ${url.href}`)
  const contentLength = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(contentLength) && contentLength > MAX_METADATA_BYTES) {
    throw new Error(`C0.3 metadata response exceeded ${String(MAX_METADATA_BYTES)} bytes: ${url.href}`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0 || bytes.length > MAX_METADATA_BYTES) {
    throw new Error(`C0.3 metadata response size is invalid: ${url.href}`)
  }
  return JSON.parse(bytes.toString('utf8')) as unknown
}

function githubHeaders(): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    'user-agent': 'pi-acp-c0.3-provenance',
    'x-github-api-version': '2022-11-28'
  }
}

async function assertNpmPin(expected: NpmPinExpectation): Promise<void> {
  validateNpmPackagePin(expected, await fetchJson(registryVersionUrl(expected.package, expected.version)))
}

async function githubTagCommit(repository: string, ref: string): Promise<string> {
  const headers = githubHeaders()
  const initial = await fetchJson(
    new URL(`https://api.github.com/repos/${repository}/git/ref/tags/${encodeURIComponent(ref)}`),
    headers
  )
  return await resolveGitHubTagCommit(repository, initial, async url => {
    const parsed = new URL(url)
    if (parsed.origin !== 'https://api.github.com') {
      throw new Error(`C0.3 tag peel escaped api.github.com: ${url}`)
    }
    const value = await fetchJson(parsed, headers)
    if (!value || typeof value !== 'object') throw new Error('C0.3 GitHub tag object is malformed')
    return value
  })
}

async function mutableObservations(matrix: ReturnType<typeof readCompatibilityMatrix>) {
  const observations: Record<string, string> = {}
  const warnings: string[] = []
  try {
    const latest = (await fetchJson(registryTagUrl(matrix.pi.package, 'latest'))) as {
      version?: unknown
    }
    const observation = classifyMutableIdentity('Pi latest', 'version', matrix.pi.baselineVersion, latest.version)
    if (observation.value) observations.piLatest = observation.value
    if (observation.warning) warnings.push(observation.warning)
  } catch (error) {
    warnings.push(`Pi latest unavailable; mutable observation is warn-only: ${(error as Error).message}`)
  }
  try {
    const latest = (await fetchJson(registryTagUrl(matrix.acp.sdkPackage, 'latest'))) as {
      version?: unknown
    }
    const observation = classifyMutableIdentity('ACP latest', 'version', matrix.acp.sdkVersion, latest.version)
    if (observation.value) observations.acpLatest = observation.value
    if (observation.warning) warnings.push(observation.warning)
  } catch (error) {
    warnings.push(`ACP latest unavailable; mutable observation is warn-only: ${(error as Error).message}`)
  }
  try {
    const value = (await fetchJson(
      new URL(`https://api.github.com/repos/${matrix.pi.repository}/commits/${matrix.pi.headRef}`),
      githubHeaders()
    )) as { sha?: unknown }
    const observation = classifyMutableIdentity('Pi main', 'git-sha', matrix.pi.baselineGitHead, value.sha)
    if (observation.value) observations.piHead = observation.value
    if (observation.warning) warnings.push(observation.warning)
  } catch (error) {
    warnings.push(`Pi main unavailable; mutable observation is warn-only: ${(error as Error).message}`)
  }
  return { observations, warnings }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const matrix = readCompatibilityMatrix()
  const cacheDir =
    process.env.RUNNER_TEMP && isAbsolute(process.env.RUNNER_TEMP)
      ? join(process.env.RUNNER_TEMP, 'pi-acp-c0.3-provenance')
      : join(tmpdir(), 'pi-acp-c0.3-provenance')
  await mkdir(cacheDir, { recursive: true, mode: 0o700 })
  const env = sanitizedCommandEnvironment(cacheDir)

  const npmVersion = (await runCommand('npm', ['--version'], { env })).stdout.trim()
  assertExactToolchain(matrix, process.versions.node, npmVersion)

  const [head, status, lockfile] = await Promise.all([
    runCommand('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { env }),
    runCommand('git', ['status', '--porcelain=v1', '--untracked-files=all'], { env }),
    readFile(join(repositoryRoot, 'package-lock.json'))
  ])
  const testedCheckoutSha = head.stdout.trim()
  assertGitCheckout(options.expectedAdapterSha, testedCheckoutSha, status.stdout)
  assert.notEqual(
    testedCheckoutSha,
    matrix.adapter.baselineSha,
    'C0.3 tested checkout SHA must remain distinct from the immutable C0.2 baseline SHA'
  )

  const packageLock = JSON.parse(lockfile.toString('utf8')) as {
    packages?: Record<string, { version?: unknown; resolved?: unknown; integrity?: unknown }>
  }
  const lockedPi = packageLock.packages?.['node_modules/@earendil-works/pi-coding-agent']
  const lockedSdk = packageLock.packages?.['node_modules/@agentclientprotocol/sdk']
  validateLockedNpmPackagePin(
    {
      package: matrix.pi.package,
      version: matrix.pi.baselineVersion,
      gitHead: matrix.pi.baselineGitHead,
      integrity: matrix.pi.baselineIntegrity
    },
    lockedPi
  )
  validateLockedNpmPackagePin(
    {
      package: matrix.acp.sdkPackage,
      version: matrix.acp.sdkVersion,
      gitHead: matrix.acp.sdkGitHead,
      integrity: matrix.acp.sdkIntegrity
    },
    lockedSdk
  )

  const npmPins: readonly NpmPinExpectation[] = [
    {
      package: matrix.pi.package,
      version: matrix.pi.minimumVersion,
      gitHead: matrix.pi.minimumGitHead,
      integrity: matrix.pi.minimumIntegrity
    },
    {
      package: matrix.pi.package,
      version: matrix.pi.baselineVersion,
      gitHead: matrix.pi.baselineGitHead,
      integrity: matrix.pi.baselineIntegrity
    },
    {
      package: matrix.acp.sdkPackage,
      version: matrix.acp.sdkVersion,
      gitHead: matrix.acp.sdkGitHead,
      integrity: matrix.acp.sdkIntegrity
    }
  ]
  await Promise.all(npmPins.map(assertNpmPin))

  const tagPins = [
    {
      repository: matrix.pi.repository,
      ref: `v${matrix.pi.minimumVersion}`,
      commit: matrix.pi.minimumGitHead
    },
    {
      repository: matrix.pi.repository,
      ref: `v${matrix.pi.baselineVersion}`,
      commit: matrix.pi.baselineGitHead
    },
    {
      repository: matrix.acp.repository,
      ref: `v${matrix.acp.sdkVersion}`,
      commit: matrix.acp.sdkGitHead
    },
    {
      repository: matrix.clients.zed.repository,
      ref: matrix.clients.zed.ref,
      commit: matrix.clients.zed.commit
    },
    {
      repository: matrix.clients.nonZed.repository,
      ref: matrix.clients.nonZed.ref,
      commit: matrix.clients.nonZed.commit
    }
  ] as const
  const observedTagCommits = await Promise.all(
    tagPins.map(async pin => ({
      ...pin,
      observed: await githubTagCommit(pin.repository, pin.ref)
    }))
  )
  for (const pin of observedTagCommits) {
    assert.equal(pin.observed, pin.commit, `${pin.repository} ${pin.ref} moved`)
  }

  const [developmentAudit, runtimeAudit] = await Promise.all([
    runCommand('npm', ['audit', '--json', '--audit-level=info', '--registry=https://registry.npmjs.org/'], {
      env,
      allowedExitCodes: [1],
      maxBuffer: MAX_AUDIT_BYTES
    }),
    runCommand(
      'npm',
      ['audit', '--omit=dev', '--json', '--audit-level=info', '--registry=https://registry.npmjs.org/'],
      {
        env,
        allowedExitCodes: [1],
        maxBuffer: MAX_AUDIT_BYTES
      }
    )
  ])
  const observedDevelopmentAudit = parseAuditReport(developmentAudit.stdout, developmentAudit.code)
  const observedRuntimeAudit = parseAuditReport(runtimeAudit.stdout, runtimeAudit.code)
  assertAuditSnapshot(
    'development',
    matrix.dependencyAudit.development,
    matrix.dependencyAudit.developmentAdvisories,
    observedDevelopmentAudit
  )
  assertAuditSnapshot(
    'runtime',
    matrix.dependencyAudit.runtime,
    matrix.dependencyAudit.runtimeAdvisories,
    observedRuntimeAudit
  )

  const mutable = await mutableObservations(matrix)
  const eventSha = parseOptionalGitSha(process.env.GITHUB_SHA)
  const runUrl = githubRunUrl(process.env.GITHUB_REPOSITORY, process.env.GITHUB_RUN_ID)
  const pullRequestHeadSha = parseOptionalGitSha(process.env.C0_3_PR_HEAD_SHA || undefined)
  const pullRequestBaseSha = parseOptionalGitSha(process.env.C0_3_PR_BASE_SHA || undefined)
  if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
    assert.ok(eventSha, 'pull_request provenance must include the synthetic GitHub event SHA')
    assert.ok(pullRequestHeadSha, 'pull_request provenance must include the immutable head SHA')
    assert.ok(pullRequestBaseSha, 'pull_request provenance must include the base SHA')
    assert.equal(
      pullRequestHeadSha,
      options.expectedAdapterSha,
      'pull_request head SHA must equal the workflow-requested checkout'
    )
  } else {
    assert.equal(pullRequestHeadSha, null, 'non-pull_request provenance must not report a PR head SHA')
    assert.equal(pullRequestBaseSha, null, 'non-pull_request provenance must not report a PR base SHA')
    if (process.env.GITHUB_EVENT_NAME !== undefined) {
      assert.ok(eventSha, 'GitHub provenance must include the event SHA')
      assert.equal(eventSha, options.expectedAdapterSha, 'non-PR event SHA must equal the requested checkout')
    }
  }
  const output = {
    schemaVersion: 1,
    checkpoint: 'C0.3',
    status: 'preflight-passed',
    baselineSha: matrix.adapter.baselineSha,
    testedCheckoutSha,
    expectedCheckoutSha: options.expectedAdapterSha,
    nodeVersion: process.versions.node,
    npmVersion,
    lockfileSha256: createHash('sha256').update(lockfile).digest('hex'),
    immutablePins: {
      npm: npmPins.map(pin => ({
        package: pin.package,
        version: pin.version,
        gitHead: pin.gitHead,
        integrity: pin.integrity
      })),
      gitTags: tagPins
    },
    audits: {
      development: observedDevelopmentAudit,
      runtime: observedRuntimeAudit
    },
    mutableObservations: mutable.observations,
    warnings: mutable.warnings,
    github: {
      repository: process.env.GITHUB_REPOSITORY ?? null,
      runId: process.env.GITHUB_RUN_ID ?? null,
      runUrl,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      eventName: process.env.GITHUB_EVENT_NAME ?? null,
      eventSha,
      pullRequestHeadSha,
      pullRequestBaseSha
    },
    networkBoundary: 'metadata-and-audit-preflight; execution denial is a separate gate'
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : undefined
if (entryPath === fileURLToPath(import.meta.url)) {
  await main()
}
