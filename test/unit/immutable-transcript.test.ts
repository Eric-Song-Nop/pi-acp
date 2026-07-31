import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import type { AcpTranscriptEntry, AcpTranscriptMetadata } from '../helpers/acp-process-client.js'
import {
  FIXTURE_ROOT_TOKEN,
  SESSION_ID_TOKEN,
  canonicalizeTranscript,
  parseCanonicalTranscript,
  publishTranscriptUpdate,
  readVerifiedArtifact,
  readVerifiedManifest,
  validateImmutableManifest,
  verifyCommittedTranscripts,
  type CanonicalTranscript,
  type ImmutableTranscriptCase,
  type ImmutableTranscriptManifest
} from '../helpers/immutable-transcript.js'
import { installedPackageTreeSha256, parseTranscriptUpdateArgs } from '../../scripts/update-command-transcripts.js'
import { C0_7_UNTRUSTED_PROMPT_CANARY, deriveUntrustedPromptEvidence } from '../helpers/real-pi-baseline-scenarios.js'
import type { LoopbackRequest } from '../helpers/real-pi-fixture.js'

const ADAPTER_HEAD = 'a'.repeat(40)
const PI_HEAD = 'b'.repeat(40)
const SDK_HEAD = 'c'.repeat(40)
const PI_TREE_SHA = '623bc39816481c2fa15fe2140da0f4df1e865b97dfc69f39f44ba86cf7b0705f'
const SDK_TREE_SHA = '6b5a2d9876a3bac8861954fab54d4355a992be4a799bcfccfc6f6bc1737a5086'
const RAW_CLIENT_SHA = 'd'.repeat(64)
const STRICT_CLIENT_SHA = 'e'.repeat(64)
const FIXTURE_SOURCE_SHA = 'f'.repeat(64)
const PROJECT_CANARY_SHA = '1'.repeat(64)
const execFileAsync = promisify(execFile)

function entries(caseId = 'C0.7-XF01', metadata: AcpTranscriptMetadata = {}): AcpTranscriptEntry[] {
  const strict = caseId === 'C0.7-XF01'
  const clientSources = [
    {
      path: 'test/helpers/acp-process-client.ts',
      sha256: RAW_CLIENT_SHA
    },
    ...(strict
      ? [
          {
            path: 'test/helpers/strict-catalog-client.ts',
            sha256: STRICT_CLIENT_SHA
          }
        ]
      : [])
  ]
  return [
    {
      kind: 'meta',
      schemaVersion: 1,
      protocolVersion: 1,
      sdkVersion: '0.26.0',
      nodeVersion: process.versions.node,
      clientBehavior: strict ? 'strict' : 'raw',
      metadata: {
        baselineGitHead: ADAPTER_HEAD,
        caseId,
        checkpoint: 'C0.7',
        client: strict ? 'strict-catalog-client' : 'raw-process-client',
        clientSources,
        clientVersion: `git:${ADAPTER_HEAD}`,
        fixtureId: 'pi-extension-pack-v1',
        fixtureSources: [
          {
            path: 'test/fixtures/pi-extension-pack/index.ts',
            sha256: FIXTURE_SOURCE_SHA
          },
          {
            path: 'test/fixtures/pi-extension-pack/project-canary.js',
            sha256: PROJECT_CANARY_SHA
          }
        ],
        piGitHead: PI_HEAD,
        piInstalledTreeSha256: PI_TREE_SHA,
        piLockIntegrity: 'sha512-pi-test',
        piAcpVersion: '0.0.33',
        piVersion: '0.83.0',
        planId: 'PACP-CMD-2026-01',
        sdkGitHead: SDK_HEAD,
        sdkInstalledTreeSha256: SDK_TREE_SHA,
        sdkLockIntegrity: 'sha512-sdk-test',
        platform: process.platform,
        arch: process.arch,
        ...metadata
      }
    },
    {
      kind: 'message',
      seq: 1,
      direction: 'client_to_agent',
      message: {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/new',
        params: {
          cwd: '/tmp/c0.7-fixture/workspace',
          mcpServers: []
        }
      }
    },
    {
      kind: 'message',
      seq: 2,
      direction: 'agent_to_client',
      message: {
        jsonrpc: '2.0',
        id: 1,
        result: {
          sessionId: '11111111-1111-4111-8111-111111111111'
        }
      }
    },
    {
      kind: 'process_exit',
      seq: 3,
      code: 0,
      signal: null
    }
  ]
}

function canonical(caseId: string): CanonicalTranscript {
  return canonicalizeTranscript(entries(caseId), {
    fixtureRoot: '/tmp/c0.7-fixture',
    sessionId: '11111111-1111-4111-8111-111111111111',
    forbiddenValues: []
  })
}

function entriesWithTextChunks(parts: readonly string[]): AcpTranscriptEntry[] {
  const result = entries('C0.7-XF03').slice(0, -1)
  for (const [index, text] of parts.entries()) {
    result.push({
      kind: 'message',
      seq: result.length,
      direction: 'agent_to_client',
      message: {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: '11111111-1111-4111-8111-111111111111',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text
            },
            _meta: {
              part: index
            }
          }
        }
      }
    })
  }
  result.push({
    kind: 'process_exit',
    seq: result.length,
    code: 0,
    signal: null
  })
  return result
}

async function currentProcessStartSha256(): Promise<string> {
  if (process.platform === 'linux') {
    const [source, bootIdSource] = await Promise.all([
      readFile(`/proc/${String(process.pid)}/stat`, 'utf8'),
      readFile('/proc/sys/kernel/random/boot_id', 'utf8')
    ])
    const fieldsAfterCommand = source
      .slice(source.lastIndexOf(')') + 1)
      .trim()
      .split(/\s+/u)
    return createHash('sha256')
      .update(`linux-boot:${bootIdSource.trim().toLowerCase()}\u0000proc-starttime:${fieldsAfterCommand[19]}`)
      .digest('hex')
  }
  const { stdout } = await execFileAsync('/bin/ps', ['-o', 'lstart=', '-p', String(process.pid)], {
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      LC_ALL: 'C',
      LANG: 'C',
      TZ: 'UTC'
    }
  })
  return createHash('sha256').update(stdout.trim().replace(/\s+/gu, ' ')).digest('hex')
}

function fixtureCase(id: ImmutableTranscriptCase['id'], transcript: CanonicalTranscript): ImmutableTranscriptCase {
  const common = {
    id,
    title: id,
    status: 'xfail' as const,
    runtime: {
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch
    },
    artifact: {
      path: `artifacts/sha256-${transcript.sha256}.ndjson`,
      sha256: transcript.sha256,
      byteLength: transcript.bytes.length,
      recordCount: transcript.recordCount
    }
  }
  switch (id) {
    case 'C0.7-XF01':
      return {
        ...common,
        upstreamLedgerId: 'X-01',
        trackingUrl: 'https://github.com/svkozak/pi-acp/pull/20',
        ownerCheckpoints: ['C2.3'],
        recheckTrigger: 'catalog changes',
        clientBehavior: 'strict',
        expectedFailure: {
          kind: 'command_not_advertised',
          errorName: 'CommandNotAdvertisedError',
          commandName: 'fixture-state',
          advertisedNames: [
            'compact',
            'autocompact',
            'export',
            'session',
            'name',
            'steering',
            'follow-up',
            'changelog'
          ],
          outboundPromptDelta: 0
        },
        networkBoundary: {
          configuredLoopbackRequests: 0,
          osEgressDenied: false
        }
      }
    case 'C0.7-XF02':
      return {
        ...common,
        upstreamLedgerId: null,
        trackingUrl: 'https://github.com/Eric-Song-Nop/pi-acp/issues/6',
        ownerCheckpoints: ['C1.6', 'C2.2', 'C5.8'],
        recheckTrigger: 'trust routing changes',
        clientBehavior: 'raw',
        expectedFailure: {
          kind: 'untrusted_project_prompt_expanded',
          projectTrusted: false,
          catalogHasCommand: false,
          configuredLoopbackRequests: 1,
          literalSlashPersisted: false,
          sessionUserMessage: {
            matchCount: 1,
            byteLength: 29,
            sha256: 'e5e3815c2cd60916b0f73896826b76d7a4bc2977bbab196fbb4a69f5569268e1'
          },
          providerRequest: {
            count: 1,
            method: 'POST',
            path: '/v1/chat/completions',
            bodyWithinLimit: true,
            userMessage: {
              matchCount: 1,
              byteLength: 29,
              sha256: 'e5e3815c2cd60916b0f73896826b76d7a4bc2977bbab196fbb4a69f5569268e1'
            }
          }
        },
        networkBoundary: {
          configuredLoopbackRequests: 1,
          osEgressDenied: false
        }
      }
    case 'C0.7-XF03':
      return {
        ...common,
        upstreamLedgerId: 'X-03',
        trackingUrl: 'https://github.com/svkozak/pi-acp/issues/84',
        ownerCheckpoints: ['C3.4'],
        recheckTrigger: 'completion changes',
        clientBehavior: 'raw',
        expectedFailure: {
          kind: 'operation_timeout',
          errorName: 'AcpOperationTimeoutError',
          operation: 'session/prompt',
          timeoutMs: 1_500,
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
        }
      }
  }
}

function fixtureManifest(
  transcripts: Map<ImmutableTranscriptCase['id'], CanonicalTranscript>
): ImmutableTranscriptManifest {
  return {
    schemaVersion: 1,
    planId: 'PACP-CMD-2026-01',
    checkpoint: 'C0.7',
    status: 'blocked',
    blockedBy: {
      checkpoint: 'C0.3',
      reason: 'network-denied CI is pending',
      owner: 'task #2',
      trackingUrl: 'https://github.com/Eric-Song-Nop/pi-acp/issues/7',
      recheckDate: '2026-08-07'
    },
    recordedAt: '2026-07-31',
    storagePolicy: 'linux-darwin-localfs-nofollow-cas-v1',
    capturePolicy: {
      freshCaptureCount: 2,
      caseHardDeadlineMs: 30_000,
      loopbackBodyByteLimit: 65_536,
      loopbackBodyTimeoutMs: 2_000,
      loopbackCloseTimeoutMs: 1_000
    },
    compatibility: {
      adapter: {
        package: 'pi-acp',
        version: '0.0.33',
        baselineGitHead: ADAPTER_HEAD
      },
      pi: {
        package: '@earendil-works/pi-coding-agent',
        version: '0.83.0',
        gitHead: PI_HEAD,
        lockIntegrity: 'sha512-pi-test',
        installedTreeSha256: PI_TREE_SHA
      },
      acp: {
        protocolVersion: 1,
        sdkPackage: '@agentclientprotocol/sdk',
        sdkVersion: '0.26.0',
        sdkGitHead: SDK_HEAD,
        lockIntegrity: 'sha512-sdk-test',
        installedTreeSha256: SDK_TREE_SHA
      },
      clients: {
        repository: 'https://github.com/Eric-Song-Nop/pi-acp',
        raw: {
          id: 'raw-process-client',
          version: {
            kind: 'git',
            commit: ADAPTER_HEAD
          },
          sources: [
            {
              path: 'test/helpers/acp-process-client.ts',
              sha256: RAW_CLIENT_SHA
            }
          ]
        },
        strict: {
          id: 'strict-catalog-client',
          version: {
            kind: 'git',
            commit: ADAPTER_HEAD
          },
          sources: [
            {
              path: 'test/helpers/acp-process-client.ts',
              sha256: RAW_CLIENT_SHA
            },
            {
              path: 'test/helpers/strict-catalog-client.ts',
              sha256: STRICT_CLIENT_SHA
            }
          ]
        }
      },
      fixture: {
        id: 'pi-extension-pack-v1',
        sources: [
          {
            path: 'test/fixtures/pi-extension-pack/index.ts',
            sha256: FIXTURE_SOURCE_SHA
          },
          {
            path: 'test/fixtures/pi-extension-pack/project-canary.js',
            sha256: PROJECT_CANARY_SHA
          }
        ]
      }
    },
    recordingNodeVersions: [process.versions.node],
    cases: [...transcripts].map(([id, transcript]) => fixtureCase(id, transcript))
  }
}

test('C0.7 canonicalization sorts object keys and performs exact root/session substitutions', () => {
  const result = canonical('C0.7-XF01')
  const source = result.bytes.toString('utf8')
  assert.match(source, new RegExp(FIXTURE_ROOT_TOKEN.replaceAll('.', '\\.')))
  assert.match(source, new RegExp(SESSION_ID_TOKEN.replaceAll('.', '\\.')))
  assert.equal(source.includes('/tmp/c0.7-fixture'), false)
  assert.equal(source.includes('11111111-1111-4111-8111-111111111111'), false)
  assert.equal(parseCanonicalTranscript(result.bytes).length, 4)
  assert.equal(result.bytes.at(-1), 0x0a)
})

test('C0.7 canonicalization refuses reserved tokens, secrets, nonces, and unknown UUIDs', () => {
  for (const value of [
    FIXTURE_ROOT_TOKEN,
    'sk_agent_1234567890123456',
    'sk-123456789012',
    'prefix,(sk-proj-dummy-internal-hyphens-123456789012)!',
    'Bearer abcdefghijklmnop',
    'Basic YWxhZGRpbjpvcGVuc2VzYW1l',
    'https://alice:password@example.test/path',
    '0123456789abcdef0123456789abcdef',
    'nonce_0123456789abcdef01234567',
    'nonce_0123456789abcdef0123456789abcdef',
    '22222222-2222-4222-8222-222222222222',
    'session_01890f3e-7cc2-7a1b-8f00-0123456789ab',
    '01890f3e-7cc2-7a1b-8f00-0123456789ab_suffix',
    'trace=localhost:49152',
    'failed,/Users/alice/.ssh/id_rsa',
    'path[/Users/alice/.ssh/id_rsa]',
    'x;/etc/passwd',
    'x{/home/alice/key}',
    '錯誤：/Users/alice/.ssh/id_rsa',
    'failed to open file:///Users/alice/secret',
    String.raw`failed to open C:\Users\alice\secret`,
    String.raw`failed to open \\server\share\secret`,
    String.raw`failed to open \Users\alice\secret`
  ]) {
    let rejection: unknown
    try {
      canonicalizeTranscript(entries('C0.7-XF01', { poison: value }), {
        fixtureRoot: '/tmp/c0.7-fixture',
        sessionId: '11111111-1111-4111-8111-111111111111',
        forbiddenValues: []
      })
    } catch (error) {
      rejection = error
    }
    assert.ok(rejection instanceof Error)
    assert.match(rejection.message, /C0\.7/u)
    assert.equal(rejection.message.includes(value), false)
  }

  const credentialKey = 'prefix.sk-service-account-dummy-123456789012!'
  const keyed = entries('C0.7-XF01')
  const keyedMetadata = keyed[0]
  assert.equal(keyedMetadata.kind, 'meta')
  keyedMetadata.metadata[credentialKey] = 'value'
  assert.throws(
    () =>
      canonicalizeTranscript(keyed, {
        fixtureRoot: '/tmp/c0.7-fixture',
        sessionId: '11111111-1111-4111-8111-111111111111',
        forbiddenValues: []
      }),
    /credential-shaped/u
  )

  assert.doesNotThrow(() =>
    canonicalizeTranscript(entries('C0.7-XF02', { shortCredentialEdge: 'sk-12345678901', command: '/poison' }), {
      fixtureRoot: '/tmp/c0.7-fixture',
      sessionId: '11111111-1111-4111-8111-111111111111',
      forbiddenValues: []
    })
  )
  assert.throws(
    () =>
      canonicalizeTranscript(
        entries('C0.7-XF01', {
          combinedPath: '/tmp/c0.7-fixture/safe,/Users/alice/.ssh/id_rsa'
        }),
        {
          fixtureRoot: '/tmp/c0.7-fixture',
          sessionId: '11111111-1111-4111-8111-111111111111',
          forbiddenValues: []
        }
      ),
    /fixture-root token|absolute path/u
  )

  const protoEntries = entries('C0.7-XF01')
  const protoEntry = protoEntries[0]
  assert.equal(protoEntry.kind, 'meta')
  Object.defineProperty(protoEntry.metadata, '__proto__', {
    value: 'benign',
    enumerable: true,
    configurable: true,
    writable: true
  })
  assert.match(
    canonicalizeTranscript(protoEntries, {
      fixtureRoot: '/tmp/c0.7-fixture',
      sessionId: '11111111-1111-4111-8111-111111111111',
      forbiddenValues: []
    }).bytes.toString('utf8'),
    /"__proto__":"benign"/u
  )

  const committedProtoLeak = canonical('C0.7-XF01')
    .bytes.toString('utf8')
    .replace('"metadata":{', '"metadata":{"__proto__":"sk_agent_1234567890123456",')
  assert.throws(() => parseCanonicalTranscript(Buffer.from(committedProtoLeak)), /credential-shaped/u)

  const wrongFieldToken = canonicalizeTranscript(entries('C0.7-XF01', { wrongField: 'benign-token-value' }), {
    fixtureRoot: '/tmp/c0.7-fixture',
    sessionId: '11111111-1111-4111-8111-111111111111',
    forbiddenValues: []
  })
    .bytes.toString('utf8')
    .replace('"wrongField":"benign-token-value"', `"wrongField":"${SESSION_ID_TOKEN}"`)
  assert.throws(() => parseCanonicalTranscript(Buffer.from(wrongFieldToken)), /outside a sessionId field/u)
})

test('C0.7 redaction reconstructs ordered ACP text chunks before scanning', () => {
  const normalization = {
    fixtureRoot: '/tmp/c0.7-fixture',
    sessionId: '11111111-1111-4111-8111-111111111111',
    forbiddenValues: [C0_7_UNTRUSTED_PROMPT_CANARY]
  }
  assert.throws(
    () => canonicalizeTranscript(entriesWithTextChunks(['C0_7_UNTRUSTED_PROMPT_', 'CANARY\n']), normalization),
    /forbidden exact value/u
  )
  assert.throws(
    () =>
      canonicalizeTranscript(entriesWithTextChunks(['sk_agent_', '1234567890123456']), {
        ...normalization,
        forbiddenValues: []
      }),
    /credential-shaped/u
  )

  const safe = canonicalizeTranscript(entriesWithTextChunks(['C0_7_UNTRUSTED_PROMPT_', 'SAFE\n']), {
    ...normalization,
    forbiddenValues: []
  })
  const committedSplitCanary = safe.bytes.toString('utf8').replace('"text":"SAFE\\n"', '"text":"CANARY\\n"')
  assert.throws(() => parseCanonicalTranscript(Buffer.from(committedSplitCanary)), /forbidden exact value/u)

  const reconstructedVolatileValues = [
    {
      parts: ['01890f3e-7cc2-', '7a1b-8f00-0123456789ab'],
      rejection: /UUID/u
    },
    {
      parts: ['0123456789ab', 'cdef01234567'],
      rejection: /nonce/u
    },
    {
      parts: ['localhost:', '54321'],
      rejection: /loopback port/u
    },
    {
      parts: ['failed:/', 'Users/alice/.ssh/id_rsa'],
      rejection: /absolute path/u
    },
    {
      parts: ['<C0.7_SESSION_', 'ID>'],
      rejection: /reserved (?:normalization )?token/u
    },
    {
      parts: ['<C0.7_FIXTURE_', 'ROOT>'],
      rejection: /reserved (?:normalization )?token/u
    }
  ] as const
  for (const [index, candidate] of reconstructedVolatileValues.entries()) {
    assert.throws(
      () =>
        canonicalizeTranscript(entriesWithTextChunks(candidate.parts), {
          ...normalization,
          forbiddenValues: []
        }),
      candidate.rejection
    )

    const safeLeft = `safe-left-${String(index)}`
    const safeRight = `safe-right-${String(index)}`
    const safeArtifact = canonicalizeTranscript(entriesWithTextChunks([safeLeft, safeRight]), {
      ...normalization,
      forbiddenValues: []
    })
    const reconstructed = safeArtifact.bytes
      .toString('utf8')
      .replace(`"text":${JSON.stringify(safeLeft)}`, `"text":${JSON.stringify(candidate.parts[0])}`)
      .replace(`"text":${JSON.stringify(safeRight)}`, `"text":${JSON.stringify(candidate.parts[1])}`)
    assert.throws(() => parseCanonicalTranscript(Buffer.from(reconstructed)), candidate.rejection)
  }
})

test(
  'C0.7 forbidden-value checks inspect structured values and keys before JSON escaping',
  { timeout: 5_000 },
  async t => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'pi-acp-transcript-rejection-'))
    const artifactDir = join(root, 'artifacts')
    await mkdir(artifactDir, { mode: 0o700 })
    t.after(async () => {
      await rm(root, { recursive: true, force: true })
    })

    const escapedValues = [
      'forbidden LF\nvalue',
      'forbidden CRLF\r\nvalue',
      'forbidden "quote" value',
      'forbidden \\backslash value',
      'forbidden unicode \u2028 and control \u0000 value'
    ]
    for (const forbiddenValue of escapedValues) {
      const candidate = entries('C0.7-XF02', { poison: forbiddenValue })
      let rejection: unknown
      try {
        canonicalizeTranscript(candidate, {
          fixtureRoot: '/tmp/c0.7-fixture',
          sessionId: '11111111-1111-4111-8111-111111111111',
          forbiddenValues: [forbiddenValue]
        })
      } catch (error) {
        rejection = error
      }
      assert.ok(rejection instanceof Error)
      assert.match(rejection.message, /forbidden exact value/u)
      assert.equal(rejection.message.includes(forbiddenValue), false)
      assert.deepEqual(await readdir(artifactDir), [])
    }

    const forbiddenKey = 'forbidden key\nwith escape'
    const candidate = entries('C0.7-XF02')
    const metadata = candidate[0]
    assert.equal(metadata.kind, 'meta')
    metadata.metadata[forbiddenKey] = 'value'
    assert.throws(
      () =>
        canonicalizeTranscript(candidate, {
          fixtureRoot: '/tmp/c0.7-fixture',
          sessionId: '11111111-1111-4111-8111-111111111111',
          forbiddenValues: [forbiddenKey]
        }),
      /forbidden exact value/u
    )
    assert.deepEqual(await readdir(artifactDir), [])
  }
)

test('C0.7 XF02 evidence requires the same exact session and provider user-message value', () => {
  const sessionRecord = {
    type: 'message',
    message: {
      role: 'user',
      content: [
        {
          type: 'text',
          text: C0_7_UNTRUSTED_PROMPT_CANARY
        }
      ]
    }
  }
  const providerBody = Buffer.from(
    JSON.stringify({
      messages: [
        {
          role: 'system',
          content: 'fixture'
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: C0_7_UNTRUSTED_PROMPT_CANARY
            }
          ]
        }
      ]
    })
  )
  const request: LoopbackRequest = {
    method: 'POST',
    url: '/v1/chat/completions',
    host: '127.0.0.1:1',
    body: providerBody,
    bodyByteLength: providerBody.length,
    bodyExceededLimit: false
  }
  const sessionSource = `${JSON.stringify(sessionRecord)}\n`
  const evidence = deriveUntrustedPromptEvidence(sessionSource, [request])
  assert.equal(evidence.sessionUserMessage.sha256, evidence.providerRequest.userMessage.sha256)
  assert.equal(evidence.sessionUserMessage.byteLength, evidence.providerRequest.userMessage.byteLength)

  const canaryElsewhere = `${JSON.stringify({
    ...sessionRecord,
    message: {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'safe'
        }
      ]
    },
    diagnostic: C0_7_UNTRUSTED_PROMPT_CANARY
  })}\n`
  assert.throws(() => deriveUntrustedPromptEvidence(canaryElsewhere, [request]), /exactly one expected user-message/u)

  assert.throws(
    () =>
      deriveUntrustedPromptEvidence(sessionSource, [
        {
          method: 'GET',
          url: '/unrelated',
          host: '127.0.0.1:1',
          body: Buffer.alloc(0),
          bodyByteLength: 0,
          bodyExceededLimit: false
        }
      ]),
    /not one bounded POST/u
  )
})

test('C0.7 canonical NDJSON rejects CRLF, BOM, missing final LF, blank lines, and noncanonical keys', () => {
  const valid = canonical('C0.7-XF01').bytes.toString('utf8')
  const invalidSources = {
    crlf: valid.replaceAll('\n', '\r\n'),
    bom: `\uFEFF${valid}`,
    missingFinalLf: valid.slice(0, -1),
    blankFinalRecord: `${valid}\n`,
    noncanonicalKeys: valid.replace(
      '{"clientBehavior":"strict","kind":"meta"',
      '{"kind":"meta","clientBehavior":"strict"'
    )
  }
  for (const [label, invalid] of Object.entries(invalidSources)) {
    assert.throws(() => parseCanonicalTranscript(Buffer.from(invalid)), /C0\.7/u, label)
  }
})

test('C0.7 manifest validation rejects unsorted cases and digest/path disagreement', () => {
  const transcripts = new Map<ImmutableTranscriptCase['id'], CanonicalTranscript>([
    ['C0.7-XF01', canonical('C0.7-XF01')],
    ['C0.7-XF02', canonical('C0.7-XF02')],
    ['C0.7-XF03', canonical('C0.7-XF03')]
  ])
  const manifest = fixtureManifest(transcripts)
  assert.deepEqual(validateImmutableManifest(manifest), manifest)

  const unsorted = structuredClone(manifest)
  unsorted.cases.reverse()
  assert.throws(() => validateImmutableManifest(unsorted), /sorted/u)

  const wrongPath = structuredClone(manifest)
  wrongPath.cases[0].artifact.path = `artifacts/sha256-${'f'.repeat(64)}.ndjson`
  assert.throws(() => validateImmutableManifest(wrongPath), /digest/u)

  const swappedIdentity = structuredClone(manifest)
  swappedIdentity.cases[0].upstreamLedgerId = 'X-03'
  assert.throws(() => validateImmutableManifest(swappedIdentity), /identity/u)

  const contradictoryCatalog = structuredClone(manifest)
  const catalogFailure = contradictoryCatalog.cases[0].expectedFailure
  assert.equal(catalogFailure.kind, 'command_not_advertised')
  catalogFailure.advertisedNames.push('fixture-state')
  assert.throws(() => validateImmutableManifest(contradictoryCatalog), /exact frozen catalog/u)

  const mismatchedPromptEvidence = structuredClone(manifest)
  const promptFailure = mismatchedPromptEvidence.cases[1].expectedFailure
  assert.equal(promptFailure.kind, 'untrusted_project_prompt_expanded')
  promptFailure.providerRequest.userMessage.sha256 = '3'.repeat(64)
  assert.throws(() => validateImmutableManifest(mismatchedPromptEvidence), /same frozen prompt/u)

  const authenticatedUrl = structuredClone(manifest)
  authenticatedUrl.cases[1].trackingUrl =
    'https://sk_agent_dummy1234567890123456@github.com/Eric-Song-Nop/pi-acp/issues/6'
  assert.throws(() => validateImmutableManifest(authenticatedUrl), /canonical https/u)

  const impossibleDate = structuredClone(manifest)
  impossibleDate.recordedAt = '2026-02-30'
  assert.throws(() => validateImmutableManifest(impossibleDate), /real UTC calendar date/u)

  const recheckBeforeRecording = structuredClone(manifest)
  recheckBeforeRecording.recordedAt = '2026-08-08'
  assert.throws(() => validateImmutableManifest(recheckBeforeRecording), /must not precede/u)
})

test(
  'C0.7 publisher uses content addressing, no-follow reads, CAS, and an exclusive lock',
  { timeout: 10_000 },
  async t => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(await realpath(tmpdir()), 'pi-acp-transcript-unit-'))
    await chmod(root, 0o700)
    await mkdir(join(root, 'artifacts'), { mode: 0o700 })
    t.after(async () => {
      await rm(root, { recursive: true, force: true })
    })

    const transcripts = new Map<ImmutableTranscriptCase['id'], CanonicalTranscript>([
      ['C0.7-XF01', canonical('C0.7-XF01')],
      ['C0.7-XF02', canonical('C0.7-XF02')],
      ['C0.7-XF03', canonical('C0.7-XF03')]
    ])
    const manifest = fixtureManifest(transcripts)
    const artifacts = new Map([...transcripts.values()].map(transcript => [transcript.sha256, transcript.bytes]))
    const published = await publishTranscriptUpdate({
      root,
      expectedOldManifestSha256: 'absent',
      manifest,
      artifacts
    })
    assert.match(published.manifestSha256, /^[0-9a-f]{64}$/u)
    assert.equal((await readVerifiedManifest(root)).sha256, published.manifestSha256)

    await assert.rejects(
      publishTranscriptUpdate({
        root,
        expectedOldManifestSha256: '0'.repeat(64),
        manifest,
        artifacts
      }),
      /CAS mismatch/u
    )
    assert.equal((await readVerifiedManifest(root)).sha256, published.manifestSha256)

    await writeFile(join(root, '.update.lock'), 'occupied\n', {
      mode: 0o600,
      flag: 'wx'
    })
    await assert.rejects(
      publishTranscriptUpdate({
        root,
        expectedOldManifestSha256: published.manifestSha256,
        manifest,
        artifacts
      }),
      /lock (?:has an invalid identity|owner is invalid)/u
    )
    await unlink(join(root, '.update.lock'))

    const activeLockOwner = {
      pid: process.pid,
      processStartSha256: await currentProcessStartSha256()
    }
    const originalTz = process.env.TZ
    try {
      for (const timezone of ['Pacific/Honolulu', 'Asia/Shanghai']) {
        process.env.TZ = timezone
        await writeFile(join(root, '.update.lock'), `${JSON.stringify(activeLockOwner)}\n`, {
          mode: 0o600,
          flag: 'wx'
        })
        await assert.rejects(
          publishTranscriptUpdate({
            root,
            expectedOldManifestSha256: published.manifestSha256,
            manifest,
            artifacts
          }),
          (error: unknown) => {
            assert.equal((error as NodeJS.ErrnoException).code, 'EEXIST')
            return true
          }
        )
        await unlink(join(root, '.update.lock'))
      }
    } finally {
      if (originalTz === undefined) delete process.env.TZ
      else process.env.TZ = originalTz
    }

    await writeFile(join(root, '.update.lock'), `${JSON.stringify(activeLockOwner)}\n`, {
      mode: 0o600,
      flag: 'wx'
    })
    const releaseLiveReaderLock = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        void unlink(join(root, '.update.lock')).then(resolve, reject)
      }, 75)
    })
    assert.equal((await verifyCommittedTranscripts(root)).status, 'blocked')
    await releaseLiveReaderLock

    await writeFile(
      join(root, '.update.lock'),
      `${JSON.stringify({
        pid: process.pid,
        processStartSha256: '0'.repeat(64)
      })}\n`,
      {
        mode: 0o600,
        flag: 'wx'
      }
    )
    const recovered = await publishTranscriptUpdate({
      root,
      expectedOldManifestSha256: published.manifestSha256,
      manifest,
      artifacts
    })
    assert.equal(recovered.manifestSha256, published.manifestSha256)

    const recoveredArtifact = canonicalizeTranscript(entries('C0.7-XF01', { recovery: 'link-before-unlink' }), {
      fixtureRoot: '/tmp/c0.7-fixture',
      sessionId: '11111111-1111-4111-8111-111111111111',
      forbiddenValues: []
    })
    const staleArtifactTemporary = join(root, 'artifacts', `.artifact-${String(process.pid)}-${'a'.repeat(24)}.tmp`)
    const recoveredArtifactPath = join(root, 'artifacts', `sha256-${recoveredArtifact.sha256}.ndjson`)
    await writeFile(staleArtifactTemporary, recoveredArtifact.bytes, {
      mode: 0o444,
      flag: 'wx'
    })
    await link(staleArtifactTemporary, recoveredArtifactPath)
    const staleManifestTemporary = join(root, `.manifest-${String(process.pid)}-${'b'.repeat(24)}.tmp`)
    const staleLockTemporary = join(root, `.update-lock-${String(process.pid)}-${'c'.repeat(24)}.tmp`)
    await writeFile(staleManifestTemporary, 'stale manifest temporary\n', {
      mode: 0o600,
      flag: 'wx'
    })
    await writeFile(staleLockTemporary, 'stale lock temporary\n', {
      mode: 0o600,
      flag: 'wx'
    })
    await writeFile(
      join(root, '.update.lock'),
      `${JSON.stringify({
        pid: process.pid,
        processStartSha256: '0'.repeat(64)
      })}\n`,
      {
        mode: 0o600,
        flag: 'wx'
      }
    )
    assert.equal((await verifyCommittedTranscripts(root)).status, 'blocked')
    await publishTranscriptUpdate({
      root,
      expectedOldManifestSha256: recovered.manifestSha256,
      manifest,
      artifacts
    })
    for (const temporary of [staleArtifactTemporary, staleManifestTemporary, staleLockTemporary]) {
      await assert.rejects(readFile(temporary), (error: unknown) => {
        assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT')
        return true
      })
    }
    assert.deepEqual(await readFile(recoveredArtifactPath), recoveredArtifact.bytes)

    const firstCase = manifest.cases[0]
    const artifactPath = join(root, firstCase.artifact.path)
    await chmod(join(root, 'manifest.json'), 0o644)
    for (const item of manifest.cases) await chmod(join(root, item.artifact.path), 0o644)
    await verifyCommittedTranscripts(root)
    await chmod(artifactPath, 0o664)
    await assert.rejects(verifyCommittedTranscripts(root), /group\/world writable/u)
    await chmod(artifactPath, 0o644)

    const historical = canonicalizeTranscript(entries('C0.7-XF01', { historical: 'benign-old-value' }), {
      fixtureRoot: '/tmp/c0.7-fixture',
      sessionId: '11111111-1111-4111-8111-111111111111',
      forbiddenValues: []
    })
    const historicalPath = join(root, 'artifacts', `sha256-${historical.sha256}.ndjson`)
    await writeFile(historicalPath, historical.bytes, { mode: 0o444, flag: 'wx' })
    await verifyCommittedTranscripts(root)

    const maliciousBytes = Buffer.from(
      historical.bytes
        .toString('utf8')
        .replace('"historical":"benign-old-value"', '"historical":"sk_agent_1234567890123456"')
    )
    const maliciousSha = createHash('sha256').update(maliciousBytes).digest('hex')
    const maliciousPath = join(root, 'artifacts', `sha256-${maliciousSha}.ndjson`)
    await writeFile(maliciousPath, maliciousBytes, { mode: 0o444, flag: 'wx' })
    await assert.rejects(verifyCommittedTranscripts(root), /credential-shaped/u)
    await unlink(maliciousPath)

    const artifactBytes = await readFile(artifactPath)
    const artifactSymlinkTarget = join(root, '.artifact-symlink-target')
    await writeFile(artifactSymlinkTarget, artifactBytes, { mode: 0o644, flag: 'wx' })
    await unlink(artifactPath)
    await symlink(artifactSymlinkTarget, artifactPath)
    await assert.rejects(verifyCommittedTranscripts(root), /unapproved entry/u)
    await unlink(artifactPath)
    await writeFile(artifactPath, artifactBytes, { mode: 0o644, flag: 'wx' })
    await unlink(artifactSymlinkTarget)

    const manifestBytes = await readFile(join(root, 'manifest.json'))
    const manifestSymlinkTarget = join(root, '.manifest-symlink-target')
    await writeFile(manifestSymlinkTarget, manifestBytes, { mode: 0o644, flag: 'wx' })
    await unlink(join(root, 'manifest.json'))
    await symlink(manifestSymlinkTarget, join(root, 'manifest.json'))
    await assert.rejects(readVerifiedManifest(root), /regular file/u)
    await unlink(join(root, 'manifest.json'))
    await writeFile(join(root, 'manifest.json'), manifestBytes, { mode: 0o644, flag: 'wx' })
    await unlink(manifestSymlinkTarget)

    const symlinkRoot = join(root, 'symlink-root')
    await mkdir(symlinkRoot, { mode: 0o700 })
    await mkdir(join(symlinkRoot, 'real-artifacts'), { mode: 0o700 })
    await symlink('real-artifacts', join(symlinkRoot, 'artifacts'))
    await assert.rejects(readVerifiedManifest(symlinkRoot), /evidence ancestor/u)

    const secondLink = join(root, 'artifacts', 'second-link.ndjson')
    await link(artifactPath, secondLink)
    await assert.rejects(readVerifiedArtifact(root, firstCase), /hard-link count/u)
    await unlink(secondLink)
  }
)

test('C0.7 updater CLI parser requires explicit scope, CAS, and acceptance', () => {
  assert.deepEqual(
    parseTranscriptUpdateArgs([
      '--case',
      'C0.7-XF01',
      '--case',
      'C0.7-XF02',
      '--case',
      'C0.7-XF03',
      '--expected-old-manifest-sha',
      'absent',
      '--recheck-date',
      '2026-08-07',
      '--accept-baseline-change'
    ]),
    {
      cases: ['C0.7-XF01', 'C0.7-XF02', 'C0.7-XF03'],
      expectedOldManifestSha256: 'absent',
      recheckDate: '2026-08-07'
    }
  )
  for (const args of [
    [],
    ['--case', 'unknown'],
    ['--case', 'C0.7-XF01', '--case', 'C0.7-XF01'],
    ['--case', 'C0.7-XF01', '--expected-old-manifest-sha', 'absent'],
    [
      '--case',
      'C0.7-XF01',
      '--case',
      'C0.7-XF02',
      '--case',
      'C0.7-XF03',
      '--expected-old-manifest-sha',
      'absent',
      '--recheck-date',
      'bad',
      '--accept-baseline-change'
    ],
    ['--wat']
  ]) {
    assert.throws(() => parseTranscriptUpdateArgs(args), /./u)
  }
})

test('C0.7 installed-package tree identity binds content and rejects symlinks', async t => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pi-acp-installed-tree-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  await mkdir(join(root, 'dist'), { mode: 0o700 })
  await writeFile(join(root, 'package.json'), '{"name":"fixture"}\n')
  await writeFile(join(root, 'dist', 'index.js'), 'export const value = 1\n')
  const first = await installedPackageTreeSha256(root)
  await writeFile(join(root, 'dist', 'index.js'), 'export const value = 2\n')
  const second = await installedPackageTreeSha256(root)
  assert.match(first, /^[0-9a-f]{64}$/u)
  assert.notEqual(second, first)

  await symlink(join(root, 'dist', 'index.js'), join(root, 'dist', 'linked.js'))
  await assert.rejects(installedPackageTreeSha256(root), /contains a symlink/u)
})
