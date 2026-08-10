import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'
import test from 'node:test'

const execFileAsync = promisify(execFile)
const script = fileURLToPath(new URL('../../.github/scripts/acquire-patched-pi.sh', import.meta.url))
const SOURCE_SHA = 'a'.repeat(40)
const DEPENDENCY_LINK = '../../../@earendil-works/pi-coding-agent/node_modules'

interface TarEntry {
  path: string
  data?: Buffer | string
  mode?: number
  type?: '0' | '2' | '5'
  linkPath?: string
}

interface Fixture {
  archive: string
  destinationRoot: string
  root: string
  stockPackageRoot: string
}

function writeTarField(header: Buffer, offset: number, length: number, value: string): void {
  const encoded = Buffer.from(value, 'utf8')
  assert.ok(encoded.length <= length, `tar field is too long: ${value}`)
  encoded.copy(header, offset)
}

function octalField(value: number, length: number): string {
  const digits = value.toString(8).padStart(length - 1, '0')
  assert.equal(digits.length, length - 1)
  return `${digits}\0`
}

function tarArchive(entries: readonly TarEntry[]): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8')
    const type = entry.type ?? '0'
    const header = Buffer.alloc(512)
    writeTarField(header, 0, 100, entry.path)
    writeTarField(header, 100, 8, octalField(entry.mode ?? (type === '5' ? 0o755 : 0o644), 8))
    writeTarField(header, 108, 8, octalField(0, 8))
    writeTarField(header, 116, 8, octalField(0, 8))
    writeTarField(header, 124, 12, octalField(data.length, 12))
    writeTarField(header, 136, 12, octalField(0, 12))
    header.fill(0x20, 148, 156)
    header[156] = type.charCodeAt(0)
    if (entry.linkPath !== undefined) writeTarField(header, 157, 100, entry.linkPath)
    writeTarField(header, 257, 6, 'ustar\0')
    writeTarField(header, 263, 2, '00')
    writeTarField(header, 265, 32, 'root')
    writeTarField(header, 297, 32, 'root')
    const checksum = [...header].reduce((sum, byte) => sum + byte, 0)
    writeTarField(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `)
    blocks.push(header, data)
    const remainder = data.length % 512
    if (remainder !== 0) blocks.push(Buffer.alloc(512 - remainder))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

const packageJson = `${JSON.stringify({
  name: '@earendil-works/pi-coding-agent',
  version: '0.83.0',
  type: 'module',
  bin: { pi: 'dist/cli.js' }
})}\n`
const shrinkwrap = `${JSON.stringify({
  name: '@earendil-works/pi-coding-agent',
  version: '0.83.0',
  lockfileVersion: 3,
  packages: {}
})}\n`
const cli = `if (process.env.PI_ACP_ACQUIRE_TEST_ARCHIVE !== undefined) {
  process.stderr.write('ambient acquisition environment leaked\\n')
  process.exit(19)
}
if (process.argv.includes('--version')) process.stdout.write('0.83.0\\n')
`

function validEntries(): TarEntry[] {
  return [
    { path: 'package/package.json', data: packageJson },
    { path: 'package/npm-shrinkwrap.json', data: shrinkwrap },
    { path: 'package/dist/cli.js', data: cli, mode: 0o755 }
  ]
}

async function createFixture(entries: readonly TarEntry[] = validEntries()): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'pi-acp-patched-acquisition-'))
  const modules = join(root, 'node_modules')
  const stockPackageRoot = join(modules, '@earendil-works', 'pi-coding-agent')
  const stockDependencies = join(stockPackageRoot, 'node_modules')
  const destinationRoot = join(modules, '.pi-acp-patched-pi')
  const bin = join(root, 'bin')
  const archive = join(root, 'artifact.tgz')
  await mkdir(stockDependencies, { recursive: true })
  await mkdir(bin, { recursive: true })
  await writeFile(join(stockPackageRoot, 'package.json'), packageJson)
  await writeFile(join(stockPackageRoot, 'npm-shrinkwrap.json'), shrinkwrap)
  await writeFile(join(stockDependencies, 'dependency-proof'), 'stock dependency graph\n')
  await writeFile(archive, tarArchive(entries))
  await writeFile(
    join(bin, 'curl'),
    `#!/bin/sh
set -eu
output=
connect_timeout=
max_time=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output)
      output=$2
      shift 2
      ;;
    --connect-timeout)
      connect_timeout=$2
      shift 2
      ;;
    --max-time)
      max_time=$2
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done
[ -n "$output" ]
[ "$connect_timeout" = 15 ]
[ "$max_time" = 300 ]
if [ -n "\${PI_ACP_ACQUIRE_TEST_WAIT_FILE:-}" ]; then
  : > "\${PI_ACP_ACQUIRE_TEST_WAIT_FILE}.started"
  while [ ! -e "$PI_ACP_ACQUIRE_TEST_WAIT_FILE" ]; do
    sleep 0.01
  done
fi
/bin/cp "$PI_ACP_ACQUIRE_TEST_ARCHIVE" "$output"
`
  )
  await chmod(join(bin, 'curl'), 0o755)
  return { archive, destinationRoot, root, stockPackageRoot }
}

function identities(archive: Buffer): { hex: string; sri: string } {
  const digest = createHash('sha512').update(archive).digest()
  return { hex: digest.toString('hex'), sri: `sha512-${digest.toString('base64')}` }
}

async function runAcquisition(
  fixture: Fixture,
  options: {
    extraEnv?: NodeJS.ProcessEnv
    envOnly?: boolean
    hex?: string
    releaseUrl?: string
    sourceSha?: string
    sri?: string
  } = {}
): Promise<{ stderr: string; stdout: string }> {
  const digest = identities(await readFile(fixture.archive))
  const values = {
    releaseUrl: options.releaseUrl ?? 'https://github.example.invalid/releases/artifact.tgz',
    sourceSha: options.sourceSha ?? SOURCE_SHA,
    hex: options.hex ?? digest.hex,
    sri: options.sri ?? digest.sri
  }
  const env = {
    ...process.env,
    PATH: `${join(fixture.root, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    PI_ACP_ACQUIRE_TEST_ARCHIVE: fixture.archive,
    ...options.extraEnv
  }
  const args: string[] = []
  if (options.envOnly === true) {
    Object.assign(env, {
      PI_ACP_PATCHED_PI_RELEASE_URL: values.releaseUrl,
      PI_ACP_PATCHED_PI_SOURCE_SHA: values.sourceSha,
      PI_ACP_PATCHED_PI_SHA512_HEX: values.hex,
      PI_ACP_PATCHED_PI_SHA512_SRI: values.sri,
      PI_ACP_STOCK_PI_PACKAGE_ROOT: fixture.stockPackageRoot,
      PI_ACP_PATCHED_PI_DESTINATION_ROOT: fixture.destinationRoot
    })
  } else {
    args.push(
      '--release-url',
      values.releaseUrl,
      '--source-sha',
      values.sourceSha,
      '--sha512-hex',
      values.hex,
      '--sha512-sri',
      values.sri,
      '--stock-package-root',
      fixture.stockPackageRoot,
      '--destination-root',
      fixture.destinationRoot
    )
  }
  return execFileAsync('/bin/bash', [script, ...args], {
    env,
    timeout: 30_000,
    maxBuffer: 1024 * 1024
  })
}

async function assertNoPartialDestination(fixture: Fixture, sourceSha = SOURCE_SHA): Promise<void> {
  await assert.rejects(lstat(join(fixture.destinationRoot, sourceSha)), { code: 'ENOENT' })
  const children = await readdir(fixture.destinationRoot).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  })
  assert.deepEqual(children, [])
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      await lstat(path)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${path}`)
}

test('C3.4 acquisition verifies, links, smokes, and atomically publishes the patched package', async t => {
  const fixture = await createFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))

  const result = await runAcquisition(fixture)
  const packageRoot = join(fixture.destinationRoot, SOURCE_SHA, 'package')
  assert.equal(result.stdout, `${await realpath(packageRoot)}\n`)
  assert.equal(result.stderr, '')
  assert.equal(await readFile(join(packageRoot, 'package.json'), 'utf8'), packageJson)
  assert.equal(await readFile(join(packageRoot, 'npm-shrinkwrap.json'), 'utf8'), shrinkwrap)
  assert.equal((await lstat(join(packageRoot, 'dist', 'cli.js'))).mode & 0o111, 0o111)
  assert.equal((await lstat(join(packageRoot, 'node_modules'))).isSymbolicLink(), true)
  assert.equal(await readlink(join(packageRoot, 'node_modules')), DEPENDENCY_LINK)
  assert.equal(
    await realpath(join(packageRoot, 'node_modules')),
    await realpath(join(fixture.stockPackageRoot, 'node_modules'))
  )
  assert.equal(
    await readFile(join(packageRoot, 'node_modules', 'dependency-proof'), 'utf8'),
    'stock dependency graph\n'
  )
})

test('C3.4 acquisition supports the explicit environment interface and refuses replacement', async t => {
  const fixture = await createFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))

  await runAcquisition(fixture, { envOnly: true })
  const packageRoot = join(fixture.destinationRoot, SOURCE_SHA, 'package')
  await writeFile(join(packageRoot, 'publication-proof'), 'original\n')

  await assert.rejects(runAcquisition(fixture, { envOnly: true }), /destination already exists/u)
  assert.equal(await readFile(join(packageRoot, 'publication-proof'), 'utf8'), 'original\n')
})

test('C3.4 acquisition serializes concurrent publication for the same source SHA', async t => {
  const fixture = await createFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const release = join(fixture.root, 'release-first-download')
  const first = runAcquisition(fixture, {
    extraEnv: { PI_ACP_ACQUIRE_TEST_WAIT_FILE: release }
  })
  await waitForPath(`${release}.started`)

  const secondFailure = await runAcquisition(fixture).then(
    () => undefined,
    error => error as Error & { stderr?: string }
  )
  await writeFile(release, 'release\n')
  await first

  assert.ok(secondFailure)
  assert.match(
    `${secondFailure.message}\n${secondFailure.stderr ?? ''}`,
    /another acquisition owns the source SHA lock/u
  )
  assert.equal((await lstat(join(fixture.destinationRoot, SOURCE_SHA, 'package'))).isDirectory(), true)
  assert.deepEqual(await readdir(fixture.destinationRoot), [SOURCE_SHA])
})

test('C3.4 acquisition never nests staged content when a final directory races publication', async t => {
  const fixture = await createFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const release = join(fixture.root, 'release-raced-download')
  const acquisition = runAcquisition(fixture, {
    extraEnv: { PI_ACP_ACQUIRE_TEST_WAIT_FILE: release }
  })
  await waitForPath(`${release}.started`)

  const racedFinal = join(fixture.destinationRoot, SOURCE_SHA)
  await mkdir(racedFinal, { recursive: true })
  await writeFile(join(racedFinal, 'racer-proof'), 'foreign destination\n')
  await writeFile(release, 'release\n')
  const failure = await acquisition.then(
    () => undefined,
    error => error as Error & { stderr?: string }
  )

  assert.ok(failure)
  assert.match(`${failure.message}\n${failure.stderr ?? ''}`, /destination appeared during acquisition/u)
  assert.deepEqual(await readdir(racedFinal), ['racer-proof'])
  assert.equal(await readFile(join(racedFinal, 'racer-proof'), 'utf8'), 'foreign destination\n')
  assert.deepEqual(await readdir(fixture.destinationRoot), [SOURCE_SHA])
})

test('C3.4 acquisition rejects unverified or structurally unsafe artifacts without a partial destination', async t => {
  const cases: ReadonlyArray<{
    entries?: readonly TarEntry[]
    expected: RegExp
    mutateFixture?: (fixture: Fixture) => Promise<void>
    options?: Parameters<typeof runAcquisition>[1]
    title: string
  }> = [
    {
      title: 'non-HTTPS release URL',
      options: { releaseUrl: 'http://github.example.invalid/artifact.tgz' },
      expected: /release URL must be credential-free HTTPS/u
    },
    {
      title: 'wrong SHA-512 identity',
      options: {
        hex: '0'.repeat(128),
        sri: `sha512-${Buffer.alloc(64).toString('base64')}`
      },
      expected: /failed SHA-512 verification/u
    },
    {
      title: 'disagreeing SHA-512 hex and SRI identities',
      options: { sri: `sha512-${Buffer.alloc(64).toString('base64')}` },
      expected: /failed SHA-512 verification/u
    },
    {
      title: 'parent traversal',
      entries: [...validEntries(), { path: '../outside', data: 'escape' }],
      expected: /not a safe npm package archive/u
    },
    {
      title: 'absolute archive path',
      entries: [...validEntries(), { path: '/absolute', data: 'escape' }],
      expected: /not a safe npm package archive/u
    },
    {
      title: 'bundled node_modules',
      entries: [...validEntries(), { path: 'package/node_modules/poison', data: 'poison' }],
      expected: /not a safe npm package archive/u
    },
    {
      title: 'archive symlink',
      entries: [...validEntries(), { path: 'package/escape', type: '2', linkPath: '../../../../outside' }],
      expected: /not a safe npm package archive/u
    },
    {
      title: 'missing shrinkwrap',
      entries: validEntries().filter(entry => entry.path !== 'package/npm-shrinkwrap.json'),
      expected: /missing npm-shrinkwrap\.json/u
    },
    {
      title: 'non-executable CLI',
      entries: validEntries().map(entry => (entry.path === 'package/dist/cli.js' ? { ...entry, mode: 0o644 } : entry)),
      expected: /dist\/cli\.js is not executable/u
    },
    {
      title: 'package manifest drift',
      entries: validEntries().map(entry =>
        entry.path === 'package/package.json' ? { ...entry, data: '{"name":"wrong"}\n' } : entry
      ),
      expected: /package\.json differs/u
    },
    {
      title: 'wrong package name despite byte-identical stock manifest',
      entries: validEntries().map(entry =>
        entry.path === 'package/package.json'
          ? { ...entry, data: packageJson.replace('@earendil-works/pi-coding-agent', 'wrong') }
          : entry
      ),
      mutateFixture: async fixture => {
        await writeFile(
          join(fixture.stockPackageRoot, 'package.json'),
          packageJson.replace('@earendil-works/pi-coding-agent', 'wrong')
        )
      },
      expected: /wrong package identity/u
    },
    {
      title: 'wrong package version despite byte-identical stock manifest',
      entries: validEntries().map(entry =>
        entry.path === 'package/package.json' ? { ...entry, data: packageJson.replace('0.83.0', '0.84.0') } : entry
      ),
      mutateFixture: async fixture => {
        await writeFile(join(fixture.stockPackageRoot, 'package.json'), packageJson.replace('0.83.0', '0.84.0'))
      },
      expected: /wrong package identity/u
    },
    {
      title: 'wrong executable mapping despite byte-identical stock manifest',
      entries: validEntries().map(entry =>
        entry.path === 'package/package.json'
          ? { ...entry, data: packageJson.replace('dist/cli.js', 'dist/not-pi.js') }
          : entry
      ),
      mutateFixture: async fixture => {
        await writeFile(
          join(fixture.stockPackageRoot, 'package.json'),
          packageJson.replace('dist/cli.js', 'dist/not-pi.js')
        )
      },
      expected: /wrong package identity/u
    },
    {
      title: 'unexpected CLI version output',
      entries: validEntries().map(entry =>
        entry.path === 'package/dist/cli.js' ? { ...entry, data: "process.stdout.write('0.84.0\\n')\n" } : entry
      ),
      expected: /patched Pi CLI smoke failed/u
    },
    {
      title: 'shrinkwrap drift',
      entries: validEntries().map(entry =>
        entry.path === 'package/npm-shrinkwrap.json' ? { ...entry, data: '{}\n' } : entry
      ),
      expected: /npm-shrinkwrap\.json differs/u
    },
    {
      title: 'destination and stock graph mismatch',
      mutateFixture: async fixture => {
        fixture.destinationRoot = join(fixture.root, 'unrelated', '.pi-acp-patched-pi')
      },
      expected: /destination root is not beside the expected stock package/u
    }
  ]

  for (const fixtureCase of cases) {
    await t.test(fixtureCase.title, async t => {
      const fixture = await createFixture(fixtureCase.entries)
      t.after(() => rm(fixture.root, { recursive: true, force: true }))
      await fixtureCase.mutateFixture?.(fixture)
      await assert.rejects(runAcquisition(fixture, fixtureCase.options), fixtureCase.expected)
      await assertNoPartialDestination(fixture)
    })
  }
})
