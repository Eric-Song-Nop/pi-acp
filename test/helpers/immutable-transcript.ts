import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { constants, type Stats } from 'node:fs'
import { link, lstat, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { basename, isAbsolute, join, posix, relative, sep, win32 } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify, TextDecoder } from 'node:util'
import { z } from 'zod'
import type { AcpTranscriptEntry, AcpTranscriptJsonValue } from './acp-process-client.js'

const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u
const ARTIFACT_PATH_PATTERN = /^artifacts\/sha256-([0-9a-f]{64})\.ndjson$/u
const UUID_PATTERN = /(?<![0-9a-f])[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![0-9a-f])/iu
const NONCE_PATTERN = /(?<![0-9a-f])(?:[0-9a-f]{24}|[0-9a-f]{32})(?![0-9a-f])/iu
const LOOPBACK_PORT_PATTERN = /(?<![A-Za-z0-9])(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}(?!\d)/iu
const SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/iu,
  /\bBasic\s+[A-Za-z0-9+/=]{8,}/iu,
  /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{12,}(?![A-Za-z0-9_-])/u,
  /(?<![A-Za-z0-9_-])sk_(?:(?:agent|machine)_)?[A-Za-z0-9_-]{12,}(?![A-Za-z0-9_-])/u,
  /\b(?:gh[oprsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/u,
  /\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@/iu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u
] as const

const MAX_ARTIFACT_BYTES = 256 * 1024
const MAX_ARTIFACT_RECORDS = 256
const MAX_MANIFEST_BYTES = 256 * 1024
const PUBLICATION_READER_RETRY_MS = 5_000
const COMMITTED_FORBIDDEN_VALUES = ['C0_7_UNTRUSTED_PROMPT_CANARY'] as const
const ALLOWED_ABSOLUTE_SLASH_COMMANDS = new Set(['/fixture-state', '/poison', '/v1/chat/completions'])
const execFileAsync = promisify(execFile)

export const FIXTURE_ROOT_TOKEN = '<C0.7_FIXTURE_ROOT>'
export const SESSION_ID_TOKEN = '<C0.7_SESSION_ID>'
export const C0_7_TRANSCRIPT_ROOT = join(fileURLToPath(new URL('../e2e/transcripts/c0.7/', import.meta.url)), '.')

export function isCanonicalUtcDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  if (year < 2_000 || year > 9_999) return false
  const date = new Date(Date.UTC(year, month - 1, day))
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value
}

const sha256Schema = z.string().regex(SHA256_PATTERN)
const gitShaSchema = z.string().regex(GIT_SHA_PATTERN)
const canonicalDateSchema = z.string().refine(isCanonicalUtcDate, 'must be a real UTC calendar date')
const githubUrlSchema = z
  .string()
  .max(2_048)
  .url()
  .refine(value => {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      url.port === '' &&
      url.username === '' &&
      url.password === ''
    )
  }, 'must be an unauthenticated canonical https://github.com URL')

const artifactSchema = z
  .object({
    path: z.string().regex(ARTIFACT_PATH_PATTERN),
    sha256: sha256Schema,
    byteLength: z.number().int().positive().max(MAX_ARTIFACT_BYTES),
    recordCount: z.number().int().positive().max(MAX_ARTIFACT_RECORDS)
  })
  .strict()

const runtimeSchema = z
  .object({
    nodeVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
    platform: z.string().min(1).max(32),
    arch: z.string().min(1).max(32)
  })
  .strict()

const networkBoundarySchema = z
  .object({
    configuredLoopbackRequests: z.number().int().nonnegative(),
    osEgressDenied: z.literal(false)
  })
  .strict()

const clientSourceSchema = z
  .object({
    path: z.enum(['test/helpers/acp-process-client.ts', 'test/helpers/strict-catalog-client.ts']),
    sha256: sha256Schema
  })
  .strict()

const clientVersionSchema = z
  .object({
    kind: z.literal('git'),
    commit: gitShaSchema
  })
  .strict()

const clientCompatibilitySchema = z
  .object({
    id: z.enum(['raw-process-client', 'strict-catalog-client']),
    version: clientVersionSchema,
    sources: z.array(clientSourceSchema).min(1).max(2)
  })
  .strict()

const expectedFailureSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('command_not_advertised'),
      errorName: z.literal('CommandNotAdvertisedError'),
      commandName: z.literal('fixture-state'),
      advertisedNames: z.array(z.string().min(1)).min(1),
      outboundPromptDelta: z.literal(0)
    })
    .strict(),
  z
    .object({
      kind: z.literal('untrusted_project_prompt_expanded'),
      projectTrusted: z.literal(false),
      catalogHasCommand: z.literal(false),
      configuredLoopbackRequests: z.literal(1),
      literalSlashPersisted: z.literal(false),
      sessionUserMessage: z
        .object({
          matchCount: z.literal(1),
          byteLength: z.number().int().positive().max(4_096),
          sha256: sha256Schema
        })
        .strict(),
      providerRequest: z
        .object({
          count: z.literal(1),
          method: z.literal('POST'),
          path: z.literal('/v1/chat/completions'),
          bodyWithinLimit: z.literal(true),
          userMessage: z
            .object({
              matchCount: z.literal(1),
              byteLength: z.number().int().positive().max(4_096),
              sha256: sha256Schema
            })
            .strict()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      kind: z.literal('operation_timeout'),
      errorName: z.literal('AcpOperationTimeoutError'),
      operation: z.literal('session/prompt'),
      timeoutMs: z.number().int().min(250).max(5_000),
      configuredLoopbackRequests: z.literal(0),
      outboundPromptCount: z.literal(1),
      acpResponseCount: z.literal(0),
      remainedPendingThroughDeadline: z.literal(true),
      notification: z
        .object({
          sessionUpdate: z.literal('agent_message_chunk'),
          contentType: z.literal('text'),
          text: z.literal('Pi ACP fixture loaded'),
          level: z.literal('info'),
          afterPrompt: z.literal(true)
        })
        .strict(),
      processExit: z
        .object({
          code: z.literal(0),
          signal: z.null()
        })
        .strict()
    })
    .strict()
])

const transcriptCaseSchema = z
  .object({
    id: z.enum(['C0.7-XF01', 'C0.7-XF02', 'C0.7-XF03']),
    title: z.string().min(1).max(200),
    status: z.literal('xfail'),
    upstreamLedgerId: z.enum(['X-01', 'X-03']).nullable(),
    trackingUrl: githubUrlSchema,
    ownerCheckpoints: z
      .array(z.string().regex(/^C\d+\.\d+$/u))
      .min(1)
      .max(8),
    recheckTrigger: z.string().min(1).max(512),
    clientBehavior: z.enum(['raw', 'strict']),
    runtime: runtimeSchema,
    expectedFailure: expectedFailureSchema,
    networkBoundary: networkBoundarySchema,
    artifact: artifactSchema
  })
  .strict()

export const immutableTranscriptManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    planId: z.literal('PACP-CMD-2026-01'),
    checkpoint: z.literal('C0.7'),
    status: z.literal('blocked'),
    blockedBy: z
      .object({
        checkpoint: z.literal('C0.3'),
        reason: z.string().min(1).max(512),
        owner: z.string().min(1).max(128),
        trackingUrl: githubUrlSchema,
        recheckDate: canonicalDateSchema
      })
      .strict(),
    recordedAt: canonicalDateSchema,
    storagePolicy: z.literal('linux-darwin-localfs-nofollow-cas-v1'),
    capturePolicy: z
      .object({
        freshCaptureCount: z.literal(2),
        caseHardDeadlineMs: z.literal(30_000),
        loopbackBodyByteLimit: z.literal(65_536),
        loopbackBodyTimeoutMs: z.literal(2_000),
        loopbackCloseTimeoutMs: z.literal(1_000)
      })
      .strict(),
    compatibility: z
      .object({
        adapter: z
          .object({
            package: z.literal('pi-acp'),
            version: z.literal('0.0.33'),
            baselineGitHead: gitShaSchema
          })
          .strict(),
        pi: z
          .object({
            package: z.literal('@earendil-works/pi-coding-agent'),
            version: z.literal('0.83.0'),
            gitHead: gitShaSchema,
            lockIntegrity: z.string().startsWith('sha512-').max(256),
            installedTreeSha256: z.literal('623bc39816481c2fa15fe2140da0f4df1e865b97dfc69f39f44ba86cf7b0705f')
          })
          .strict(),
        acp: z
          .object({
            protocolVersion: z.literal(1),
            sdkPackage: z.literal('@agentclientprotocol/sdk'),
            sdkVersion: z.literal('0.26.0'),
            sdkGitHead: gitShaSchema,
            lockIntegrity: z.string().startsWith('sha512-').max(256),
            installedTreeSha256: z.literal('6b5a2d9876a3bac8861954fab54d4355a992be4a799bcfccfc6f6bc1737a5086')
          })
          .strict(),
        clients: z
          .object({
            repository: z.literal('https://github.com/Eric-Song-Nop/pi-acp'),
            raw: clientCompatibilitySchema,
            strict: clientCompatibilitySchema
          })
          .strict(),
        fixture: z
          .object({
            id: z.literal('pi-extension-pack-v1'),
            sources: z.tuple([
              z
                .object({
                  path: z.literal('test/fixtures/pi-extension-pack/index.ts'),
                  sha256: sha256Schema
                })
                .strict(),
              z
                .object({
                  path: z.literal('test/fixtures/pi-extension-pack/project-canary.js'),
                  sha256: sha256Schema
                })
                .strict()
            ])
          })
          .strict()
      })
      .strict(),
    recordingNodeVersions: z
      .array(z.string().regex(/^\d+\.\d+\.\d+$/u))
      .min(1)
      .max(8),
    cases: z.array(transcriptCaseSchema).length(3)
  })
  .strict()

export type ImmutableTranscriptManifest = z.infer<typeof immutableTranscriptManifestSchema>
export type ImmutableTranscriptCase = ImmutableTranscriptManifest['cases'][number]

export type CanonicalTranscript = {
  bytes: Buffer
  sha256: string
  recordCount: number
}

export type TranscriptNormalization = {
  fixtureRoot: string
  sessionId: string
  forbiddenValues: readonly string[]
}

const transcriptEntrySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('meta'),
      schemaVersion: z.literal(1),
      protocolVersion: z.literal(1),
      sdkVersion: z.literal('0.26.0'),
      nodeVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
      clientBehavior: z.enum(['raw', 'strict']),
      metadata: z.record(z.unknown())
    })
    .strict(),
  z
    .object({
      kind: z.literal('message'),
      seq: z.number().int().positive(),
      direction: z.enum(['client_to_agent', 'agent_to_client']),
      message: z.record(z.unknown()).refine(message => message.jsonrpc === '2.0', 'message jsonrpc must equal "2.0"')
    })
    .strict(),
  z
    .object({
      kind: z.literal('process_exit'),
      seq: z.number().int().positive(),
      code: z.number().int().nullable(),
      signal: z.string().nullable()
    })
    .strict()
])

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function stableJsonValue(value: unknown): AcpTranscriptJsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON numbers must be finite')
    return Object.is(value, -0) ? 0 : value
  }
  if (Array.isArray(value)) return value.map(item => stableJsonValue(item))
  if (typeof value !== 'object') throw new TypeError('canonical JSON values must be JSON-safe')

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('canonical JSON objects must have a plain or null prototype')
  }
  const result: Record<string, AcpTranscriptJsonValue> = Object.create(null)
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const property = (value as Record<string, unknown>)[key]
    if (property === undefined) continue
    result[key] = stableJsonValue(property)
  }
  return result
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(stableJsonValue(value))
}

export function canonicalManifestBytes(manifest: ImmutableTranscriptManifest): Buffer {
  const inputStructured = stableJsonValue(manifest)
  assertCanonicalStrings([inputStructured])
  assertNoSecrets(stringsIn(inputStructured), [], 'manifest')
  const parsed = immutableTranscriptManifestSchema.parse(manifest)
  const structured = stableJsonValue(parsed)
  const bytes = Buffer.from(`${JSON.stringify(structured, null, 2)}\n`)
  if (bytes.length > MAX_MANIFEST_BYTES) {
    throw new Error('C0.7 canonical manifest exceeds its byte limit')
  }
  return bytes
}

function assertTranscriptSequence(entries: readonly unknown[]): asserts entries is AcpTranscriptEntry[] {
  if (entries.length < 2 || entries.length > MAX_ARTIFACT_RECORDS) {
    throw new Error('C0.7 transcript record count is outside the accepted bounds')
  }
  const [metadata, ...sequenced] = entries as AcpTranscriptEntry[]
  if (metadata?.kind !== 'meta') throw new Error('C0.7 transcript must begin with exactly one meta record')
  if (sequenced.some(entry => entry.kind === 'meta')) {
    throw new Error('C0.7 transcript contains more than one meta record')
  }
  for (const [index, entry] of sequenced.entries()) {
    if (!('seq' in entry) || entry.seq !== index + 1) {
      throw new Error('C0.7 transcript sequence numbers must be contiguous')
    }
  }
  const processExits = sequenced.filter(entry => entry.kind === 'process_exit')
  if (processExits.length !== 1 || sequenced.at(-1)?.kind !== 'process_exit') {
    throw new Error('C0.7 transcript must end with exactly one process_exit record')
  }
}

function assertNoSecrets(values: readonly string[], forbiddenValues: readonly string[], phase: string): void {
  for (const transcriptValue of values) {
    for (const forbiddenValue of forbiddenValues) {
      if (forbiddenValue.length > 0 && transcriptValue.includes(forbiddenValue)) {
        throw new Error(`C0.7 ${phase} transcript contains a forbidden exact value`)
      }
    }
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(transcriptValue)) {
        throw new Error(`C0.7 ${phase} transcript contains credential-shaped data`)
      }
    }
  }
}

function normalizeString(value: string, normalization: TranscriptNormalization): string {
  if (value === normalization.sessionId) return SESSION_ID_TOKEN
  if (value === normalization.fixtureRoot) return FIXTURE_ROOT_TOKEN
  const prefix = `${normalization.fixtureRoot}${sep}`
  if (value.startsWith(prefix)) {
    const suffix = value.slice(prefix.length).split(sep).join('/')
    return `${FIXTURE_ROOT_TOKEN}/${suffix}`
  }
  return value
}

function normalizeValue(value: AcpTranscriptJsonValue, normalization: TranscriptNormalization): AcpTranscriptJsonValue {
  if (typeof value === 'string') return normalizeString(value, normalization)
  if (Array.isArray(value)) return value.map(item => normalizeValue(item, normalization))
  if (value && typeof value === 'object') {
    const result: Record<string, AcpTranscriptJsonValue> = Object.create(null)
    for (const [key, property] of Object.entries(value)) {
      result[key] = normalizeValue(property, normalization)
    }
    return result
  }
  return value
}

function stringsIn(value: AcpTranscriptJsonValue): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(item => stringsIn(item))
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => [key, ...stringsIn(item)])
  }
  return []
}

function keysIn(value: AcpTranscriptJsonValue): string[] {
  if (Array.isArray(value)) return value.flatMap(item => keysIn(item))
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => [key, ...keysIn(item)])
  }
  return []
}

function semanticTranscriptTextStreams(entries: readonly AcpTranscriptJsonValue[]): string[] {
  const streams = new Map<string, string>()
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || entry.kind !== 'message') continue
    const message = entry.message
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.method !== 'session/update') {
      continue
    }
    const params = message.params
    if (!params || typeof params !== 'object' || Array.isArray(params)) continue
    const update = params.update
    if (!update || typeof update !== 'object' || Array.isArray(update)) continue
    const content = update.content
    if (
      typeof params.sessionId !== 'string' ||
      typeof update.sessionUpdate !== 'string' ||
      !content ||
      typeof content !== 'object' ||
      Array.isArray(content) ||
      content.type !== 'text' ||
      typeof content.text !== 'string'
    ) {
      continue
    }
    const key = `${params.sessionId}\u0000${update.sessionUpdate}`
    streams.set(key, `${streams.get(key) ?? ''}${content.text}`)
  }
  return [...streams.values()]
}

function transcriptStrings(entries: readonly AcpTranscriptJsonValue[]): string[] {
  return [...entries.flatMap(entry => stringsIn(entry)), ...semanticTranscriptTextStreams(entries)]
}

function assertReservedTokenPlacement(value: AcpTranscriptJsonValue, propertyName?: string): void {
  if (typeof value === 'string') {
    if (value.includes(SESSION_ID_TOKEN) && !(propertyName === 'sessionId' && value === SESSION_ID_TOKEN)) {
      throw new Error('C0.7 canonical transcript contains a session token outside a sessionId field')
    }
    if (value.includes(FIXTURE_ROOT_TOKEN) && propertyName !== 'cwd') {
      throw new Error('C0.7 canonical transcript contains a fixture-root token outside a cwd field')
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) assertReservedTokenPlacement(item)
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) assertReservedTokenPlacement(item, key)
}

function assertNoPortFields(value: AcpTranscriptJsonValue): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoPortFields(item)
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    const numericPort =
      (typeof item === 'number' && Number.isInteger(item) && item >= 1 && item <= 65_535) ||
      (typeof item === 'string' && /^\d{1,5}$/u.test(item) && Number(item) >= 1 && Number(item) <= 65_535)
    if (/port/iu.test(key) && numericPort) {
      throw new Error('C0.7 canonical transcript contains an unnormalized port field')
    }
    assertNoPortFields(item)
  }
}

function assertCanonicalStrings(entries: AcpTranscriptJsonValue[]): void {
  for (const entry of entries) {
    assertNoPortFields(entry)
    assertReservedTokenPlacement(entry)
  }
  if (
    semanticTranscriptTextStreams(entries).some(
      value => value.includes(FIXTURE_ROOT_TOKEN) || value.includes(SESSION_ID_TOKEN)
    )
  ) {
    throw new Error('C0.7 canonical transcript contains a reserved token in a rendered text stream')
  }
  if (
    entries
      .flatMap(entry => keysIn(entry))
      .some(key => key.includes(FIXTURE_ROOT_TOKEN) || key.includes(SESSION_ID_TOKEN))
  ) {
    throw new Error('C0.7 canonical transcript contains a reserved token in a property name')
  }
  for (const value of transcriptStrings(entries)) {
    const hasFixtureRoot = value.includes(FIXTURE_ROOT_TOKEN)
    const hasSessionId = value.includes(SESSION_ID_TOKEN)
    if (hasSessionId && value !== SESSION_ID_TOKEN) {
      throw new Error('C0.7 canonical transcript contains a malformed session token')
    }
    if (hasFixtureRoot) {
      const suffix = value.slice(FIXTURE_ROOT_TOKEN.length)
      if (
        !value.startsWith(FIXTURE_ROOT_TOKEN) ||
        value.indexOf(FIXTURE_ROOT_TOKEN, FIXTURE_ROOT_TOKEN.length) !== -1 ||
        hasSessionId ||
        (suffix !== '' && !suffix.startsWith('/')) ||
        (suffix !== '' && !/^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(suffix)) ||
        suffix.includes('\\') ||
        suffix.split('/').includes('..')
      ) {
        throw new Error('C0.7 canonical transcript contains a malformed fixture-root token')
      }
    }
    if (hasSessionId) {
      continue
    }
    const isAllowedSlashCommand = ALLOWED_ABSOLUTE_SLASH_COMMANDS.has(value)
    const hasEmbeddedPosixPath = /(?<![\p{L}\p{N}._~@%+/-])\/(?![/\s])/u.test(value)
    const hasEmbeddedWindowsPath = /(?<![A-Za-z0-9._~@%+\\/-])(?:[A-Za-z]:[\\/]|\\\\(?:\?\\)?[^\\\s]+\\[^\\\s]+)/u.test(
      value
    )
    const hasEmbeddedForwardUnc = /(?<![\p{L}\p{N}._~@%+:/-])\/\/(?!\/)[^/\s]+\/[^/\s]+/u.test(value)
    const hasEmbeddedRootBackslash = /(?<![\p{L}\p{N}._~@%+\\/-])\\(?!\\|\s)[^\\\s]+\\[^\\\s]+/u.test(value)
    const hasEmbeddedFileUrl = /(?<![A-Za-z0-9._~@%+-])file:\/\//iu.test(value)
    if (
      ((posix.isAbsolute(value) || win32.isAbsolute(value) || /^file:\/\//iu.test(value)) &&
        !isAllowedSlashCommand &&
        !hasFixtureRoot) ||
      (!isAllowedSlashCommand &&
        !hasFixtureRoot &&
        (hasEmbeddedPosixPath ||
          hasEmbeddedWindowsPath ||
          hasEmbeddedForwardUnc ||
          hasEmbeddedRootBackslash ||
          hasEmbeddedFileUrl))
    ) {
      throw new Error('C0.7 canonical transcript contains an unapproved absolute path')
    }
    if (UUID_PATTERN.test(value)) {
      throw new Error('C0.7 canonical transcript contains an unnormalized UUID')
    }
    if (NONCE_PATTERN.test(value)) {
      throw new Error('C0.7 canonical transcript contains an unnormalized nonce')
    }
    if (LOOPBACK_PORT_PATTERN.test(value)) {
      throw new Error('C0.7 canonical transcript contains an unnormalized loopback port')
    }
  }
}

export function canonicalizeTranscript(
  entries: readonly AcpTranscriptEntry[],
  normalization: TranscriptNormalization
): CanonicalTranscript {
  if (!isAbsolute(normalization.fixtureRoot)) {
    throw new TypeError('C0.7 fixture root must be absolute')
  }
  if (normalization.sessionId.length === 0) {
    throw new TypeError('C0.7 session ID must be non-empty')
  }
  assertTranscriptSequence(entries)

  const rawValues = entries.map(entry => stableJsonValue(entry))
  const rawSource = rawValues.map(entry => JSON.stringify(entry)).join('\n')
  if (
    rawSource.includes(FIXTURE_ROOT_TOKEN) ||
    rawSource.includes(SESSION_ID_TOKEN) ||
    semanticTranscriptTextStreams(rawValues).some(
      value => value.includes(FIXTURE_ROOT_TOKEN) || value.includes(SESSION_ID_TOKEN)
    )
  ) {
    throw new Error('C0.7 raw transcript contains a reserved normalization token')
  }
  assertNoSecrets(transcriptStrings(rawValues), normalization.forbiddenValues, 'raw')

  const normalized = rawValues.map(entry => normalizeValue(entry, normalization))
  assertCanonicalStrings(normalized)
  const source = `${normalized.map(entry => canonicalJson(entry)).join('\n')}\n`
  const bytes = Buffer.from(source)
  if (bytes.length > MAX_ARTIFACT_BYTES) {
    throw new Error('C0.7 canonical transcript exceeds its byte limit')
  }
  assertNoSecrets(transcriptStrings(normalized), normalization.forbiddenValues, 'canonical')
  return {
    bytes,
    sha256: digest(bytes),
    recordCount: normalized.length
  }
}

export function parseCanonicalTranscript(bytes: Buffer): AcpTranscriptEntry[] {
  if (bytes.length === 0 || bytes.length > MAX_ARTIFACT_BYTES) {
    throw new Error('C0.7 artifact byte length is outside the accepted bounds')
  }
  const source = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true
  }).decode(bytes)
  if (source.startsWith('\uFEFF') || source.includes('\r')) {
    throw new Error('C0.7 artifact must be BOM-free LF-only UTF-8')
  }
  if (!source.endsWith('\n') || source.endsWith('\n\n')) {
    throw new Error('C0.7 artifact must have exactly one final LF')
  }
  const lines = source.slice(0, -1).split('\n')
  if (lines.some(line => line.length === 0)) {
    throw new Error('C0.7 artifact must not contain blank records')
  }
  const records = lines.map((line, index) => {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch (error) {
      throw new Error(`C0.7 artifact record ${String(index + 1)} is not JSON`, {
        cause: error
      })
    }
    if (canonicalJson(value) !== line) {
      throw new Error(`C0.7 artifact record ${String(index + 1)} is not canonical JSON`)
    }
    const validation = transcriptEntrySchema.safeParse(value)
    if (!validation.success) {
      throw new Error(`C0.7 artifact record ${String(index + 1)} has an invalid transcript shape`, {
        cause: validation.error
      })
    }
    return value as AcpTranscriptEntry
  })
  assertTranscriptSequence(records)
  const structured = records.map(record => stableJsonValue(record))
  assertCanonicalStrings(structured)
  assertNoSecrets(transcriptStrings(structured), COMMITTED_FORBIDDEN_VALUES, 'committed')
  return records
}

function assertRegularFile(
  path: string,
  stat: Stats,
  maximumBytes: number,
  allowedLinkCounts: readonly number[] = [1]
): void {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`C0.7 evidence must be a regular file: ${path}`)
  }
  if (!allowedLinkCounts.includes(stat.nlink)) {
    throw new Error(`C0.7 evidence has an unapproved hard-link count: ${path}`)
  }
  if (stat.size <= 0 || stat.size > maximumBytes) {
    throw new Error(`C0.7 evidence size is outside the accepted bounds: ${path}`)
  }
  if (process.platform !== 'win32') {
    if ((stat.mode & 0o022) !== 0) {
      throw new Error(`C0.7 evidence must not be group/world writable: ${path}`)
    }
    if (process.getuid && stat.uid !== process.getuid()) {
      throw new Error(`C0.7 evidence owner must match the reader: ${path}`)
    }
  }
}

function assertSameIdentity(expected: Stats, actual: Stats, path: string): void {
  if (
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.size !== expected.size ||
    actual.mtimeMs !== expected.mtimeMs
  ) {
    throw new Error(`C0.7 evidence changed while it was read: ${path}`)
  }
}

async function readVerifiedFile(
  path: string,
  maximumBytes: number,
  allowedLinkCounts: readonly number[] = [1]
): Promise<Buffer> {
  const pathStat = await lstat(path)
  assertRegularFile(path, pathStat, maximumBytes, allowedLinkCounts)
  const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW
  const handle = await open(path, constants.O_RDONLY | noFollow)
  try {
    const openedStat = await handle.stat()
    assertRegularFile(path, openedStat, maximumBytes, allowedLinkCounts)
    assertSameIdentity(pathStat, openedStat, path)
    const bytes = await handle.readFile()
    if (bytes.length !== openedStat.size) {
      throw new Error(`C0.7 evidence length changed while it was read: ${path}`)
    }
    assertSameIdentity(openedStat, await handle.stat(), path)
    assertSameIdentity(openedStat, await lstat(path), path)
    return bytes
  } finally {
    await handle.close()
  }
}

function assertContainedPath(parent: string, candidate: string): void {
  const relativePath = relative(parent, candidate)
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`C0.7 evidence path escapes its directory: ${candidate}`)
  }
}

async function assertEvidenceDirectories(root: string): Promise<void> {
  const canonicalRoot = await realpath(root)
  if (canonicalRoot !== root) throw new Error('C0.7 transcript root must be canonical')
  const artifactDirectory = join(root, 'artifacts')
  const canonicalArtifacts = await realpath(artifactDirectory)
  assertContainedPath(canonicalRoot, canonicalArtifacts)

  for (const path of [root, artifactDirectory]) {
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`C0.7 evidence ancestor must be a real directory: ${path}`)
    }
    if (process.platform !== 'win32') {
      if ((stat.mode & 0o022) !== 0) {
        throw new Error(`C0.7 evidence ancestor must not be group/world writable: ${path}`)
      }
      if (process.getuid && stat.uid !== process.getuid()) {
        throw new Error(`C0.7 evidence ancestor owner must match the reader: ${path}`)
      }
    }
  }
}

function validateManifestRelationships(manifest: ImmutableTranscriptManifest): void {
  if (manifest.blockedBy.recheckDate < manifest.recordedAt) {
    throw new Error('C0.7 blocker recheck date must not precede the recording date')
  }
  const ids = manifest.cases.map(item => item.id)
  const sortedIds = [...ids].sort()
  if (new Set(ids).size !== ids.length || ids.some((id, index) => id !== sortedIds[index])) {
    throw new Error('C0.7 manifest cases must be unique and sorted by ID')
  }
  for (const item of manifest.cases) {
    const pathMatch = ARTIFACT_PATH_PATTERN.exec(item.artifact.path)
    if (!pathMatch || pathMatch[1] !== item.artifact.sha256) {
      throw new Error(`C0.7 artifact path does not match its digest for ${item.id}`)
    }
    if (
      item.networkBoundary.configuredLoopbackRequests !==
      (item.expectedFailure.kind === 'command_not_advertised' ? 0 : item.expectedFailure.configuredLoopbackRequests)
    ) {
      throw new Error(`C0.7 loopback request evidence disagrees for ${item.id}`)
    }
    const identityMatches =
      (item.id === 'C0.7-XF01' &&
        item.clientBehavior === 'strict' &&
        item.upstreamLedgerId === 'X-01' &&
        item.trackingUrl === 'https://github.com/svkozak/pi-acp/pull/20' &&
        canonicalJson(item.ownerCheckpoints) === canonicalJson(['C2.3']) &&
        item.expectedFailure.kind === 'command_not_advertised') ||
      (item.id === 'C0.7-XF02' &&
        item.clientBehavior === 'raw' &&
        item.upstreamLedgerId === null &&
        item.trackingUrl === 'https://github.com/Eric-Song-Nop/pi-acp/issues/6' &&
        canonicalJson(item.ownerCheckpoints) === canonicalJson(['C1.6', 'C2.2', 'C5.8']) &&
        item.expectedFailure.kind === 'untrusted_project_prompt_expanded') ||
      (item.id === 'C0.7-XF03' &&
        item.clientBehavior === 'raw' &&
        item.upstreamLedgerId === 'X-03' &&
        item.trackingUrl === 'https://github.com/svkozak/pi-acp/issues/84' &&
        canonicalJson(item.ownerCheckpoints) === canonicalJson(['C3.4']) &&
        item.expectedFailure.kind === 'operation_timeout')
    if (!identityMatches) {
      throw new Error(`C0.7 manifest case identity is inconsistent for ${item.id}`)
    }
    if (
      item.expectedFailure.kind === 'command_not_advertised' &&
      canonicalJson(item.expectedFailure.advertisedNames) !==
        canonicalJson(['compact', 'autocompact', 'export', 'session', 'name', 'steering', 'follow-up', 'changelog'])
    ) {
      throw new Error('C0.7-XF01 must bind the exact frozen catalog without fixture-state')
    }
    if (
      item.expectedFailure.kind === 'untrusted_project_prompt_expanded' &&
      (item.expectedFailure.sessionUserMessage.byteLength !==
        item.expectedFailure.providerRequest.userMessage.byteLength ||
        item.expectedFailure.sessionUserMessage.sha256 !== item.expectedFailure.providerRequest.userMessage.sha256 ||
        item.expectedFailure.sessionUserMessage.byteLength !== 29 ||
        item.expectedFailure.sessionUserMessage.sha256 !==
          'e5e3815c2cd60916b0f73896826b76d7a4bc2977bbab196fbb4a69f5569268e1')
    ) {
      throw new Error('C0.7-XF02 session and provider observations must bind the same frozen prompt value')
    }
    if (item.expectedFailure.kind === 'operation_timeout' && item.expectedFailure.timeoutMs !== 1_500) {
      throw new Error('C0.7-XF03 must bind the exact 1500ms observation deadline')
    }
  }

  const recordingNodeVersions = [...manifest.recordingNodeVersions]
  const caseNodeVersions = [...new Set(manifest.cases.map(item => item.runtime.nodeVersion))].sort()
  if (
    new Set(recordingNodeVersions).size !== recordingNodeVersions.length ||
    recordingNodeVersions.some((version, index) => version !== [...recordingNodeVersions].sort()[index]) ||
    recordingNodeVersions.length !== caseNodeVersions.length ||
    recordingNodeVersions.some((version, index) => version !== caseNodeVersions[index])
  ) {
    throw new Error('C0.7 recording Node versions must be the unique sorted case runtimes')
  }
  if (new Set(manifest.cases.map(item => item.artifact.sha256)).size !== manifest.cases.length) {
    throw new Error('C0.7 cases must not alias one artifact')
  }

  const rawSources = manifest.compatibility.clients.raw.sources
  const strictSources = manifest.compatibility.clients.strict.sources
  if (
    manifest.compatibility.clients.raw.id !== 'raw-process-client' ||
    manifest.compatibility.clients.strict.id !== 'strict-catalog-client' ||
    manifest.compatibility.clients.raw.version.commit !== manifest.compatibility.adapter.baselineGitHead ||
    manifest.compatibility.clients.strict.version.commit !== manifest.compatibility.adapter.baselineGitHead ||
    rawSources.length !== 1 ||
    rawSources[0]?.path !== 'test/helpers/acp-process-client.ts' ||
    strictSources.length !== 2 ||
    strictSources[0]?.path !== 'test/helpers/acp-process-client.ts' ||
    strictSources[1]?.path !== 'test/helpers/strict-catalog-client.ts' ||
    rawSources[0]?.sha256 !== strictSources[0]?.sha256
  ) {
    throw new Error('C0.7 client identities must bind the canonical raw/strict source sets')
  }
}

export function validateImmutableManifest(value: unknown): ImmutableTranscriptManifest {
  const manifest = immutableTranscriptManifestSchema.parse(value)
  validateManifestRelationships(manifest)
  return manifest
}

export async function readVerifiedManifest(
  root = C0_7_TRANSCRIPT_ROOT
): Promise<{ manifest: ImmutableTranscriptManifest; bytes: Buffer; sha256: string }> {
  await assertEvidenceDirectories(root)
  const path = join(root, 'manifest.json')
  const bytes = await readVerifiedFile(path, MAX_MANIFEST_BYTES)
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
  } catch (error) {
    throw new Error('C0.7 manifest is not valid UTF-8 JSON', { cause: error })
  }
  const rawStructured = stableJsonValue(value)
  assertCanonicalStrings([rawStructured])
  assertNoSecrets(stringsIn(rawStructured), [], 'manifest')
  const manifest = validateImmutableManifest(value)
  if (!bytes.equals(canonicalManifestBytes(manifest))) {
    throw new Error('C0.7 manifest is not canonical JSON')
  }
  return { manifest, bytes, sha256: digest(bytes) }
}

export async function readVerifiedArtifact(
  root: string,
  item: ImmutableTranscriptCase
): Promise<{ bytes: Buffer; records: AcpTranscriptEntry[] }> {
  const pathMatch = ARTIFACT_PATH_PATTERN.exec(item.artifact.path)
  if (!pathMatch || pathMatch[1] !== item.artifact.sha256) {
    throw new Error(`C0.7 artifact path does not match its digest for ${item.id}`)
  }
  const path = join(root, item.artifact.path)
  assertContainedPath(await realpath(join(root, 'artifacts')), await realpath(path))
  const bytes = await readVerifiedFile(path, MAX_ARTIFACT_BYTES)
  if (bytes.length !== item.artifact.byteLength || digest(bytes) !== item.artifact.sha256) {
    throw new Error(`C0.7 artifact bytes do not match the manifest for ${item.id}`)
  }
  const records = parseCanonicalTranscript(bytes)
  if (records.length !== item.artifact.recordCount) {
    throw new Error(`C0.7 artifact record count does not match for ${item.id}`)
  }
  return { bytes, records }
}

function assertArtifactMetadataMatchesManifest(
  manifest: ImmutableTranscriptManifest,
  item: ImmutableTranscriptCase,
  records: readonly AcpTranscriptEntry[]
): void {
  const metadata = records[0]
  const clientIdentity = manifest.compatibility.clients[item.clientBehavior]
  const expectedMetadataKeys = [
    'arch',
    'baselineGitHead',
    'caseId',
    'checkpoint',
    'client',
    'clientSources',
    'clientVersion',
    'fixtureId',
    'fixtureSources',
    'piAcpVersion',
    'piGitHead',
    'piInstalledTreeSha256',
    'piLockIntegrity',
    'piVersion',
    'planId',
    'platform',
    'sdkGitHead',
    'sdkInstalledTreeSha256',
    'sdkLockIntegrity'
  ]
  if (
    metadata.kind !== 'meta' ||
    metadata.protocolVersion !== manifest.compatibility.acp.protocolVersion ||
    metadata.sdkVersion !== manifest.compatibility.acp.sdkVersion ||
    metadata.nodeVersion !== item.runtime.nodeVersion ||
    metadata.clientBehavior !== item.clientBehavior ||
    metadata.metadata.planId !== manifest.planId ||
    metadata.metadata.checkpoint !== manifest.checkpoint ||
    metadata.metadata.caseId !== item.id ||
    metadata.metadata.fixtureId !== manifest.compatibility.fixture.id ||
    metadata.metadata.piAcpVersion !== manifest.compatibility.adapter.version ||
    metadata.metadata.piVersion !== manifest.compatibility.pi.version ||
    metadata.metadata.baselineGitHead !== manifest.compatibility.adapter.baselineGitHead ||
    metadata.metadata.piGitHead !== manifest.compatibility.pi.gitHead ||
    metadata.metadata.piInstalledTreeSha256 !== manifest.compatibility.pi.installedTreeSha256 ||
    metadata.metadata.piLockIntegrity !== manifest.compatibility.pi.lockIntegrity ||
    metadata.metadata.sdkGitHead !== manifest.compatibility.acp.sdkGitHead ||
    metadata.metadata.sdkInstalledTreeSha256 !== manifest.compatibility.acp.installedTreeSha256 ||
    metadata.metadata.sdkLockIntegrity !== manifest.compatibility.acp.lockIntegrity ||
    metadata.metadata.client !== clientIdentity.id ||
    metadata.metadata.clientVersion !== `git:${clientIdentity.version.commit}` ||
    canonicalJson(metadata.metadata.clientSources) !== canonicalJson(clientIdentity.sources) ||
    canonicalJson(metadata.metadata.fixtureSources) !== canonicalJson(manifest.compatibility.fixture.sources) ||
    metadata.metadata.platform !== item.runtime.platform ||
    metadata.metadata.arch !== item.runtime.arch ||
    canonicalJson(Object.keys(metadata.metadata).sort()) !== canonicalJson(expectedMetadataKeys)
  ) {
    throw new Error(`C0.7 artifact metadata does not match the manifest for ${item.id}`)
  }
}

function fileIdentityKey(stat: Stats): string {
  return `${String(stat.dev)}:${String(stat.ino)}`
}

async function verifyArtifactDirectory(root: string, allowRecoverableTemporaries = false): Promise<Set<string>> {
  const artifactEntries = await readdir(join(root, 'artifacts'), {
    withFileTypes: true
  })
  const recoverableTwoLinkIdentities = new Set<string>()
  if (allowRecoverableTemporaries) {
    for (const entry of artifactEntries) {
      if (!/^\.artifact-\d+-[0-9a-f]{24}\.tmp$/u.test(entry.name)) continue
      const temporaryPath = join(root, 'artifacts', entry.name)
      const stat = await lstat(temporaryPath)
      if (
        !entry.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink < 1 ||
        stat.nlink > 2 ||
        (process.getuid && stat.uid !== process.getuid())
      ) {
        throw new Error('C0.7 recoverable artifact temporary has an unsafe identity')
      }
      if (stat.nlink === 1) continue
      if ((stat.mode & 0o222) !== 0 || stat.size <= 0 || stat.size > MAX_ARTIFACT_BYTES) {
        throw new Error('C0.7 recoverable linked artifact temporary is not immutable')
      }
      const bytes = await readVerifiedFile(temporaryPath, MAX_ARTIFACT_BYTES, [2])
      parseCanonicalTranscript(bytes)
      const finalPath = join(root, 'artifacts', `sha256-${digest(bytes)}.ndjson`)
      const finalStat = await lstat(finalPath)
      if (
        finalStat.dev !== stat.dev ||
        finalStat.ino !== stat.ino ||
        finalStat.nlink !== 2 ||
        !finalStat.isFile() ||
        finalStat.isSymbolicLink()
      ) {
        throw new Error('C0.7 recoverable linked artifact temporary has no matching final path')
      }
      recoverableTwoLinkIdentities.add(fileIdentityKey(stat))
    }
  }
  const artifactNames = new Set<string>()
  for (const entry of artifactEntries) {
    if (allowRecoverableTemporaries && /^\.artifact-\d+-[0-9a-f]{24}\.tmp$/u.test(entry.name)) {
      continue
    }
    const match = /^sha256-([0-9a-f]{64})\.ndjson$/u.exec(entry.name)
    if (!entry.isFile() || !match) {
      throw new Error('C0.7 artifact directory contains an unapproved entry')
    }
    const path = join(root, 'artifacts', entry.name)
    const stat = await lstat(path)
    const allowedLinkCounts = stat.nlink === 2 && recoverableTwoLinkIdentities.has(fileIdentityKey(stat)) ? [2] : [1]
    const bytes = await readVerifiedFile(path, MAX_ARTIFACT_BYTES, allowedLinkCounts)
    if (digest(bytes) !== match[1]) {
      throw new Error('C0.7 artifact directory contains a digest-mismatched file')
    }
    parseCanonicalTranscript(bytes)
    artifactNames.add(entry.name)
  }
  return artifactNames
}

async function verifyCommittedTranscriptsUnlocked(
  root: string,
  allowRecoverableTemporaries = false
): Promise<ImmutableTranscriptManifest> {
  const { manifest } = await readVerifiedManifest(root)
  const expectedArtifactNames = new Set(manifest.cases.map(item => basename(item.artifact.path)))
  const artifactNames = await verifyArtifactDirectory(root, allowRecoverableTemporaries)
  if ([...expectedArtifactNames].some(name => !artifactNames.has(name))) {
    throw new Error('C0.7 artifact directory is missing a manifest-referenced file')
  }
  const digests = new Set<string>()
  for (const item of manifest.cases) {
    if (digests.has(item.artifact.sha256)) {
      throw new Error(`C0.7 cases must not alias one artifact: ${item.id}`)
    }
    digests.add(item.artifact.sha256)
    const { records } = await readVerifiedArtifact(root, item)
    assertArtifactMetadataMatchesManifest(manifest, item, records)
  }
  return manifest
}

type PublicationLockSnapshot =
  | { state: 'absent' }
  | { state: 'live' | 'stale'; dev: number | bigint; ino: number | bigint }

async function publicationLockSnapshot(root: string): Promise<PublicationLockSnapshot> {
  const path = join(root, '.update.lock')
  try {
    const owner = await readLockOwner(path)
    let sameProcessInstance = false
    if (processExists(owner.pid)) {
      try {
        sameProcessInstance = (await processStartSha256(owner.pid)) === owner.processStartSha256
      } catch {
        sameProcessInstance = true
      }
    }
    return {
      state: sameProcessInstance ? 'live' : 'stale',
      dev: owner.stat.dev,
      ino: owner.stat.ino
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' }
    throw error
  }
}

function sameLockSnapshot(left: PublicationLockSnapshot, right: PublicationLockSnapshot): boolean {
  return (
    left.state === right.state &&
    (left.state === 'absent' || (right.state !== 'absent' && left.dev === right.dev && left.ino === right.ino))
  )
}

export async function verifyCommittedTranscripts(root = C0_7_TRANSCRIPT_ROOT): Promise<ImmutableTranscriptManifest> {
  const deadline = Date.now() + PUBLICATION_READER_RETRY_MS
  let lastError: unknown
  for (;;) {
    const lockBefore = await publicationLockSnapshot(root)
    try {
      const manifest = await verifyCommittedTranscriptsUnlocked(root, lockBefore.state === 'stale')
      const lockAfter = await publicationLockSnapshot(root)
      if (
        (lockBefore.state === 'absent' && lockAfter.state === 'absent') ||
        (lockBefore.state === 'stale' && sameLockSnapshot(lockBefore, lockAfter))
      ) {
        return manifest
      }
    } catch (error) {
      lastError = error
      const lockAfter = await publicationLockSnapshot(root)
      if (
        (lockBefore.state === 'absent' && lockAfter.state === 'absent') ||
        (lockBefore.state === 'stale' && sameLockSnapshot(lockBefore, lockAfter))
      ) {
        throw error
      }
    }
    if (Date.now() >= deadline) {
      throw new AggregateError(
        lastError === undefined ? [] : [lastError],
        'C0.7 evidence verification could not obtain a stable publication view'
      )
    }
    await delay(25)
  }
}

export function sha256(bytes: Uint8Array): string {
  return digest(bytes)
}

export type PublishTranscriptUpdateOptions = {
  root?: string
  expectedOldManifestSha256: string | 'absent'
  manifest: ImmutableTranscriptManifest
  artifacts: ReadonlyMap<string, Buffer>
}

async function currentManifestSha256(root: string): Promise<string | 'absent'> {
  try {
    return digest(await readVerifiedFile(join(root, 'manifest.json'), MAX_MANIFEST_BYTES))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
    throw error
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directoryFlag = process.platform === 'win32' ? 0 : constants.O_DIRECTORY
  const handle = await open(path, constants.O_RDONLY | directoryFlag)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

type PublicationLock = {
  handle: Awaited<ReturnType<typeof open>>
  stat: Stats
  path: string
}

type LockOwner = {
  pid: number
  processStartSha256: string
  stat: Stats
}

async function processStartSha256(pid: number): Promise<string> {
  if (process.platform === 'linux') {
    const [source, bootIdSource] = await Promise.all([
      readFile(`/proc/${String(pid)}/stat`, 'utf8'),
      readFile('/proc/sys/kernel/random/boot_id', 'utf8')
    ])
    const closeParenthesis = source.lastIndexOf(')')
    if (closeParenthesis < 0) {
      throw new Error('C0.7 updater could not parse the Linux process-instance identity')
    }
    const fieldsAfterCommand = source
      .slice(closeParenthesis + 1)
      .trim()
      .split(/\s+/u)
    const startTimeTicks = fieldsAfterCommand[19]
    if (!startTimeTicks || !/^\d+$/u.test(startTimeTicks)) {
      throw new Error('C0.7 updater could not resolve the Linux process-instance identity')
    }
    const bootId = bootIdSource.trim().toLowerCase()
    if (!UUID_PATTERN.test(bootId) || bootId.length !== 36) {
      throw new Error('C0.7 updater could not resolve the Linux boot identity')
    }
    return digest(Buffer.from(`linux-boot:${bootId}\u0000proc-starttime:${startTimeTicks}`))
  }
  if (process.platform !== 'darwin') {
    throw new Error('C0.7 transcript publication supports Linux /proc and Darwin process identities')
  }
  const { stdout } = await execFileAsync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      LC_ALL: 'C',
      LANG: 'C',
      TZ: 'UTC'
    }
  })
  const normalized = stdout.trim().replace(/\s+/gu, ' ')
  if (normalized.length === 0 || normalized.length > 128) {
    throw new Error('C0.7 updater could not resolve the process-instance identity')
  }
  return digest(Buffer.from(normalized))
}

async function readLockOwner(path: string): Promise<LockOwner> {
  const pathStat = await lstat(path)
  if (
    !pathStat.isFile() ||
    pathStat.isSymbolicLink() ||
    pathStat.nlink < 1 ||
    pathStat.nlink > 2 ||
    pathStat.size <= 0 ||
    pathStat.size > 256 ||
    (pathStat.mode & 0o077) !== 0 ||
    (process.getuid && pathStat.uid !== process.getuid())
  ) {
    throw new Error('C0.7 updater lock has an invalid identity')
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const openedStat = await handle.stat()
    assertSameIdentity(pathStat, openedStat, path)
    const source = (await handle.readFile()).toString('utf8')
    let value: unknown
    try {
      value = JSON.parse(source)
    } catch {
      throw new Error('C0.7 updater lock owner is invalid')
    }
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join('\0') !== 'pid\0processStartSha256' ||
      !Number.isSafeInteger((value as { pid?: unknown }).pid) ||
      ((value as { pid: number }).pid ?? 0) <= 0 ||
      typeof (value as { processStartSha256?: unknown }).processStartSha256 !== 'string' ||
      !SHA256_PATTERN.test((value as { processStartSha256: string }).processStartSha256)
    ) {
      throw new Error('C0.7 updater lock owner is invalid')
    }
    assertSameIdentity(openedStat, await handle.stat(), path)
    assertSameIdentity(openedStat, await lstat(path), path)
    return {
      pid: (value as { pid: number }).pid,
      processStartSha256: (value as { processStartSha256: string }).processStartSha256,
      stat: openedStat
    }
  } finally {
    await handle.close()
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    return true
  }
}

async function recoverStaleLock(root: string, lockPath: string): Promise<void> {
  const owner = await readLockOwner(lockPath)
  let sameProcessInstance = false
  if (processExists(owner.pid)) {
    try {
      sameProcessInstance = (await processStartSha256(owner.pid)) === owner.processStartSha256
    } catch {
      sameProcessInstance = true
    }
  }
  if (sameProcessInstance) {
    const error = new Error('C0.7 updater lock is held by a live process') as NodeJS.ErrnoException
    error.code = 'EEXIST'
    throw error
  }
  const finalStat = await lstat(lockPath)
  if (finalStat.dev !== owner.stat.dev || finalStat.ino !== owner.stat.ino) {
    throw new Error('C0.7 updater stale lock was substituted before recovery')
  }
  await unlink(lockPath)
  await syncDirectory(root)
}

async function acquirePublicationLock(root: string): Promise<PublicationLock> {
  const lockPath = join(root, '.update.lock')
  const lockOwner = {
    pid: process.pid,
    processStartSha256: await processStartSha256(process.pid)
  }
  const lockBytes = Buffer.from(`${canonicalJson(lockOwner)}\n`)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let temporaryPath: string | undefined = join(
      root,
      `.update-lock-${String(process.pid)}-${randomBytes(12).toString('hex')}.tmp`
    )
    let canonicalLinkCreated = false
    const temporary = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    )
    try {
      await temporary.writeFile(lockBytes)
      await temporary.sync()
    } finally {
      await temporary.close()
    }
    const temporaryStat = await lstat(temporaryPath)
    let acquired: PublicationLock | undefined
    let retry = false
    let operationError: unknown
    try {
      try {
        await link(temporaryPath, lockPath)
        canonicalLinkCreated = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        await recoverStaleLock(root, lockPath)
        retry = true
      }
      if (!retry) {
        await unlink(temporaryPath)
        temporaryPath = undefined
        await syncDirectory(root)
        const handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW)
        const stat = await handle.stat()
        if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
          await handle.close()
          throw new Error('C0.7 updater failed to acquire a canonical lock')
        }
        canonicalLinkCreated = false
        acquired = {
          handle,
          stat,
          path: lockPath
        }
      }
    } catch (error) {
      operationError = error
      if (canonicalLinkCreated && temporaryStat) {
        try {
          const lockStat = await lstat(lockPath)
          if (lockStat.dev !== temporaryStat.dev || lockStat.ino !== temporaryStat.ino) {
            throw new Error('C0.7 updater lock path was substituted during failed acquisition')
          }
          await unlink(lockPath)
          await syncDirectory(root)
        } catch (cleanupError) {
          operationError = new AggregateError(
            [error, cleanupError],
            'C0.7 updater failed to acquire and clean up its publication lock'
          )
        }
      }
    }
    let temporaryCleanupError: unknown
    if (temporaryPath) {
      try {
        await unlink(temporaryPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          temporaryCleanupError = error
        }
      }
    }
    if (operationError !== undefined && temporaryCleanupError !== undefined) {
      throw new AggregateError(
        [operationError, temporaryCleanupError],
        'C0.7 updater operation and temporary-lock cleanup failed'
      )
    }
    if (operationError !== undefined) throw operationError
    if (temporaryCleanupError !== undefined) throw temporaryCleanupError
    if (retry) continue
    if (!acquired) throw new Error('C0.7 updater lock acquisition reached an impossible state')
    return acquired
  }
  throw new Error('C0.7 updater could not recover the stale publication lock')
}

async function recoverPublicationTemps(root: string): Promise<void> {
  const rootEntries = await readdir(root, { withFileTypes: true })
  for (const entry of rootEntries) {
    if (
      !/^\.update-lock-\d+-[0-9a-f]{24}\.tmp$/u.test(entry.name) &&
      !/^\.manifest-\d+-[0-9a-f]{24}\.tmp$/u.test(entry.name)
    ) {
      continue
    }
    const path = join(root, entry.name)
    const stat = await lstat(path)
    if (!entry.isFile() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error('C0.7 updater found an unsafe stale lock temporary')
    }
    await unlink(path)
  }

  const artifactDirectory = join(root, 'artifacts')
  const artifactEntries = await readdir(artifactDirectory, { withFileTypes: true })
  for (const entry of artifactEntries) {
    if (!/^\.artifact-\d+-[0-9a-f]{24}\.tmp$/u.test(entry.name)) continue
    const temporaryPath = join(artifactDirectory, entry.name)
    const stat = await lstat(temporaryPath)
    if (
      !entry.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink < 1 ||
      stat.nlink > 2 ||
      (process.getuid && stat.uid !== process.getuid())
    ) {
      throw new Error('C0.7 updater found an unsafe stale artifact temporary')
    }
    if (stat.nlink === 2) {
      if ((stat.mode & 0o222) !== 0 || stat.size <= 0 || stat.size > MAX_ARTIFACT_BYTES) {
        throw new Error('C0.7 linked stale artifact temporary is not immutable')
      }
      const handle = await open(temporaryPath, constants.O_RDONLY | constants.O_NOFOLLOW)
      let bytes: Buffer
      try {
        bytes = await handle.readFile()
        assertSameIdentity(stat, await handle.stat(), temporaryPath)
      } finally {
        await handle.close()
      }
      parseCanonicalTranscript(bytes)
      const finalPath = join(artifactDirectory, `sha256-${digest(bytes)}.ndjson`)
      const finalStat = await lstat(finalPath)
      if (finalStat.dev !== stat.dev || finalStat.ino !== stat.ino || finalStat.nlink !== 2) {
        throw new Error('C0.7 linked stale artifact temporary has no matching final path')
      }
    }
    await unlink(temporaryPath)
  }
  await syncDirectory(root)
  await syncDirectory(artifactDirectory)
}

async function publishArtifact(root: string, sha: string, bytes: Buffer): Promise<void> {
  if (digest(bytes) !== sha) {
    throw new Error(`C0.7 updater artifact bytes do not match ${sha}`)
  }
  parseCanonicalTranscript(bytes)
  const path = join(root, 'artifacts', `sha256-${sha}.ndjson`)
  let temporaryPath: string | undefined = join(
    root,
    'artifacts',
    `.artifact-${String(process.pid)}-${randomBytes(12).toString('hex')}.tmp`
  )
  const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW
  const handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600)
  let operationError: unknown
  try {
    try {
      await handle.writeFile(bytes)
      await handle.chmod(0o444)
      await handle.sync()
    } finally {
      await handle.close()
    }

    try {
      await link(temporaryPath, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = await readVerifiedFile(path, MAX_ARTIFACT_BYTES)
      if (!existing.equals(bytes)) {
        throw new Error(`C0.7 updater refuses to overwrite corrupt artifact ${sha}`)
      }
    }
    if (temporaryPath) {
      await unlink(temporaryPath)
      temporaryPath = undefined
    }
  } catch (error) {
    operationError = error
  }
  let temporaryCleanupError: unknown
  if (temporaryPath) {
    try {
      await unlink(temporaryPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') temporaryCleanupError = error
    }
  }
  if (operationError !== undefined && temporaryCleanupError !== undefined) {
    throw new AggregateError(
      [operationError, temporaryCleanupError],
      `C0.7 updater artifact ${sha} publication and temporary cleanup failed`
    )
  }
  if (operationError !== undefined) throw operationError
  if (temporaryCleanupError !== undefined) throw temporaryCleanupError
}

export async function publishTranscriptUpdate(
  options: PublishTranscriptUpdateOptions
): Promise<{ manifestSha256: string }> {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw new Error('C0.7 transcript publication requires Linux or Darwin no-follow semantics')
  }
  if (options.expectedOldManifestSha256 !== 'absent' && !SHA256_PATTERN.test(options.expectedOldManifestSha256)) {
    throw new TypeError('expected old manifest SHA-256 must be 64 lowercase hex or absent')
  }
  const root = options.root ?? C0_7_TRANSCRIPT_ROOT
  await assertEvidenceDirectories(root)
  const manifest = validateImmutableManifest(options.manifest)
  const manifestBytes = canonicalManifestBytes(manifest)
  const artifacts = new Map([...options.artifacts].map(([sha, bytes]) => [sha, Buffer.from(bytes)]))
  const referencedDigests = new Set(manifest.cases.map(item => item.artifact.sha256))
  if (artifacts.size !== referencedDigests.size || [...artifacts.keys()].some(sha => !referencedDigests.has(sha))) {
    throw new Error('C0.7 updater artifacts must exactly match manifest references')
  }

  for (const item of manifest.cases) {
    const bytes = artifacts.get(item.artifact.sha256)
    const records = bytes ? parseCanonicalTranscript(bytes) : []
    if (
      !bytes ||
      bytes.length !== item.artifact.byteLength ||
      records.length !== item.artifact.recordCount ||
      digest(bytes) !== item.artifact.sha256
    ) {
      throw new Error(`C0.7 updater artifact metadata mismatch for ${item.id}`)
    }
    assertArtifactMetadataMatchesManifest(manifest, item, records)
  }

  const noFollow = constants.O_NOFOLLOW
  const lock = await acquirePublicationLock(root)
  let temporaryManifestPath: string | undefined
  let result: { manifestSha256: string } | undefined
  let committedManifestSha256: string | undefined
  let publicationError: unknown
  try {
    await recoverPublicationTemps(root)
    await verifyArtifactDirectory(root)
    const initialSha = await currentManifestSha256(root)
    if (initialSha !== options.expectedOldManifestSha256) {
      throw new Error(
        `C0.7 manifest CAS mismatch: expected ${options.expectedOldManifestSha256}, received ${initialSha}`
      )
    }

    for (const [sha, bytes] of artifacts) {
      await publishArtifact(root, sha, bytes)
    }
    await syncDirectory(join(root, 'artifacts'))

    temporaryManifestPath = join(root, `.manifest-${String(process.pid)}-${randomBytes(12).toString('hex')}.tmp`)
    const temporary = await open(
      temporaryManifestPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600
    )
    try {
      await temporary.writeFile(manifestBytes)
      await temporary.chmod(0o444)
      await temporary.sync()
    } finally {
      await temporary.close()
    }

    const finalOldSha = await currentManifestSha256(root)
    if (finalOldSha !== options.expectedOldManifestSha256) {
      throw new Error(
        `C0.7 manifest changed before publication: expected ${options.expectedOldManifestSha256}, received ${finalOldSha}`
      )
    }
    await rename(temporaryManifestPath, join(root, 'manifest.json'))
    temporaryManifestPath = undefined
    committedManifestSha256 = digest(manifestBytes)
    await syncDirectory(root)
    const published = await readVerifiedManifest(root)
    if (!published.bytes.equals(manifestBytes)) {
      throw new Error('C0.7 published manifest does not match the requested bytes')
    }
    await verifyCommittedTranscriptsUnlocked(root)
    result = { manifestSha256: published.sha256 }
  } catch (error) {
    publicationError = error
  }

  const cleanupErrors: unknown[] = []
  if (temporaryManifestPath) {
    try {
      await unlink(temporaryManifestPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        cleanupErrors.push(error)
      }
    }
  }
  try {
    await lock.handle.close()
  } catch (error) {
    cleanupErrors.push(error)
  }
  try {
    const finalLockStat = await lstat(lock.path)
    if (finalLockStat.dev !== lock.stat.dev || finalLockStat.ino !== lock.stat.ino) {
      cleanupErrors.push(new Error('C0.7 updater lock path was substituted'))
    } else {
      await unlink(lock.path)
      await syncDirectory(root)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      cleanupErrors.push(error)
    }
  }

  if (publicationError !== undefined) {
    const label = committedManifestSha256
      ? `C0.7 manifest target ${committedManifestSha256} was renamed before durability or verification failed`
      : 'C0.7 transcript publication and cleanup failed'
    if (cleanupErrors.length > 0) {
      throw new AggregateError([publicationError, ...cleanupErrors], label)
    }
    if (committedManifestSha256) {
      throw new AggregateError([publicationError], label)
    }
    throw publicationError
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      `C0.7 manifest ${result!.manifestSha256} was committed and verified, but publication cleanup failed`
    )
  }
  return result!
}
