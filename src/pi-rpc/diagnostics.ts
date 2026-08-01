import { Buffer } from 'node:buffer'
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path'
import { URL } from 'node:url'

export const PI_STARTUP_STDERR_LIMIT_BYTES = 16_384
export const PI_STARTUP_SUMMARY_LIMIT_BYTES = 4_096
export const PI_RUNTIME_EXTENSION_SUMMARY_LIMIT_BYTES = 4_096
export const PI_RUNTIME_EXTENSION_SOURCE_LIMIT_BYTES = 512
export const PI_RUNTIME_EXTENSION_EVENT_LIMIT_BYTES = 128
export const PI_STARTUP_STDERR_DRAIN_TIMEOUT_MS = 100
export const PI_STARTUP_TRUNCATION_MARKER = '[diagnostic truncated]\n'
export const PI_STARTUP_STDERR_OMISSION_MARKER = '\n[stderr omitted]\n'
export const PI_DIAGNOSTIC_REDACTION = '[REDACTED]'
const PI_STARTUP_SAFE_FALLBACK = 'Pi failed to start before the RPC channel became ready.'
const PI_EXTENSION_SAFE_FALLBACK = 'Pi rejected the extension during startup.'
const PI_RUNTIME_EXTENSION_SAFE_FALLBACK = 'Pi reported an extension runtime error.'

const PI_STARTUP_STDERR_HEAD_BYTES = PI_STARTUP_STDERR_LIMIT_BYTES / 2
const PI_STARTUP_STDERR_TAIL_BYTES = PI_STARTUP_STDERR_LIMIT_BYTES / 2
const PI_STARTUP_SOURCE_LIMIT_BYTES = 512

export type PiStartupDiagnosticCode = 'PI_EXTENSION_LOAD_FAILED' | 'PI_STARTUP_FAILED'

export interface PiStartupDiagnostic {
  schemaVersion: 1
  code: PiStartupDiagnosticCode
  phase: 'startup'
  source: string
  summary: string
  truncated: boolean
  redacted: boolean
  stderrLimitBytes: typeof PI_STARTUP_STDERR_LIMIT_BYTES
  summaryLimitBytes: typeof PI_STARTUP_SUMMARY_LIMIT_BYTES
}

export interface PiRuntimeExtensionDiagnostic {
  schemaVersion: 1
  code: 'PI_EXTENSION_RUNTIME_ERROR'
  phase: 'runtime'
  source: string
  event: string
  summary: string
  truncated: boolean
  redacted: boolean
  summaryLimitBytes: typeof PI_RUNTIME_EXTENSION_SUMMARY_LIMIT_BYTES
}

export interface PiStartupDiagnosticOptions {
  cwd: string
  agentDir: string
  env: Readonly<NodeJS.ProcessEnv>
}

export interface PiStartupExitInfo {
  code?: number | null
  signal?: NodeJS.Signals | string | null
  error?: unknown
}

type SanitizedText = {
  text: string
  redacted: boolean
  extensionSource: string | null
}

type PreparedStartupText = {
  text: string
  classificationText: string
  extensionBodyFallback?: string
  redacted: boolean
}

const PI_EXTENSION_LOAD_LINE = /(?:^|\n)(?:Error:\s*)?Failed to load extension\s+"([^"\n]+)"\s*:/i
const PI_EXTENSION_LOAD_PREFIX_LINE = /^(?:Error:\s*)?Failed to load extension\b/iu
const PI_EXTENSION_LOAD_BODY_PREFIX = /^Failed to load extension:[ \t]*/u
const SENSITIVE_ENV_NAME =
  /(?:^|[_./:/-])(?:API_?KEYS?|TOKENS?|SECRETS?|PASSWORDS?|PASSWD|AUTHS?|AUTH(?:ORIZATION|_?TOKENS?)?|CREDENTIALS?|PRIVATE_?KEYS?|ACCESS_?KEYS?|SESSION_?KEYS?|COOKIES?|SIGNATURES?)(?:$|[_./:/-])|^(?:PGPASSWORD|MYSQL_PWD)$/i
const SENSITIVE_COMPACT_KEY_SUFFIX =
  /(?:APIKEYS?|AUTHS?|AUTHORIZATION|AUTHTOKENS?|TOKENS?|SECRETS?|PASSWORDS?|PASSWD|CREDENTIALS?|PRIVATEKEYS?|ACCESSKEYS?|SESSIONKEYS?|COOKIES?|PGPASSWORD|MYSQLPWD|SIGNATURES?)$/i
const KEYED_NAME_ASSIGNMENT =
  /(?<![\p{L}\p{N}_./:@=-])(["']?)([\p{L}\p{N}_./:@-][\p{L}\p{N}_./:@ \t-]{0,511})\1(?:(?:[\t \r\n]*\[[^\]\r\n]{0,512}\])|(?:[\t \r\n]*\])){0,16}[\t \r\n]*[:=]/gu
const NESTED_KEYED_NAME_ASSIGNMENT =
  /(?<==)(["']?)([\p{L}\p{N}_./:@-][\p{L}\p{N}_./:@ \t-]{0,511})\1(?:(?:[\t \r\n]*\[[^\]\r\n]{0,512}\])|(?:[\t \r\n]*\])){0,16}[\t \r\n]*[:=]/gu

const KNOWN_CREDENTIAL =
  /\b(?:sk_(?:agent|machine|live)_[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|glpat-[A-Za-z0-9_-]{8,}|(?:AKIA|ASIA)[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{8,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g

const BARE_AUTH_CREDENTIAL = /\b(?:basic|bearer)\s+[A-Za-z0-9+/_=.~-]+/giu

const URL_CREDENTIAL = /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s/?#]*)@/g
const PRIVATE_KEY =
  /-----BEGIN [^\r\n]{0,128}?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [^\r\n]{0,128}?PRIVATE KEY(?: BLOCK)?-----/g
const PRIVATE_KEY_DELIMITER = /-----(?:BEGIN|END) [^\r\n]{0,128}?PRIVATE KEY(?: BLOCK)?-----/g
const PRIVATE_KEY_TAIL_HINT = /PRIVATE KEY(?: BLOCK)?-----/u
const PRIVATE_KEY_BEGIN_LINES = [
  '-----BEGIN PRIVATE KEY-----',
  '-----BEGIN ENCRYPTED PRIVATE KEY-----',
  '-----BEGIN RSA PRIVATE KEY-----',
  '-----BEGIN DSA PRIVATE KEY-----',
  '-----BEGIN EC PRIVATE KEY-----',
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  '-----BEGIN PGP PRIVATE KEY BLOCK-----'
] as const
const FILE_URL = /\bfile:[^\r\n]*/giu
const UNQUOTED_WINDOWS_PATH = /(?<![\p{L}\p{N}_./\\-])[A-Za-z]:[\\/]+[^\r\n]*/gu
const UNQUOTED_WINDOWS_UNC_PATH = /(?<![\p{L}\p{N}_.-])\\{2,}[^\r\n]*/gu
const UNQUOTED_WINDOWS_ROOTED_PATH = /(?<![\p{L}\p{N}_./\\-])\\(?!\\)[^\r\n]*/gu
const UNQUOTED_DOUBLE_SLASH_PATH = /(?<![:\p{L}\p{N}_./\\-])\/\/[^\r\n]*/gu
const UNQUOTED_POSIX_PATH = /(?<![\p{L}\p{N}_./\\-])\/(?!\/)[^\r\n]*/gu
const ENCODED_PATH_SEPARATOR = /%(?:2f|5c)/iu
const RESIDUAL_PERCENT_ESCAPE = /%[0-9A-Fa-f]{2}/u
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u
const WINDOWS_ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\[^\\])/u
const SAFE_LOCAL_SOURCE_LABEL = /^(?:project|global):[\p{L}\p{N}\p{M} ._/@+~=-]+$/u
const UNSAFE_SOURCE_CHARACTER = /[\p{Cc}\p{Cs}\p{Cf}\p{Zl}\p{Zp}]|\p{Bidi_Control}|\p{Default_Ignorable_Code_Point}/u
const UNSAFE_DIRECTIONAL_OR_IGNORABLE = /[\u2028\u2029]|\p{Bidi_Control}|\p{Default_Ignorable_Code_Point}/gu
const UNSAFE_FINAL_CHARACTER = /[\p{Cc}\p{Cs}\p{Cf}\p{Zl}\p{Zp}]|\p{Bidi_Control}|\p{Default_Ignorable_Code_Point}/u

/**
 * Retains bounded raw stderr head/tail bytes needed to construct a startup diagnostic.
 * The raw bytes are decoded and discarded when finalize() is first called.
 */
export class PiStartupDiagnosticCapture {
  private head = Buffer.alloc(0)
  private tail = Buffer.alloc(0)
  private totalBytes = 0
  private discarded = false
  private finalized: Readonly<PiStartupDiagnostic> | null = null
  private pathOptions: Pick<PiStartupDiagnosticOptions, 'cwd' | 'agentDir'> | undefined
  private sensitiveValues: string[]

  constructor(options: PiStartupDiagnosticOptions) {
    this.pathOptions = {
      cwd: options.cwd,
      agentDir: options.agentDir
    }
    this.sensitiveValues = sensitiveEnvironmentValues(options.env)
  }

  push(chunk: Uint8Array | string): void {
    if (this.finalized || this.discarded) return

    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    if (bytes.length === 0) return

    const headRemaining = PI_STARTUP_STDERR_HEAD_BYTES - this.head.length
    if (headRemaining > 0) {
      const headPart = bytes.subarray(0, Math.min(headRemaining, bytes.length))
      this.head = Buffer.concat([this.head, headPart], this.head.length + headPart.length)
    }

    if (bytes.length >= PI_STARTUP_STDERR_TAIL_BYTES) {
      this.tail = Buffer.from(bytes.subarray(bytes.length - PI_STARTUP_STDERR_TAIL_BYTES))
    } else {
      const combinedLength = this.tail.length + bytes.length
      const retainedLength = Math.min(combinedLength, PI_STARTUP_STDERR_TAIL_BYTES)
      const oldTailStart = Math.max(0, combinedLength - PI_STARTUP_STDERR_TAIL_BYTES)
      this.tail = Buffer.concat([this.tail.subarray(oldTailStart), bytes], retainedLength)
    }

    this.totalBytes = Math.min(PI_STARTUP_STDERR_LIMIT_BYTES + 1, this.totalBytes + bytes.length)
  }

  discard(): void {
    this.head = Buffer.alloc(0)
    this.tail = Buffer.alloc(0)
    this.totalBytes = 0
    this.pathOptions = undefined
    this.sensitiveValues = []
    this.discarded = true
  }

  finalize(exit: PiStartupExitInfo = {}): Readonly<PiStartupDiagnostic> {
    if (this.finalized) return this.finalized

    const rawTruncated = this.totalBytes > PI_STARTUP_STDERR_LIMIT_BYTES
    const retained = this.takeRetainedBytes(rawTruncated)
    this.head = Buffer.alloc(0)
    this.tail = Buffer.alloc(0)
    this.totalBytes = 0

    const invalidUtf8 = retained.some(part => !isValidUtf8(part))
    const decoded = retained.map(part => new TextDecoder('utf-8', { fatal: false }).decode(part))
    const pathOptions = this.pathOptions ?? { cwd: '', agentDir: '' }
    const sensitiveValues = this.sensitiveValues
    this.pathOptions = undefined
    this.sensitiveValues = []
    const prepared = prepareStartupText(decoded, rawTruncated)
    const sanitized = sanitizeStartupText(
      prepared.text,
      prepared.classificationText,
      prepared.extensionBodyFallback,
      pathOptions,
      sensitiveValues
    )
    const code: PiStartupDiagnosticCode = sanitized.extensionSource ? 'PI_EXTENSION_LOAD_FAILED' : 'PI_STARTUP_FAILED'
    const fallback = formatExitSummary(exit, sensitiveValues)
    let source = sanitized.extensionSource ?? 'unknown'
    const detail = sanitized.text || (sanitized.extensionSource ? PI_EXTENSION_SAFE_FALLBACK : fallback)
    let stablePrefix = sanitized.extensionSource
      ? `Extension load failed (${source}):\n`
      : sanitized.text
        ? `${fallback}\n`
        : ''
    let limited = limitSummary(detail, rawTruncated, stablePrefix)
    let redacted = sanitized.redacted || prepared.redacted || invalidUtf8

    if (!isSafeFinalSource(source, sensitiveValues) || !isSafeFinalSummary(limited.summary, sensitiveValues)) {
      redacted = true
      if (sanitized.extensionSource) {
        source = 'external:<redacted>'
        stablePrefix = `Extension load failed (${source}):\n`
        limited = limitSummary(PI_EXTENSION_SAFE_FALLBACK, rawTruncated, stablePrefix)
      } else {
        source = 'unknown'
        limited = limitSummary(PI_STARTUP_SAFE_FALLBACK, rawTruncated)
      }
    }

    if (!isSafeFinalSource(source, sensitiveValues) || !isSafeFinalSummary(limited.summary, sensitiveValues)) {
      source = sanitized.extensionSource ? 'external:<redacted>' : 'unknown'
      limited = {
        summary: sanitized.extensionSource
          ? `Extension load failed (external:<redacted>):\n${PI_EXTENSION_SAFE_FALLBACK}`
          : PI_STARTUP_SAFE_FALLBACK,
        truncated: false
      }
      redacted = true
    }

    this.finalized = Object.freeze({
      schemaVersion: 1,
      code,
      phase: 'startup',
      source,
      summary: limited.summary,
      truncated: limited.truncated,
      redacted,
      stderrLimitBytes: PI_STARTUP_STDERR_LIMIT_BYTES,
      summaryLimitBytes: PI_STARTUP_SUMMARY_LIMIT_BYTES
    })
    return this.finalized
  }

  private takeRetainedBytes(rawTruncated: boolean): Buffer[] {
    if (rawTruncated) return [this.head, this.tail]
    if (this.totalBytes <= PI_STARTUP_STDERR_HEAD_BYTES) return [this.head]

    const overlap = this.head.length + this.tail.length - this.totalBytes
    return [Buffer.concat([this.head, this.tail.subarray(Math.max(0, overlap))], this.totalBytes)]
  }
}

export function formatPiRuntimeExtensionError(
  input: unknown,
  options: PiStartupDiagnosticOptions
): Readonly<PiRuntimeExtensionDiagnostic> {
  try {
    const sensitiveValues = sensitiveEnvironmentValues(options.env)
    const rawSource = readNonEmptyStringField(input, 'extensionPath')
    const rawEvent = readNonEmptyStringField(input, 'event')
    const rawReason = readNonEmptyStringField(input, 'error')

    let redacted = rawSource === null || rawEvent === null || rawReason === null
    const source =
      rawSource === null
        ? 'unknown'
        : rawSource.trim() === rawSource
          ? labelExtensionPath(rawSource, options, sensitiveValues)
          : 'external:<redacted>'
    redacted ||= rawSource !== null && source !== rawSource

    let event = 'unknown'
    let eventTruncated = false
    if (rawEvent !== null) {
      const normalizedEvent = normalizeTerminalText(rawEvent)
      const sanitizedEvent = sanitizeStartupText(normalizedEvent, '', undefined, options, sensitiveValues)
      if (isSafeRuntimeEvent(sanitizedEvent.text, sensitiveValues)) {
        eventTruncated = Buffer.byteLength(sanitizedEvent.text, 'utf8') > PI_RUNTIME_EXTENSION_EVENT_LIMIT_BYTES
        event = eventTruncated
          ? takeUtf8Head(sanitizedEvent.text, PI_RUNTIME_EXTENSION_EVENT_LIMIT_BYTES)
          : sanitizedEvent.text
        redacted ||= sanitizedEvent.redacted || event !== rawEvent
      } else {
        redacted = true
      }
    }

    let reason = PI_RUNTIME_EXTENSION_SAFE_FALLBACK
    if (rawReason !== null) {
      const normalizedReason = normalizeTerminalText(rawReason)
      const sanitizedReason = sanitizeStartupText(normalizedReason, '', undefined, options, sensitiveValues)
      if (sanitizedReason.text && isSafeRuntimeReason(sanitizedReason.text, sensitiveValues)) {
        reason = sanitizedReason.text
        redacted ||= sanitizedReason.redacted || reason !== rawReason
      } else {
        redacted = true
      }
    }

    const prefix = `Pi extension error (source: ${source}; event: ${event}):\n`
    const limited = limitSummary(reason, false, prefix)
    const truncated = eventTruncated || limited.truncated
    redacted ||= truncated

    if (
      Buffer.byteLength(source, 'utf8') > PI_RUNTIME_EXTENSION_SOURCE_LIMIT_BYTES ||
      Buffer.byteLength(event, 'utf8') > PI_RUNTIME_EXTENSION_EVENT_LIMIT_BYTES ||
      !isSafeFinalSource(source, sensitiveValues) ||
      !isSafeRuntimeEvent(event, sensitiveValues) ||
      !isSafeFinalSummary(limited.summary, sensitiveValues)
    ) {
      return fallbackRuntimeExtensionDiagnostic()
    }

    return Object.freeze({
      schemaVersion: 1,
      code: 'PI_EXTENSION_RUNTIME_ERROR',
      phase: 'runtime',
      source,
      event,
      summary: limited.summary,
      truncated,
      redacted,
      summaryLimitBytes: PI_RUNTIME_EXTENSION_SUMMARY_LIMIT_BYTES
    })
  } catch {
    return fallbackRuntimeExtensionDiagnostic()
  }
}

function readNonEmptyStringField(input: unknown, key: 'extensionPath' | 'event' | 'error'): string | null {
  if ((typeof input !== 'object' && typeof input !== 'function') || input === null) return null

  try {
    const value = (input as Record<string, unknown>)[key]
    return typeof value === 'string' && value.length > 0 ? value : null
  } catch {
    return null
  }
}

function isSafeRuntimeEvent(event: string, sensitiveValues: readonly string[]): boolean {
  if (!event || containsSensitiveText(event, sensitiveValues)) return false
  for (const character of event) {
    if (UNSAFE_FINAL_CHARACTER.test(character)) return false
  }
  return true
}

function isSafeRuntimeReason(reason: string, sensitiveValues: readonly string[]): boolean {
  if (containsSensitiveText(reason, sensitiveValues)) return false
  for (const character of reason) {
    if (character !== '\n' && UNSAFE_FINAL_CHARACTER.test(character)) return false
  }
  return true
}

function fallbackRuntimeExtensionDiagnostic(): Readonly<PiRuntimeExtensionDiagnostic> {
  const source = 'unknown'
  const event = 'unknown'
  return Object.freeze({
    schemaVersion: 1,
    code: 'PI_EXTENSION_RUNTIME_ERROR',
    phase: 'runtime',
    source,
    event,
    summary: `Pi extension error (source: ${source}; event: ${event}):\n${PI_RUNTIME_EXTENSION_SAFE_FALLBACK}`,
    truncated: false,
    redacted: true,
    summaryLimitBytes: PI_RUNTIME_EXTENSION_SUMMARY_LIMIT_BYTES
  })
}

function prepareStartupText(decodedParts: readonly string[], rawTruncated: boolean): PreparedStartupText {
  if (!rawTruncated) {
    const input = decodedParts.join('')
    const normalized = normalizeTerminalText(input)
    return {
      text: normalized,
      classificationText: normalized,
      redacted: normalized !== input
    }
  }

  const rawHead = decodedParts[0] ?? ''
  const rawTail = decodedParts[1] ?? ''
  const normalizedHead = normalizeTerminalText(rawHead)
  const normalizedTail = normalizeTerminalText(rawTail)
  const boundary = redactTruncationBoundary(normalizedHead, normalizedTail)
  return {
    text: `${boundary.head}${PI_STARTUP_STDERR_OMISSION_MARKER}${boundary.tail}`,
    classificationText: normalizedHead,
    extensionBodyFallback: `${PI_DIAGNOSTIC_REDACTION}${PI_STARTUP_STDERR_OMISSION_MARKER}${boundary.tail}`,
    redacted: boundary.redacted || normalizedHead !== rawHead || normalizedTail !== rawTail
  }
}

function redactTruncationBoundary(head: string, tail: string): { head: string; tail: string; redacted: boolean } {
  const headLineStart = head.lastIndexOf('\n') + 1
  const tailLineEnd = tail.indexOf('\n')
  const headFragment = head.slice(headLineStart)
  const tailFragment = tailLineEnd >= 0 ? tail.slice(0, tailLineEnd) : tail
  const joined = `${head}${tail}`
  const joinedBoundary = head.length
  PRIVATE_KEY.lastIndex = 0
  const privateKeyCrossesBoundary = Array.from(joined.matchAll(PRIVATE_KEY)).some(
    match => (match.index ?? 0) < joinedBoundary && (match.index ?? 0) + match[0].length > joinedBoundary
  )
  PRIVATE_KEY.lastIndex = 0
  const openPrivateKey =
    head.lastIndexOf('-----BEGIN ') > head.lastIndexOf('-----END ') ||
    boundaryEndsWithPrefix(headFragment, '-----BEGIN ') ||
    boundaryMaySplitPrefix(headFragment, tailFragment, '-----BEGIN ') ||
    PRIVATE_KEY_BEGIN_LINES.some(prefix => boundaryMaySplitPrefix(headFragment, tailFragment, prefix)) ||
    tailFragment.includes('-----BEGIN ') ||
    PRIVATE_KEY_TAIL_HINT.test(tailFragment)
  const redactEntireTail = privateKeyCrossesBoundary || openPrivateKey
  const redactHead = headFragment.length > 0
  const redactTail = tailFragment.length > 0
  return {
    head: redactHead ? `${head.slice(0, headLineStart)}${PI_DIAGNOSTIC_REDACTION}` : head,
    tail: redactEntireTail
      ? PI_DIAGNOSTIC_REDACTION
      : redactTail
        ? `${PI_DIAGNOSTIC_REDACTION}${tailLineEnd >= 0 ? tail.slice(tailLineEnd) : ''}`
        : tail,
    redacted: redactHead || redactTail || redactEntireTail
  }
}

function boundaryMaySplitPrefix(head: string, tail: string, prefix: string): boolean {
  for (let leftLength = 1; leftLength <= Math.min(prefix.length, head.length); leftLength += 1) {
    if (!head.endsWith(prefix.slice(0, leftLength))) continue
    for (let rightStart = leftLength + 1; rightStart < prefix.length; rightStart += 1) {
      if (tail.startsWith(prefix.slice(rightStart))) return true
    }
  }
  return false
}

function boundaryEndsWithPrefix(head: string, prefix: string): boolean {
  for (let length = 1; length <= Math.min(prefix.length, head.length); length += 1) {
    if (head.endsWith(prefix.slice(0, length))) return true
  }
  return false
}

function sanitizeStartupText(
  input: string,
  classificationText: string,
  extensionBodyFallback: string | undefined,
  options: Pick<PiStartupDiagnosticOptions, 'cwd' | 'agentDir'>,
  sensitiveValues: readonly string[]
): SanitizedText {
  const extensionMatch = PI_EXTENSION_LOAD_LINE.exec(classificationText)
  const extensionPath = extensionMatch?.[1] ?? null
  const labeledExtensionSource = extensionPath ? labelExtensionPath(extensionPath, options, sensitiveValues) : null
  const extensionSource =
    labeledExtensionSource &&
    (Buffer.byteLength(labeledExtensionSource, 'utf8') > PI_STARTUP_SOURCE_LIMIT_BYTES ||
      containsSensitiveText(labeledExtensionSource, sensitiveValues))
      ? 'external:<redacted>'
      : labeledExtensionSource
  const extensionOffset = extensionMatch === null ? -1 : input.indexOf(extensionMatch[0])
  let text =
    extensionMatch === null
      ? input
      : extensionOffset >= 0
        ? input.slice(extensionOffset + extensionMatch[0].length).trim()
        : (extensionBodyFallback ?? input)
  if (extensionMatch !== null) text = text.replace(PI_EXTENSION_LOAD_BODY_PREFIX, '')
  let redacted = extensionPath !== null && extensionPath !== extensionSource

  const replaceLiteral = (literal: string, replacement: string): void => {
    if (!literal || literal === replacement || !text.includes(literal)) return
    text = text.split(literal).join(replacement)
    redacted = true
  }
  const replacePattern = (pattern: RegExp, replacement: string | ((...args: string[]) => string)): void => {
    const before = text
    text = text.replace(pattern, replacement as never)
    redacted ||= text !== before
  }
  const redactSensitiveSuffix = (): void => {
    const offset = findSensitiveKeyAssignment(text)
    if (offset === null) return
    text = `${text.slice(0, offset)}${PI_DIAGNOSTIC_REDACTION}`
    redacted = true
  }
  const redactCredentials = (): void => {
    replacePattern(PRIVATE_KEY, PI_DIAGNOSTIC_REDACTION)
    redactSensitiveSuffix()
    replacePattern(BARE_AUTH_CREDENTIAL, PI_DIAGNOSTIC_REDACTION)
    replacePattern(URL_CREDENTIAL, '$1[REDACTED]@')
    replacePattern(KNOWN_CREDENTIAL, PI_DIAGNOSTIC_REDACTION)
  }

  const malformedExtensionOffset = findMalformedExtensionOffset(text)
  if (malformedExtensionOffset !== null) {
    text = `${text.slice(0, malformedExtensionOffset)}${PI_DIAGNOSTIC_REDACTION}`
    redacted = true
  }

  for (const value of sensitiveValues) replaceLiteral(value, PI_DIAGNOSTIC_REDACTION)
  redactCredentials()

  replacePattern(FILE_URL, match => labelExtensionPath(match, options, sensitiveValues))
  replacePattern(UNQUOTED_WINDOWS_UNC_PATH, match => labelExtensionPath(match, options, sensitiveValues))
  replacePattern(UNQUOTED_WINDOWS_ROOTED_PATH, match => labelExtensionPath(match, options, sensitiveValues))
  replacePattern(UNQUOTED_WINDOWS_PATH, match => labelExtensionPath(match, options, sensitiveValues))
  replacePattern(UNQUOTED_DOUBLE_SLASH_PATH, match => labelExtensionPath(match, options, sensitiveValues))
  replacePattern(UNQUOTED_POSIX_PATH, match => labelExtensionPath(match, options, sensitiveValues))

  for (const value of sensitiveValues) replaceLiteral(value, PI_DIAGNOSTIC_REDACTION)
  redactCredentials()
  const normalized = normalizeTerminalText(text)
  redacted ||= normalized !== text

  return {
    text: tidyLines(normalized),
    redacted,
    extensionSource
  }
}

function sensitiveEnvironmentValues(env: Readonly<NodeJS.ProcessEnv>): string[] {
  return Object.entries(env)
    .filter(([name, value]) => SENSITIVE_ENV_NAME.test(name) && typeof value === 'string' && value.length > 0)
    .flatMap(([, value]) => {
      const raw = value as string
      const normalized = normalizeTerminalText(raw)
      const normalizedLines = normalized
        .split('\n')
        .flatMap(line => (line.trim() && line.trim() !== line ? [line, line.trim()] : line ? [line] : []))
      return normalized && normalized !== raw ? [raw, normalized, ...normalizedLines] : [raw, ...normalizedLines]
    })
    .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index)
    .sort((a, b) => b.length - a.length)
}

function isSensitiveAssignmentName(value: string): boolean {
  const normalizedName = value
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1_$2')
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1_$2')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
  const compactName = normalizedName.replaceAll('_', '')
  return SENSITIVE_COMPACT_KEY_SUFFIX.test(compactName)
}

function findNestedSensitiveAssignmentOffset(match: RegExpExecArray): number | null {
  for (const token of match[0].matchAll(/[\p{L}\p{N}_./:@-]+/gu)) {
    if (isSensitiveAssignmentName(token[0])) {
      return token.index === match[1].length ? match.index : match.index + token.index
    }
  }

  return isSensitiveAssignmentName(match[0]) ? match.index : null
}

function findSensitiveKeyAssignment(input: string): number | null {
  let earliestOffset: number | null = null
  KEYED_NAME_ASSIGNMENT.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = KEYED_NAME_ASSIGNMENT.exec(input)) !== null) {
    if (findNestedSensitiveAssignmentOffset(match) !== null) {
      earliestOffset = match.index
      break
    }
  }
  KEYED_NAME_ASSIGNMENT.lastIndex = 0

  NESTED_KEYED_NAME_ASSIGNMENT.lastIndex = 0
  while ((match = NESTED_KEYED_NAME_ASSIGNMENT.exec(input)) !== null) {
    const nestedOffset = findNestedSensitiveAssignmentOffset(match)
    if (nestedOffset !== null) {
      earliestOffset = earliestOffset === null ? nestedOffset : Math.min(earliestOffset, nestedOffset)
      break
    }
  }
  NESTED_KEYED_NAME_ASSIGNMENT.lastIndex = 0
  return earliestOffset
}

function findMalformedExtensionOffset(input: string): number | null {
  let offset = 0
  for (const line of input.split('\n')) {
    if (PI_EXTENSION_LOAD_PREFIX_LINE.test(line.trimStart())) return offset
    offset += line.length + 1
  }
  return null
}

function containsSensitiveText(input: string, sensitiveValues: readonly string[]): boolean {
  if (sensitiveValues.some(value => value && input.includes(value))) return true

  for (const pattern of [PRIVATE_KEY, PRIVATE_KEY_DELIMITER, BARE_AUTH_CREDENTIAL, KNOWN_CREDENTIAL]) {
    pattern.lastIndex = 0
    const matches = pattern.test(input)
    pattern.lastIndex = 0
    if (matches) return true
  }

  if (findSensitiveKeyAssignment(input) !== null) return true

  URL_CREDENTIAL.lastIndex = 0
  let urlMatch: RegExpExecArray | null
  while ((urlMatch = URL_CREDENTIAL.exec(input)) !== null) {
    if (urlMatch[2] !== PI_DIAGNOSTIC_REDACTION) {
      URL_CREDENTIAL.lastIndex = 0
      return true
    }
  }
  URL_CREDENTIAL.lastIndex = 0
  return false
}

function isSafeFinalSource(source: string, sensitiveValues: readonly string[]): boolean {
  if (Buffer.byteLength(source, 'utf8') > PI_STARTUP_SOURCE_LIMIT_BYTES) return false
  if (source !== 'unknown' && source !== 'external:<redacted>' && !SAFE_LOCAL_SOURCE_LABEL.test(source)) return false
  return !UNSAFE_SOURCE_CHARACTER.test(source) && !containsSensitiveText(source, sensitiveValues)
}

function isSafeFinalSummary(summary: string, sensitiveValues: readonly string[]): boolean {
  if (Buffer.byteLength(summary, 'utf8') > PI_STARTUP_SUMMARY_LIMIT_BYTES) return false
  for (const character of summary) {
    if (character !== '\n' && UNSAFE_FINAL_CHARACTER.test(character)) return false
  }
  return !containsSensitiveText(summary, sensitiveValues)
}

function normalizeTerminalText(input: string): string {
  const normalizedWhitespace = stripTerminalSequences(input).replace(/\r\n?/g, '\n').replace(/\t/g, ' ')
  return stripUnsafeControls(normalizedWhitespace).replace(UNSAFE_DIRECTIONAL_OR_IGNORABLE, '')
}

function stripUnsafeControls(input: string): string {
  let output = ''
  for (const character of input) {
    const code = character.codePointAt(0) as number
    const unsafeC0 = code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f)
    const unsafeC1 = code >= 0x7f && code <= 0x9f
    if (!unsafeC0 && !unsafeC1) output += character
  }
  return output
}

function stripTerminalSequences(input: string): string {
  let output = ''

  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index)

    if (code === 0x1b) {
      const next = input.charCodeAt(index + 1)
      if (next === 0x5b) {
        index = consumeCsi(input, index + 2)
      } else if (next === 0x5d) {
        index = consumeStringSequence(input, index + 2, true)
      } else if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
        index = consumeStringSequence(input, index + 2, false)
      } else {
        index = consumeEsc(input, index + 1)
      }
      continue
    }

    if (code === 0x9b) {
      index = consumeCsi(input, index + 1)
      continue
    }
    if (code === 0x9d) {
      index = consumeStringSequence(input, index + 1, true)
      continue
    }
    if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
      index = consumeStringSequence(input, index + 1, false)
      continue
    }

    output += input[index]
  }

  return output
}

function consumeCsi(input: string, start: number): number {
  for (let index = start; index < input.length; index += 1) {
    const code = input.charCodeAt(index)
    if (code >= 0x40 && code <= 0x7e) return index
  }
  return input.length - 1
}

function consumeStringSequence(input: string, start: number, allowBell: boolean): number {
  for (let index = start; index < input.length; index += 1) {
    const code = input.charCodeAt(index)
    if (allowBell && code === 0x07) return index
    if (code === 0x9c) return index
    if (code === 0x1b && input.charCodeAt(index + 1) === 0x5c) return index + 1
  }
  return input.length - 1
}

function consumeEsc(input: string, start: number): number {
  let index = start
  while (index < input.length && input.charCodeAt(index) >= 0x20 && input.charCodeAt(index) <= 0x2f) index += 1
  return Math.min(index, input.length - 1)
}

function labelExtensionPath(
  value: string,
  options: Pick<PiStartupDiagnosticOptions, 'cwd' | 'agentDir'>,
  sensitiveValues: readonly string[] = []
): string {
  const decodedFilePath = /^file:/iu.test(value) ? decodeFileUrlPath(value) : undefined
  if (decodedFilePath === null) return 'external:<redacted>'
  if (decodedFilePath === undefined && URI_SCHEME.test(value) && !WINDOWS_ABSOLUTE_PATH.test(value)) {
    return 'external:<redacted>'
  }
  const path = decodedFilePath ?? value

  if (
    UNSAFE_SOURCE_CHARACTER.test(path) ||
    normalizeTerminalText(path) !== path ||
    containsSensitiveText(path, sensitiveValues)
  ) {
    return 'external:<redacted>'
  }

  let label: string
  const globalRelative = relativeWithin(options.agentDir, path)
  if (globalRelative !== null) {
    label = `global:${globalRelative}`
  } else {
    const projectRelative = relativeWithin(options.cwd, path)
    if (projectRelative !== null) {
      label = `project:${projectRelative}`
    } else if (
      options.cwd &&
      !isAbsolute(path) &&
      !WINDOWS_ABSOLUTE_PATH.test(path) &&
      !path.startsWith('\\') &&
      !path.startsWith('//')
    ) {
      const useWindows = WINDOWS_ABSOLUTE_PATH.test(options.cwd)
      if (!useWindows && path.includes('\\')) return 'external:<redacted>'
      const pathApi = useWindows ? win32 : { resolve }
      const resolvedCandidate = pathApi.resolve(options.cwd, path)
      const resolvedRelative = relativeWithin(options.cwd, resolvedCandidate)
      label = resolvedRelative === null ? 'external:<redacted>' : `project:${resolvedRelative}`
    } else {
      label = 'external:<redacted>'
    }
  }

  if (
    Buffer.byteLength(label, 'utf8') > PI_STARTUP_SOURCE_LIMIT_BYTES ||
    UNSAFE_SOURCE_CHARACTER.test(label) ||
    (label !== 'external:<redacted>' && !SAFE_LOCAL_SOURCE_LABEL.test(label)) ||
    containsSensitiveText(label, sensitiveValues)
  ) {
    return 'external:<redacted>'
  }
  return label
}

function decodeFileUrlPath(value: string): string | null {
  if (!/^file:\/\//iu.test(value)) return null

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (
    parsed.protocol.toLowerCase() !== 'file:' ||
    /[\s\\]/u.test(value) ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash ||
    (!parsed.hostname && parsed.pathname.startsWith('//')) ||
    ENCODED_PATH_SEPARATOR.test(parsed.pathname) ||
    hasDotSegment(value)
  ) {
    return null
  }

  let pathname: string
  try {
    pathname = decodeURIComponent(parsed.pathname)
  } catch {
    return null
  }
  if (RESIDUAL_PERCENT_ESCAPE.test(pathname)) return null

  if (parsed.hostname) {
    if (!pathname.startsWith('/') || pathname === '/') return null
    return `\\\\${parsed.hostname}${pathname.replace(/\//g, '\\')}`
  }
  if (/^\/[A-Za-z]:\//u.test(pathname)) return pathname.slice(1).replace(/\//g, '\\')
  if (/^\/\/[^/]/u.test(pathname)) return pathname.replace(/\//g, '\\')
  return pathname
}

function hasDotSegment(pathname: string): boolean {
  return pathname.split('/').some(segment => {
    const decodedDots = segment.replace(/%2e/giu, '.')
    return decodedDots === '.' || decodedDots === '..'
  })
}

function relativeWithin(base: string, candidate: string): string | null {
  if (!base) return null

  const useWindows = WINDOWS_ABSOLUTE_PATH.test(base)
  if (useWindows ? !WINDOWS_ABSOLUTE_PATH.test(candidate) : !isAbsolute(candidate) || candidate.includes('\\')) {
    return null
  }
  const pathApi = useWindows ? win32 : { isAbsolute, relative, resolve, sep }

  const normalizedBase = pathApi.resolve(base)
  const normalizedCandidate = pathApi.resolve(candidate)
  const rel = pathApi.relative(normalizedBase, normalizedCandidate)
  const comparison = useWindows ? rel.toLowerCase() : rel
  const parentPrefix = `..${pathApi.sep}`
  if (comparison === '..' || comparison.startsWith(parentPrefix) || pathApi.isAbsolute(rel)) return null

  return rel ? rel.replace(/\\/g, '/') : '.'
}

function tidyLines(text: string): string {
  return text
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
}

function formatExitSummary(exit: PiStartupExitInfo, sensitiveValues: readonly string[]): string {
  const details: string[] = []
  if (typeof exit.code === 'number' && Number.isInteger(exit.code)) details.push(`code=${exit.code}`)
  if (
    typeof exit.signal === 'string' &&
    /^SIG[A-Z0-9]{1,28}$/u.test(exit.signal) &&
    !containsSensitiveText(exit.signal, sensitiveValues)
  ) {
    details.push(`signal=${exit.signal}`)
  }

  const errorCode = getSafeErrorCode(exit.error, sensitiveValues)
  if (errorCode) details.push(`error=${errorCode}`)
  return details.length > 0 ? `Pi failed to start (${details.join(', ')}).` : PI_STARTUP_SAFE_FALLBACK
}

function getSafeErrorCode(error: unknown, sensitiveValues: readonly string[]): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' &&
    /^[A-Z][A-Z0-9_]{0,31}$/u.test(code) &&
    !containsSensitiveText(code, sensitiveValues)
    ? code
    : null
}

function limitSummary(
  summary: string,
  rawTruncated: boolean,
  stablePrefix = ''
): { summary: string; truncated: boolean } {
  const complete = `${stablePrefix}${summary}`
  if (!rawTruncated && Buffer.byteLength(complete, 'utf8') <= PI_STARTUP_SUMMARY_LIMIT_BYTES) {
    return { summary: complete, truncated: false }
  }

  const boundedPrefix = takeUtf8Head(
    stablePrefix,
    PI_STARTUP_SUMMARY_LIMIT_BYTES - Buffer.byteLength(PI_STARTUP_TRUNCATION_MARKER, 'utf8')
  )
  const fixed = `${boundedPrefix}${PI_STARTUP_TRUNCATION_MARKER}`
  const budget = PI_STARTUP_SUMMARY_LIMIT_BYTES - Buffer.byteLength(fixed, 'utf8')
  const characters = Array.from(summary)
  let used = 0
  let start = characters.length

  while (start > 0) {
    const character = characters[start - 1]
    const bytes = Buffer.byteLength(character, 'utf8')
    if (used + bytes > budget) break
    used += bytes
    start -= 1
  }

  return {
    summary: `${fixed}${characters.slice(start).join('')}`,
    truncated: true
  }
}

function takeUtf8Head(input: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''

  let used = 0
  const output: string[] = []
  for (const character of input) {
    const bytes = Buffer.byteLength(character, 'utf8')
    if (used + bytes > maxBytes) break
    used += bytes
    output.push(character)
  }
  return output.join('')
}

function isValidUtf8(input: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(input)
    return true
  } catch {
    return false
  }
}
