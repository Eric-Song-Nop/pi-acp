#!/usr/bin/env bash

set -euo pipefail

readonly DEPENDENCY_LINK='../../../@earendil-works/pi-coding-agent/node_modules'

usage() {
  cat <<'USAGE'
Usage: acquire-patched-pi.sh [options]

Download and verify a patched Pi coding-agent package, then install it atomically.
Every option can instead be supplied through the corresponding environment variable.
Command-line values take precedence.

  --release-url URL          PI_ACP_PATCHED_PI_RELEASE_URL
  --source-sha SHA           PI_ACP_PATCHED_PI_SOURCE_SHA
  --sha512-hex HEX           PI_ACP_PATCHED_PI_SHA512_HEX
  --sha512-sri SRI           PI_ACP_PATCHED_PI_SHA512_SRI
  --stock-package-root PATH  PI_ACP_STOCK_PI_PACKAGE_ROOT
  --destination-root PATH    PI_ACP_PATCHED_PI_DESTINATION_ROOT
  --help

The destination is <destination-root>/<source-sha>/package. The destination root
must be a direct child of the node_modules directory containing the supplied stock
@earendil-works/pi-coding-agent package.
USAGE
}

die() {
  printf 'acquire-patched-pi: %s\n' "$*" >&2
  exit 1
}

require_option_value() {
  local option=$1
  local remaining=$2
  ((remaining >= 2)) || die "${option} requires a value"
}

release_url=${PI_ACP_PATCHED_PI_RELEASE_URL:-}
source_sha=${PI_ACP_PATCHED_PI_SOURCE_SHA:-}
sha512_hex=${PI_ACP_PATCHED_PI_SHA512_HEX:-}
sha512_sri=${PI_ACP_PATCHED_PI_SHA512_SRI:-}
stock_package_root=${PI_ACP_STOCK_PI_PACKAGE_ROOT:-}
destination_root=${PI_ACP_PATCHED_PI_DESTINATION_ROOT:-}

while (($# > 0)); do
  case "$1" in
    --release-url)
      require_option_value "$1" "$#"
      release_url=$2
      shift 2
      ;;
    --source-sha)
      require_option_value "$1" "$#"
      source_sha=$2
      shift 2
      ;;
    --sha512-hex)
      require_option_value "$1" "$#"
      sha512_hex=$2
      shift 2
      ;;
    --sha512-sri)
      require_option_value "$1" "$#"
      sha512_sri=$2
      shift 2
      ;;
    --stock-package-root)
      require_option_value "$1" "$#"
      stock_package_root=$2
      shift 2
      ;;
    --destination-root)
      require_option_value "$1" "$#"
      destination_root=$2
      shift 2
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

[[ -n "$release_url" ]] || die 'missing --release-url'
[[ -n "$source_sha" ]] || die 'missing --source-sha'
[[ -n "$sha512_hex" ]] || die 'missing --sha512-hex'
[[ -n "$sha512_sri" ]] || die 'missing --sha512-sri'
[[ -n "$stock_package_root" ]] || die 'missing --stock-package-root'
[[ -n "$destination_root" ]] || die 'missing --destination-root'

[[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || die 'source SHA must be a full 40-character lowercase hexadecimal Git SHA'
[[ "$sha512_hex" =~ ^[0-9a-f]{128}$ ]] || die 'SHA-512 hex must be 128 lowercase hexadecimal characters'
[[ "$sha512_sri" =~ ^sha512-[A-Za-z0-9+/]{86}==$ ]] || die 'SHA-512 SRI must be canonical sha512-<base64>'

node_command=$(command -v node) || die 'node is required'
node_exec=$(
  "$node_command" --input-type=module -e \
    "import { realpathSync } from 'node:fs'; process.stdout.write(realpathSync(process.execPath))"
) || die 'could not canonicalize process.execPath'
[[ "$node_exec" == /* && -x "$node_exec" ]] || die 'canonical process.execPath is not an executable absolute path'

"$node_exec" --input-type=module - "$release_url" <<'NODE' || die 'release URL must be credential-free HTTPS'
const value = process.argv[2]
let url
try {
  url = new URL(value)
} catch {
  process.exit(1)
}
if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hostname === '') {
  process.exitCode = 1
}
NODE

[[ -d "$stock_package_root" ]] || die 'stock package root is not a directory'
stock_package_root=$(cd -- "$stock_package_root" && pwd -P) || die 'could not canonicalize stock package root'
[[ -f "$stock_package_root/package.json" ]] || die 'stock package is missing package.json'
[[ -f "$stock_package_root/npm-shrinkwrap.json" ]] || die 'stock package is missing npm-shrinkwrap.json'
[[ -d "$stock_package_root/node_modules" ]] || die 'stock package is missing its nested dependency directory'
stock_dependency_root=$(cd -- "$stock_package_root/node_modules" && pwd -P) || die 'could not canonicalize stock dependency root'

mkdir -p -- "$destination_root"
destination_root=$(cd -- "$destination_root" && pwd -P) || die 'could not canonicalize destination root'

expected_stock_root="$destination_root/../@earendil-works/pi-coding-agent"
[[ -d "$expected_stock_root" ]] || die 'destination root is not beside the expected stock package'
expected_stock_root=$(cd -- "$expected_stock_root" && pwd -P) || die 'could not canonicalize expected stock package root'
[[ "$expected_stock_root" == "$stock_package_root" ]] || die 'destination root does not resolve beside the supplied stock package root'

final_root="$destination_root/$source_sha"
if [[ -e "$final_root" || -L "$final_root" ]]; then
  die "destination already exists: $final_root"
fi

download_root=''
stage_root=''
lock_root=''
cleanup() {
  local status
  status=$1
  if [[ -n "$stage_root" && -d "$stage_root" ]]; then
    rm -rf -- "$stage_root"
  fi
  if [[ -n "$download_root" && -d "$download_root" ]]; then
    rm -rf -- "$download_root"
  fi
  if [[ -n "$lock_root" && -d "$lock_root" ]]; then
    rmdir -- "$lock_root" 2>/dev/null || true
  fi
  return "$status"
}
trap 'cleanup "$?"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

lock_root="$destination_root/.acquire-${source_sha}.lock"
if ! mkdir -- "$lock_root"; then
  lock_root=''
  die "another acquisition owns the source SHA lock: $source_sha"
fi

download_root=$(mktemp -d "${TMPDIR:-/tmp}/pi-acp-patched-pi-download.XXXXXX")
archive="$download_root/package.tgz"

curl \
  --disable \
  --fail \
  --location \
  --connect-timeout 15 \
  --max-time 300 \
  --proto '=https' \
  --proto-redir '=https' \
  --tlsv1.2 \
  --silent \
  --show-error \
  --output "$archive" \
  "$release_url"

"$node_exec" --input-type=module - "$archive" "$sha512_hex" "$sha512_sri" <<'NODE' || die 'downloaded artifact failed SHA-512 verification'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const [archive, expectedHex, expectedSri] = process.argv.slice(2)
const expectedBytes = Buffer.from(expectedHex, 'hex')
const canonicalExpectedSri = `sha512-${expectedBytes.toString('base64')}`
if (canonicalExpectedSri !== expectedSri) {
  throw new Error('the declared SHA-512 hex and SRI identities disagree')
}

const actualBytes = createHash('sha512').update(readFileSync(archive)).digest()
const actualHex = actualBytes.toString('hex')
const actualSri = `sha512-${actualBytes.toString('base64')}`
if (actualHex !== expectedHex || actualSri !== expectedSri) {
  throw new Error('the downloaded artifact does not match both declared identities')
}
NODE

stage_root=$(mktemp -d "$destination_root/.acquire-${source_sha}.XXXXXX")
stage_package="$stage_root/package"

"$node_exec" --input-type=module - "$archive" "$stage_package" <<'NODE' || die 'artifact is not a safe npm package archive'
import { gunzipSync } from 'node:zlib'
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'

const [archive, extractRoot] = process.argv.slice(2)
const tar = gunzipSync(await import('node:fs').then(({ readFileSync }) => readFileSync(archive)))
const decoder = new TextDecoder('utf-8', { fatal: true })
const BLOCK_SIZE = 512

function fail(message) {
  throw new Error(message)
}

function decodeString(buffer, label) {
  const nul = buffer.indexOf(0)
  const bytes = nul === -1 ? buffer : buffer.subarray(0, nul)
  try {
    return decoder.decode(bytes)
  } catch {
    fail(`${label} is not valid UTF-8`)
  }
}

function parseOctal(buffer, label) {
  const value = decodeString(buffer, label).trim()
  if (value === '') return 0
  if (!/^[0-7]+$/u.test(value)) fail(`${label} is not canonical octal`)
  const parsed = Number.parseInt(value, 8)
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail(`${label} is outside the safe integer range`)
  return parsed
}

function headerChecksum(block) {
  let sum = 0
  for (let index = 0; index < block.length; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : block[index]
  }
  return sum
}

function rawHeaderPath(block) {
  const name = decodeString(block.subarray(0, 100), 'tar path')
  const prefix = decodeString(block.subarray(345, 500), 'tar prefix')
  return prefix === '' ? name : `${prefix}/${name}`
}

function safeComponents(value, { packageEntry }) {
  if (value === '' || value.includes('\0') || value.includes('\\')) fail('archive path is empty or ambiguous')
  if (value.startsWith('/') || /^[A-Za-z]:/u.test(value)) fail(`archive path is absolute: ${value}`)
  const components = value.replace(/\/+$/u, '').split('/')
  if (components.some(component => component === '..')) fail(`archive path traverses its root: ${value}`)
  if (packageEntry && components.some(component => component === '' || component === '.')) {
    fail(`package path is not normalized: ${value}`)
  }
  if (packageEntry && components[0] !== 'package') fail(`archive entry is outside package/: ${value}`)
  if (packageEntry && components.some(component => component.toLowerCase() === 'node_modules')) {
    fail(`archive bundles node_modules: ${value}`)
  }
  return components
}

function parsePax(buffer) {
  const values = new Map()
  let offset = 0
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset)
    if (space === -1) fail('malformed PAX record length')
    const lengthText = buffer.subarray(offset, space).toString('ascii')
    if (!/^[1-9][0-9]*$/u.test(lengthText)) fail('malformed PAX record length')
    const length = Number.parseInt(lengthText, 10)
    const end = offset + length
    if (!Number.isSafeInteger(length) || end > buffer.length || buffer[end - 1] !== 0x0a) {
      fail('malformed PAX record boundary')
    }
    const record = decoder.decode(buffer.subarray(space + 1, end - 1))
    const equals = record.indexOf('=')
    if (equals <= 0) fail('malformed PAX key/value')
    const key = record.slice(0, equals)
    if (values.has(key)) fail(`duplicate PAX key: ${key}`)
    values.set(key, record.slice(equals + 1))
    offset = end
  }
  return values
}

const entries = []
let offset = 0
let zeroBlocks = 0
let pendingPax
let pendingLongPath

while (offset + BLOCK_SIZE <= tar.length) {
  const block = tar.subarray(offset, offset + BLOCK_SIZE)
  if (block.every(byte => byte === 0)) {
    zeroBlocks += 1
    offset += BLOCK_SIZE
    if (zeroBlocks === 2) break
    continue
  }
  if (zeroBlocks !== 0) fail('non-zero tar data follows an end marker')

  const expectedChecksum = parseOctal(block.subarray(148, 156), 'tar checksum')
  if (expectedChecksum !== headerChecksum(block)) fail('tar header checksum mismatch')

  const headerPath = rawHeaderPath(block)
  safeComponents(headerPath, { packageEntry: false })
  const size = parseOctal(block.subarray(124, 136), 'tar size')
  const mode = parseOctal(block.subarray(100, 108), 'tar mode')
  const type = String.fromCharCode(block[156] || 0x30)
  const dataStart = offset + BLOCK_SIZE
  const dataEnd = dataStart + size
  const paddedEnd = dataStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE
  if (dataEnd > tar.length || paddedEnd > tar.length) fail('truncated tar entry')
  const data = tar.subarray(dataStart, dataEnd)
  offset = paddedEnd

  if (type === 'g') fail('global PAX headers are not supported')
  if (type === 'x') {
    if (pendingPax !== undefined || pendingLongPath !== undefined) fail('stacked tar path metadata is not supported')
    pendingPax = parsePax(data)
    for (const key of pendingPax.keys()) {
      if (!['path', 'size', 'mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname'].includes(key)) {
        fail(`unsupported PAX key: ${key}`)
      }
    }
    continue
  }
  if (type === 'L') {
    if (pendingPax !== undefined || pendingLongPath !== undefined) fail('stacked tar path metadata is not supported')
    pendingLongPath = decodeString(data, 'GNU long path').replace(/\0+$/u, '')
    continue
  }
  if (type !== '0' && type !== '5') fail(`unsupported tar entry type: ${JSON.stringify(type)}`)

  let entryPath = pendingLongPath ?? pendingPax?.get('path') ?? headerPath
  if (pendingPax?.has('size') && Number(pendingPax.get('size')) !== size) {
    fail('PAX size does not match its tar header')
  }
  pendingPax = undefined
  pendingLongPath = undefined
  const components = safeComponents(entryPath, { packageEntry: true })
  entryPath = components.join('/')
  entries.push({ path: entryPath, components, type, mode, data: Buffer.from(data) })
}

if (zeroBlocks !== 2) fail('tar archive is missing its two-block end marker')
if (pendingPax !== undefined || pendingLongPath !== undefined) fail('dangling tar path metadata')
if (tar.subarray(offset).some(byte => byte !== 0)) fail('non-zero data follows the tar end marker')

const types = new Map()
for (const entry of entries) {
  if (types.has(entry.path)) fail(`duplicate archive entry: ${entry.path}`)
  types.set(entry.path, entry.type)
}
for (const entry of entries) {
  for (let length = 1; length < entry.components.length; length += 1) {
    const parent = entry.components.slice(0, length).join('/')
    if (types.get(parent) === '0') fail(`regular file is an ancestor of another entry: ${parent}`)
  }
}

mkdirSync(extractRoot, { recursive: false, mode: 0o755 })
for (const entry of entries) {
  const relative = entry.components.slice(1)
  const target = relative.length === 0 ? extractRoot : join(extractRoot, ...relative)
  if (entry.type === '5') {
    mkdirSync(target, { recursive: true, mode: 0o755 })
    chmodSync(target, entry.mode & 0o777)
    continue
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o755 })
  const descriptor = openSync(target, 'wx', entry.mode & 0o777)
  try {
    writeFileSync(descriptor, entry.data)
  } finally {
    closeSync(descriptor)
  }
  chmodSync(target, entry.mode & 0o777)
}
NODE

[[ -f "$stage_package/package.json" ]] || die 'patched package is missing package.json'
[[ -f "$stage_package/npm-shrinkwrap.json" ]] || die 'patched package is missing npm-shrinkwrap.json'
[[ -f "$stage_package/dist/cli.js" ]] || die 'patched package is missing dist/cli.js'
[[ -x "$stage_package/dist/cli.js" ]] || die 'patched package dist/cli.js is not executable'

cmp -s -- "$stage_package/package.json" "$stock_package_root/package.json" || die 'patched package.json differs from the stock installed package'
cmp -s -- "$stage_package/npm-shrinkwrap.json" "$stock_package_root/npm-shrinkwrap.json" || die 'patched npm-shrinkwrap.json differs from the stock installed package'

"$node_exec" --input-type=module - "$stage_package/package.json" <<'NODE' || die 'patched package manifest has the wrong package identity'
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(process.argv[2], 'utf8'))
if (manifest.name !== '@earendil-works/pi-coding-agent') {
  throw new Error('unexpected package name')
}
if (manifest.version !== '0.83.0') {
  throw new Error('unexpected package version')
}
if (
  manifest.bin === null ||
  typeof manifest.bin !== 'object' ||
  Array.isArray(manifest.bin) ||
  manifest.bin.pi !== 'dist/cli.js'
) {
  throw new Error('unexpected pi executable mapping')
}
NODE

ln -s -- "$DEPENDENCY_LINK" "$stage_package/node_modules"

"$node_exec" --input-type=module - "$stage_package" "$stock_dependency_root" "$DEPENDENCY_LINK" <<'NODE' || die 'patched dependency link failed canonical proof'
import { lstatSync, readlinkSync, realpathSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const [packageRoot, stockDependencyRoot, expectedLink] = process.argv.slice(2)
const links = []
function walk(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) {
      links.push(relative(packageRoot, path))
    } else if (stat.isDirectory()) {
      walk(path)
    }
  }
}
walk(packageRoot)
if (links.length !== 1 || links[0] !== 'node_modules') throw new Error('unexpected package symlink set')
const linkPath = join(packageRoot, 'node_modules')
if (readlinkSync(linkPath) !== expectedLink) throw new Error('dependency link is not the exact relative target')
if (realpathSync(linkPath) !== realpathSync(stockDependencyRoot)) throw new Error('dependency link resolves outside the supplied stock dependency root')
NODE

smoke_home="$download_root/smoke-home"
mkdir -p -- "$smoke_home"
"$node_exec" --input-type=module - "$stage_package/dist/cli.js" "$stage_package" "$smoke_home" <<'NODE' || die 'patched Pi CLI smoke failed'
import { mkdirSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const [cliInput, packageInput, smokeHome] = process.argv.slice(2)
const node = realpathSync(process.execPath)
const cli = realpathSync(cliInput)
const packageRoot = realpathSync(packageInput)
const smokeTmp = `${smokeHome}/tmp`
mkdirSync(smokeTmp, { recursive: true, mode: 0o700 })
const result = spawnSync(node, [cli, '--version'], {
  cwd: packageRoot,
  env: {
    HOME: smokeHome,
    XDG_CACHE_HOME: `${smokeHome}/cache`,
    XDG_CONFIG_HOME: `${smokeHome}/config`,
    XDG_DATA_HOME: `${smokeHome}/data`,
    TMPDIR: smokeTmp,
    LANG: 'C.UTF-8',
    TERM: 'dumb',
    NO_COLOR: '1'
  },
  encoding: 'utf8',
  timeout: 30_000
})
if (result.error !== undefined) throw result.error
if (result.status !== 0 || result.signal !== null) {
  throw new Error(`CLI smoke exited status=${String(result.status)} signal=${String(result.signal)} stderr=${result.stderr}`)
}
if (result.stdout !== '0.83.0\n' || result.stderr !== '') {
  throw new Error(
    `CLI smoke returned unexpected output stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`
  )
}
NODE

if [[ -e "$final_root" || -L "$final_root" ]]; then
  die "destination appeared during acquisition: $final_root"
fi
"$node_exec" --input-type=module - "$stage_root" "$final_root" <<'NODE' || die 'atomic patched package publication failed'
import { lstatSync, renameSync } from 'node:fs'

const [stageRoot, finalRoot] = process.argv.slice(2)
const staged = lstatSync(stageRoot)
try {
  lstatSync(finalRoot)
  throw new Error('final destination already exists')
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}
renameSync(stageRoot, finalRoot)
const published = lstatSync(finalRoot)
if (!published.isDirectory() || published.dev !== staged.dev || published.ino !== staged.ino) {
  throw new Error('published destination is not the staged directory identity')
}
NODE
stage_root=''
rmdir -- "$lock_root"
lock_root=''

printf '%s\n' "$final_root/package"
