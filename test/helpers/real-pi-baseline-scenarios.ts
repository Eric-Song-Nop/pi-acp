import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { lstat, open, readFile, realpath } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { isAbsolute, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import type { AnyMessage, AvailableCommand } from '@agentclientprotocol/sdk'
import { AcpOperationTimeoutError, type AcpTranscriptEntry } from './acp-process-client.js'
import {
  canonicalizeTranscript,
  sha256,
  type CanonicalTranscript,
  type ImmutableTranscriptCase
} from './immutable-transcript.js'
import {
  MAX_LOOPBACK_BODY_BYTES,
  REAL_PI_FIXTURE_COMMAND_ID,
  startRealPiFixture,
  type LoopbackRequest
} from './real-pi-fixture.js'
import { CommandNotAdvertisedError, StrictCatalogClient } from './strict-catalog-client.js'

export const C0_7_STATE_ONLY_TIMEOUT_MS = 1_500
export const C0_7_CAPTURE_HARD_DEADLINE_MS = 30_000
export const C0_7_UNTRUSTED_PROMPT_NAME = 'poison'
export const C0_7_UNTRUSTED_PROMPT_CANARY = 'C0_7_UNTRUSTED_PROMPT_CANARY\n'
export const C0_7_PI_GIT_HEAD = '845d6ff1f6643aba440341cce877ce1c43ebbc39'
export const C0_7_ACP_SDK_GIT_HEAD = '73bc30649b650de320340c782733bf69a545bd28'
export const C0_7_PI_LOCK_INTEGRITY =
  'sha512-uYhF+FsZxogoSX/AxBcUdiY+ZklubwaXyAoEGA2eQwsHcyEAhUYIKh/WLXe/a8+k8eTCmxb+ZN2Zo9mzQtzbWw=='
export const C0_7_ACP_SDK_LOCK_INTEGRITY =
  'sha512-ialrcI+RzKOYe+fw+TfpyTdRmEoqIkXLlwbTi6XgaXXfdhNcdod7TmE1VsTnG3yTlox8TMTSMQgWbLLbz3r86Q=='
export const C0_7_PI_INSTALLED_TREE_SHA256 = '623bc39816481c2fa15fe2140da0f4df1e865b97dfc69f39f44ba86cf7b0705f'
export const C0_7_ACP_SDK_INSTALLED_TREE_SHA256 = '6b5a2d9876a3bac8861954fab54d4355a992be4a799bcfccfc6f6bc1737a5086'
export const C0_7_CLIENT_REPOSITORY = 'https://github.com/Eric-Song-Nop/pi-acp'
const C0_7_UNTRUSTED_PROMPT_SHA256 = sha256(Buffer.from(C0_7_UNTRUSTED_PROMPT_CANARY))
const MAX_PI_SESSION_BYTES = 256 * 1024
const MAX_PI_SESSION_RECORDS = 512
const rawClientSourcePath = fileURLToPath(new URL('./acp-process-client.ts', import.meta.url))
const strictClientSourcePath = fileURLToPath(new URL('./strict-catalog-client.ts', import.meta.url))

const EXPECTED_ADVERTISED_COMMAND_NAMES = [
  'compact',
  'autocompact',
  'export',
  'session',
  'name',
  'steering',
  'follow-up',
  'changelog'
] as const

export type BaselineCaseId = ImmutableTranscriptCase['id']
export type BaselineExpectedFailure = ImmutableTranscriptCase['expectedFailure']

export type ObservedBaseline = {
  id: BaselineCaseId
  clientBehavior: 'raw' | 'strict'
  runtime: {
    nodeVersion: string
    platform: NodeJS.Platform
    arch: string
  }
  expectedFailure: BaselineExpectedFailure
  networkBoundary: {
    configuredLoopbackRequests: number
    osEgressDenied: false
  }
  canonicalTranscript: CanonicalTranscript
}

export class UnexpectedBaselinePassError extends Error {
  constructor(
    readonly caseId: BaselineCaseId,
    detail: string
  ) {
    super(
      `${caseId} no longer exhibits its expected failure (${detail}); flip the xfail to a positive assertion instead of refreshing the artifact`
    )
    this.name = 'UnexpectedBaselinePassError'
  }
}

export class BaselineSignatureMismatchError extends Error {
  constructor(
    readonly caseId: BaselineCaseId,
    detail: string
  ) {
    super(`${caseId} changed outside its frozen expected-failure signature: ${detail}`)
    this.name = 'BaselineSignatureMismatchError'
  }
}

function runtime() {
  return {
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch
  }
}

function outboundPromptCount(entries: readonly AcpTranscriptEntry[]): number {
  return entries.filter(
    entry =>
      entry.kind === 'message' &&
      entry.direction === 'client_to_agent' &&
      'method' in entry.message &&
      entry.message.method === 'session/prompt'
  ).length
}

function lastMatching<T>(values: readonly T[], predicate: (value: T) => boolean): T | undefined {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index]
    if (predicate(value)) return value
  }
  return undefined
}

function promptRequestId(entries: readonly AcpTranscriptEntry[]): string | number | null {
  const request = lastMatching(
    entries,
    entry =>
      entry.kind === 'message' &&
      entry.direction === 'client_to_agent' &&
      'method' in entry.message &&
      entry.message.method === 'session/prompt'
  )
  if (!request || request.kind !== 'message' || !('id' in request.message)) {
    throw new BaselineSignatureMismatchError('C0.7-XF03', 'the raw prompt request was not recorded')
  }
  return request.message.id
}

function hasResponse(entries: readonly AcpTranscriptEntry[], id: string | number | null): boolean {
  return entries.some(
    entry =>
      entry.kind === 'message' &&
      entry.direction === 'agent_to_client' &&
      !('method' in entry.message) &&
      'id' in entry.message &&
      entry.message.id === id
  )
}

function availableCommands(update: AnyMessage): AvailableCommand[] | undefined {
  if (!('method' in update) || update.method !== 'session/update') return undefined
  const params = update.params as
    | {
        update?: {
          sessionUpdate?: unknown
          availableCommands?: unknown
        }
      }
    | undefined
  if (
    params?.update?.sessionUpdate !== 'available_commands_update' ||
    !Array.isArray(params.update.availableCommands)
  ) {
    return undefined
  }
  return params.update.availableCommands as AvailableCommand[]
}

function catalogFromTranscript(entries: readonly AcpTranscriptEntry[]): AvailableCommand[] {
  const catalog = lastMatching(
    entries,
    entry =>
      entry.kind === 'message' &&
      entry.direction === 'agent_to_client' &&
      availableCommands(entry.message) !== undefined
  )
  if (!catalog || catalog.kind !== 'message') {
    throw new Error('real Pi baseline did not receive an ACP command catalog')
  }
  return availableCommands(catalog.message)!
}

function canonicalize(fixture: Awaited<ReturnType<typeof startRealPiFixture>>, sessionId: string): CanonicalTranscript {
  return canonicalizeTranscript(fixture.client.transcript(), {
    fixtureRoot: fixture.rootDir,
    sessionId,
    forbiddenValues: [fixture.nonce, `pi-acp-fixture-${fixture.nonce}`, C0_7_UNTRUSTED_PROMPT_CANARY]
  })
}

export async function runWithinFixtureDeadline<T>(
  fixture: Awaited<ReturnType<typeof startRealPiFixture>>,
  operation: () => Promise<T>
): Promise<T> {
  try {
    const result = await Promise.race([
      operation(),
      fixture.hardDeadline.then(error => {
        throw error
      })
    ])
    await fixture.assertWithinHardDeadline()
    return result
  } catch (error) {
    await fixture.assertWithinHardDeadline()
    throw error
  }
}

export type BaselineRunOptions = {
  baselineGitHead: string
}

export type BaselineClientSource = {
  path: 'test/helpers/acp-process-client.ts' | 'test/helpers/strict-catalog-client.ts'
  sha256: string
}

export async function baselineClientSources(clientBehavior: 'raw' | 'strict'): Promise<BaselineClientSource[]> {
  const sources: BaselineClientSource[] = [
    {
      path: 'test/helpers/acp-process-client.ts',
      sha256: sha256(await readFile(rawClientSourcePath))
    }
  ]
  if (clientBehavior === 'strict') {
    sources.push({
      path: 'test/helpers/strict-catalog-client.ts',
      sha256: sha256(await readFile(strictClientSourcePath))
    })
  }
  return sources
}

async function commonFixtureOptions(
  caseId: BaselineCaseId,
  clientBehavior: 'raw' | 'strict',
  options: BaselineRunOptions
) {
  if (!/^[0-9a-f]{40}$/u.test(options.baselineGitHead)) {
    throw new TypeError('C0.7 baseline Git head must be 40 lowercase hex')
  }
  return {
    clientBehavior,
    hardDeadlineMs: C0_7_CAPTURE_HARD_DEADLINE_MS,
    transcriptCheckpoint: 'C0.7' as const,
    transcriptCaseId: caseId,
    transcriptMetadata: {
      baselineGitHead: options.baselineGitHead,
      piGitHead: C0_7_PI_GIT_HEAD,
      piInstalledTreeSha256: C0_7_PI_INSTALLED_TREE_SHA256,
      piLockIntegrity: C0_7_PI_LOCK_INTEGRITY,
      sdkGitHead: C0_7_ACP_SDK_GIT_HEAD,
      sdkInstalledTreeSha256: C0_7_ACP_SDK_INSTALLED_TREE_SHA256,
      sdkLockIntegrity: C0_7_ACP_SDK_LOCK_INTEGRITY,
      clientVersion: `git:${options.baselineGitHead}`,
      clientSources: await baselineClientSources(clientBehavior)
    }
  }
}

async function captureCatalogOmission(options: BaselineRunOptions): Promise<ObservedBaseline> {
  const id = 'C0.7-XF01'
  const fixture = await startRealPiFixture(await commonFixtureOptions(id, 'strict', options))
  const strict = new StrictCatalogClient(fixture.client, 10_000)
  try {
    return await runWithinFixtureDeadline(fixture, async () => {
      await fixture.client.initialize()
      const session = await fixture.client.newSession({
        cwd: fixture.cwd,
        mcpServers: []
      })
      const catalog = await strict.waitForCatalog(session.sessionId, {
        timeoutMs: 10_000
      })
      const { receipt } = await fixture.readRegistrationReceipt()
      assert.deepEqual(receipt.registrations.commands, [REAL_PI_FIXTURE_COMMAND_ID])
      assert.equal(receipt.approveArgPresent, true)
      assert.equal(receipt.projectTrusted, true)

      const names = catalog.commands.map(command => command.name)
      if (names.includes(REAL_PI_FIXTURE_COMMAND_ID)) {
        throw new UnexpectedBaselinePassError(id, 'the fixture extension command is now advertised')
      }
      if (
        names.length !== EXPECTED_ADVERTISED_COMMAND_NAMES.length ||
        names.some((name, index) => name !== EXPECTED_ADVERTISED_COMMAND_NAMES[index])
      ) {
        throw new BaselineSignatureMismatchError(id, `advertised names changed to ${JSON.stringify(names)}`)
      }

      const before = outboundPromptCount(fixture.client.transcript())
      let rejection: unknown
      try {
        await strict.promptCommand({
          sessionId: session.sessionId,
          name: REAL_PI_FIXTURE_COMMAND_ID
        })
      } catch (error) {
        rejection = error
      }
      if (rejection === undefined) {
        throw new UnexpectedBaselinePassError(id, 'the strict client accepted and executed the command')
      }
      if (
        !(rejection instanceof CommandNotAdvertisedError) ||
        rejection.commandName !== REAL_PI_FIXTURE_COMMAND_ID ||
        rejection.sessionId !== session.sessionId ||
        rejection.advertisedNames.join('\0') !== names.join('\0')
      ) {
        throw new BaselineSignatureMismatchError(id, rejection instanceof Error ? rejection.message : String(rejection))
      }
      const outboundPromptDelta = outboundPromptCount(fixture.client.transcript()) - before
      if (outboundPromptDelta !== 0 || fixture.requests.length !== 0) {
        throw new BaselineSignatureMismatchError(id, 'strict rejection wrote a prompt or reached the provider')
      }

      strict.dispose()
      const exit = await fixture.client.close()
      assert.deepEqual({ code: exit.code, signal: exit.signal }, { code: 0, signal: null })
      return {
        id,
        clientBehavior: 'strict',
        runtime: runtime(),
        expectedFailure: {
          kind: 'command_not_advertised',
          errorName: 'CommandNotAdvertisedError',
          commandName: REAL_PI_FIXTURE_COMMAND_ID,
          advertisedNames: names,
          outboundPromptDelta: 0
        },
        networkBoundary: {
          configuredLoopbackRequests: 0,
          osEgressDenied: false
        },
        canonicalTranscript: canonicalize(fixture, session.sessionId)
      }
    })
  } finally {
    strict.dispose()
    await fixture.cleanup()
  }
}

async function readMappedSession(
  fixture: Awaited<ReturnType<typeof startRealPiFixture>>,
  sessionId: string
): Promise<string> {
  const sessionMap = JSON.parse(await readFile(fixture.sessionMapPath, 'utf8')) as {
    sessions?: Record<string, { sessionFile?: unknown }>
  }
  const sessionFile = sessionMap.sessions?.[sessionId]?.sessionFile
  if (typeof sessionFile !== 'string' || !isAbsolute(sessionFile)) {
    throw new Error('C0.7 trust baseline has no absolute mapped Pi session file')
  }
  const canonicalSessionDir = await realpath(fixture.sessionDir)
  const canonicalSessionFile = await realpath(sessionFile)
  const relativePath = relative(canonicalSessionDir, canonicalSessionFile)
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error('C0.7 trust baseline Pi session file escapes the isolated directory')
  }
  const pathStat = await lstat(canonicalSessionFile)
  if (
    !pathStat.isFile() ||
    pathStat.isSymbolicLink() ||
    pathStat.nlink !== 1 ||
    pathStat.size <= 0 ||
    pathStat.size > MAX_PI_SESSION_BYTES
  ) {
    throw new Error('C0.7 trust baseline Pi session file is outside the accepted evidence bounds')
  }
  const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW
  const handle = await open(canonicalSessionFile, constants.O_RDONLY | noFollow)
  try {
    const openedStat = await handle.stat()
    if (
      openedStat.dev !== pathStat.dev ||
      openedStat.ino !== pathStat.ino ||
      openedStat.size !== pathStat.size ||
      openedStat.mtimeMs !== pathStat.mtimeMs
    ) {
      throw new Error('C0.7 trust baseline Pi session file changed before bounded read')
    }
    const bytes = await handle.readFile()
    if (bytes.length !== openedStat.size) {
      throw new Error('C0.7 trust baseline Pi session file changed during bounded read')
    }
    return bytes.toString('utf8')
  } finally {
    await handle.close()
  }
}

type TextEvidence = {
  matchCount: 1
  byteLength: number
  sha256: string
}

export type UntrustedPromptEvidence = {
  literalSlashPersisted: false
  sessionUserMessage: TextEvidence
  providerRequest: {
    count: 1
    method: 'POST'
    path: '/v1/chat/completions'
    bodyWithinLimit: true
    userMessage: TextEvidence
  }
}

function exactStringCount(value: unknown, expected: string): number {
  if (typeof value === 'string') return value === expected ? 1 : 0
  if (Array.isArray(value)) {
    return value.reduce((count, item) => count + exactStringCount(item, expected), 0)
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).reduce(
      (count, [key, item]) => count + (key === expected ? 1 : 0) + exactStringCount(item, expected),
      0
    )
  }
  return 0
}

function parseBoundedJsonLines(source: string): unknown[] {
  if (Buffer.byteLength(source) > MAX_PI_SESSION_BYTES || source.includes('\u0000')) {
    throw new BaselineSignatureMismatchError('C0.7-XF02', 'the Pi session evidence is outside its byte bounds')
  }
  const lines = source.split('\n').filter(line => line.length > 0)
  if (lines.length === 0 || lines.length > MAX_PI_SESSION_RECORDS) {
    throw new BaselineSignatureMismatchError('C0.7-XF02', 'the Pi session evidence is outside its record bounds')
  }
  try {
    return lines.map(line => JSON.parse(line) as unknown)
  } catch {
    throw new BaselineSignatureMismatchError('C0.7-XF02', 'the Pi session evidence is not bounded JSONL')
  }
}

function exactUserMessageTexts(records: readonly unknown[]): string[] {
  const result: string[] = []
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue
    const message = (record as { message?: unknown }).message
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue
    const candidate = message as {
      role?: unknown
      content?: unknown
    }
    if (candidate.role !== 'user' || !Array.isArray(candidate.content)) continue
    const first = candidate.content[0]
    if (!first || typeof first !== 'object' || Array.isArray(first)) continue
    const text = (first as { text?: unknown }).text
    if (typeof text === 'string') result.push(text)
  }
  return result
}

function providerUserMessageText(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const messages = (body as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return undefined
  const userMessage = messages[1]
  if (!userMessage || typeof userMessage !== 'object' || Array.isArray(userMessage)) return undefined
  const candidate = userMessage as {
    role?: unknown
    content?: unknown
  }
  if (candidate.role !== 'user' || !Array.isArray(candidate.content)) return undefined
  const first = candidate.content[0]
  if (!first || typeof first !== 'object' || Array.isArray(first)) return undefined
  const text = (first as { text?: unknown }).text
  return typeof text === 'string' ? text : undefined
}

function textEvidence(value: string): TextEvidence {
  return {
    matchCount: 1,
    byteLength: Buffer.byteLength(value),
    sha256: sha256(Buffer.from(value))
  }
}

export function deriveUntrustedPromptEvidence(
  sessionSource: string,
  requests: readonly LoopbackRequest[]
): UntrustedPromptEvidence {
  const sessionRecords = parseBoundedJsonLines(sessionSource)
  const sessionTextMatches = exactUserMessageTexts(sessionRecords).filter(
    value => value === C0_7_UNTRUSTED_PROMPT_CANARY
  )
  if (
    sessionTextMatches.length !== 1 ||
    exactStringCount(sessionRecords, C0_7_UNTRUSTED_PROMPT_CANARY) !== 1 ||
    exactStringCount(sessionRecords, `/${C0_7_UNTRUSTED_PROMPT_NAME}`) !== 0
  ) {
    throw new BaselineSignatureMismatchError(
      'C0.7-XF02',
      'the Pi session does not contain exactly one expected user-message value'
    )
  }

  if (requests.length !== 1) {
    throw new BaselineSignatureMismatchError(
      'C0.7-XF02',
      'the scenario did not own exactly one configured-loopback request'
    )
  }
  const request = requests[0]
  if (
    request.outcome !== 'end' ||
    request.method !== 'POST' ||
    request.url !== '/v1/chat/completions' ||
    request.bodyExceededLimit ||
    request.bodyByteLength <= 0 ||
    request.bodyByteLength > MAX_LOOPBACK_BODY_BYTES ||
    !request.body ||
    request.body.length !== request.bodyByteLength
  ) {
    throw new BaselineSignatureMismatchError(
      'C0.7-XF02',
      'the owned request is not one bounded POST /v1/chat/completions body'
    )
  }

  let providerBody: unknown
  try {
    providerBody = JSON.parse(request.body.toString('utf8')) as unknown
  } catch {
    throw new BaselineSignatureMismatchError('C0.7-XF02', 'the owned provider request body is not bounded JSON')
  }
  const providerText = providerUserMessageText(providerBody)
  if (
    providerText !== C0_7_UNTRUSTED_PROMPT_CANARY ||
    exactStringCount(providerBody, C0_7_UNTRUSTED_PROMPT_CANARY) !== 1
  ) {
    throw new BaselineSignatureMismatchError(
      'C0.7-XF02',
      'the owned provider request lacks exactly one expected user-message value'
    )
  }

  const sessionUserMessage = textEvidence(sessionTextMatches[0])
  const providerUserMessage = textEvidence(providerText)
  if (
    sessionUserMessage.sha256 !== C0_7_UNTRUSTED_PROMPT_SHA256 ||
    providerUserMessage.sha256 !== C0_7_UNTRUSTED_PROMPT_SHA256 ||
    sessionUserMessage.byteLength !== providerUserMessage.byteLength
  ) {
    throw new BaselineSignatureMismatchError('C0.7-XF02', 'the observed user-message hashes do not match')
  }
  return {
    literalSlashPersisted: false,
    sessionUserMessage,
    providerRequest: {
      count: 1,
      method: 'POST',
      path: '/v1/chat/completions',
      bodyWithinLimit: true,
      userMessage: providerUserMessage
    }
  }
}

async function captureUntrustedProjectPromptExpansion(
  options: BaselineRunOptions,
  beforePrompt?: (fixture: Awaited<ReturnType<typeof startRealPiFixture>>) => Promise<void>
): Promise<ObservedBaseline> {
  const id = 'C0.7-XF02'
  const fixture = await startRealPiFixture({
    ...(await commonFixtureOptions(id, 'raw', options)),
    projectPrompts: [
      {
        name: C0_7_UNTRUSTED_PROMPT_NAME,
        contents: C0_7_UNTRUSTED_PROMPT_CANARY
      }
    ]
  })
  try {
    return await runWithinFixtureDeadline(fixture, async () => {
      await fixture.client.initialize()
      const session = await fixture.client.newSession({
        cwd: fixture.cwd,
        mcpServers: []
      })
      await fixture.client.waitForSessionUpdate(
        notification =>
          notification.sessionId === session.sessionId &&
          notification.update.sessionUpdate === 'available_commands_update',
        { timeoutMs: 10_000 }
      )
      const catalog = catalogFromTranscript(fixture.client.transcript())
      void catalog
      await fixture.readRegistrationReceipt()
      await beforePrompt?.(fixture)

      const response = await fixture.client.prompt(
        {
          sessionId: session.sessionId,
          prompt: [
            {
              type: 'text',
              text: `/${C0_7_UNTRUSTED_PROMPT_NAME}`
            }
          ]
        },
        { timeoutMs: 10_000 }
      )
      const sessionSource = await readMappedSession(fixture, session.sessionId)
      const expanded = sessionSource.includes(C0_7_UNTRUSTED_PROMPT_CANARY.trimEnd())

      if (!expanded && fixture.requests.length === 0) {
        throw new UnexpectedBaselinePassError(id, 'the untrusted prompt was rejected without model submission')
      }
      if (response.stopReason !== 'end_turn') {
        throw new BaselineSignatureMismatchError(
          id,
          JSON.stringify({
            stopReason: response.stopReason
          })
        )
      }
      const evidence = deriveUntrustedPromptEvidence(sessionSource, fixture.requests)

      const exit = await fixture.client.close()
      assert.deepEqual({ code: exit.code, signal: exit.signal }, { code: 0, signal: null })
      return {
        id,
        clientBehavior: 'raw',
        runtime: runtime(),
        expectedFailure: {
          kind: 'untrusted_project_prompt_expanded',
          projectTrusted: false,
          catalogHasCommand: false,
          configuredLoopbackRequests: 1,
          literalSlashPersisted: evidence.literalSlashPersisted,
          sessionUserMessage: evidence.sessionUserMessage,
          providerRequest: evidence.providerRequest
        },
        networkBoundary: {
          configuredLoopbackRequests: 1,
          osEgressDenied: false
        },
        canonicalTranscript: canonicalize(fixture, session.sessionId)
      }
    })
  } finally {
    await fixture.cleanup()
  }
}

export async function runUntrustedPromptUnrelatedRequestControl(
  options: BaselineRunOptions
): Promise<ObservedBaseline> {
  return await captureUntrustedProjectPromptExpansion(options, async fixture => {
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(
        {
          host: fixture.loopbackAddress.host,
          port: fixture.loopbackAddress.port,
          method: 'GET',
          path: '/unrelated'
        },
        response => {
          response.resume()
          response.once('end', resolve)
          response.once('error', reject)
        }
      )
      request.once('error', reject)
      request.end()
    })
    await fixture.closeLoopback()
  })
}

async function captureStateOnlyCommandTimeout(options: BaselineRunOptions): Promise<ObservedBaseline> {
  const id = 'C0.7-XF03'
  const fixture = await startRealPiFixture(await commonFixtureOptions(id, 'raw', options))
  try {
    return await runWithinFixtureDeadline(fixture, async () => {
      await fixture.client.initialize()
      const session = await fixture.client.newSession({
        cwd: fixture.cwd,
        mcpServers: []
      })
      await fixture.client.waitForSessionUpdate(
        notification =>
          notification.sessionId === session.sessionId &&
          notification.update.sessionUpdate === 'available_commands_update',
        { timeoutMs: 10_000 }
      )
      const { receipt } = await fixture.readRegistrationReceipt()
      assert.deepEqual(receipt.registrations.commands, [REAL_PI_FIXTURE_COMMAND_ID])
      assert.equal(receipt.approveArgPresent, true)
      assert.equal(receipt.projectTrusted, true)

      let failure: unknown
      try {
        await fixture.client.prompt(
          {
            sessionId: session.sessionId,
            prompt: [
              {
                type: 'text',
                text: `/${REAL_PI_FIXTURE_COMMAND_ID}`
              }
            ]
          },
          { timeoutMs: C0_7_STATE_ONLY_TIMEOUT_MS }
        )
      } catch (error) {
        failure = error
      }
      if (failure === undefined) {
        throw new UnexpectedBaselinePassError(id, 'the state-only command now completes its ACP prompt')
      }
      if (
        !(failure instanceof AcpOperationTimeoutError) ||
        failure.operation !== 'session/prompt' ||
        failure.timeoutMs !== C0_7_STATE_ONLY_TIMEOUT_MS
      ) {
        throw new BaselineSignatureMismatchError(id, failure instanceof Error ? failure.message : String(failure))
      }

      const transcript = fixture.client.transcript()
      const requestId = promptRequestId(transcript)
      const promptEntries = transcript.filter(
        entry =>
          entry.kind === 'message' &&
          entry.direction === 'client_to_agent' &&
          'method' in entry.message &&
          entry.message.method === 'session/prompt'
      )
      const notificationEntries = transcript.filter(
        entry =>
          entry.kind === 'message' &&
          entry.direction === 'agent_to_client' &&
          isDeepStrictEqual(entry.message, {
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: session.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text: 'Pi ACP fixture loaded'
                },
                _meta: {
                  piAcp: {
                    notify: {
                      level: 'info'
                    }
                  }
                }
              }
            }
          })
      )
      const processExit = transcript.at(-1)
      const promptEntry = promptEntries.length === 1 ? promptEntries[0] : undefined
      const notificationEntry = notificationEntries.length === 1 ? notificationEntries[0] : undefined
      if (
        promptEntry?.kind !== 'message' ||
        notificationEntry?.kind !== 'message' ||
        notificationEntry.seq <= promptEntry.seq ||
        hasResponse(transcript, requestId) ||
        fixture.requests.length !== 0 ||
        processExit?.kind !== 'process_exit' ||
        processExit.code !== 0 ||
        processExit.signal !== null
      ) {
        throw new BaselineSignatureMismatchError(id, 'notify/response/provider/terminal evidence changed')
      }

      return {
        id,
        clientBehavior: 'raw',
        runtime: runtime(),
        expectedFailure: {
          kind: 'operation_timeout',
          errorName: 'AcpOperationTimeoutError',
          operation: 'session/prompt',
          timeoutMs: C0_7_STATE_ONLY_TIMEOUT_MS,
          configuredLoopbackRequests: 0,
          outboundPromptCount: 1,
          acpResponseCount: 0,
          remainedPendingThroughDeadline: true,
          notification: {
            sessionUpdate: 'agent_message_chunk',
            contentType: 'text',
            text: 'Pi ACP fixture loaded',
            level: 'info',
            afterPrompt: true
          },
          processExit: {
            code: 0,
            signal: null
          }
        },
        networkBoundary: {
          configuredLoopbackRequests: 0,
          osEgressDenied: false
        },
        canonicalTranscript: canonicalize(fixture, session.sessionId)
      }
    })
  } finally {
    await fixture.cleanup()
  }
}

export async function runRealPiBaselineCase(
  caseId: BaselineCaseId,
  options: BaselineRunOptions
): Promise<ObservedBaseline> {
  switch (caseId) {
    case 'C0.7-XF01':
      return await captureCatalogOmission(options)
    case 'C0.7-XF02':
      return await captureUntrustedProjectPromptExpansion(options)
    case 'C0.7-XF03':
      return await captureStateOnlyCommandTimeout(options)
  }
}
