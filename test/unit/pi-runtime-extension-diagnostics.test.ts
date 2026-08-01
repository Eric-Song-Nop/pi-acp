import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { join } from 'node:path'
import test from 'node:test'
import {
  PI_DIAGNOSTIC_REDACTION,
  PI_RUNTIME_EXTENSION_EVENT_LIMIT_BYTES,
  PI_RUNTIME_EXTENSION_SOURCE_LIMIT_BYTES,
  PI_RUNTIME_EXTENSION_SUMMARY_LIMIT_BYTES,
  PI_STARTUP_TRUNCATION_MARKER,
  formatPiRuntimeExtensionError,
  type PiStartupDiagnosticOptions
} from '../../src/pi-rpc/diagnostics.js'

const cwd = '/workspace/acme'
const agentDir = '/home/tester/.pi/agent'

function options(env: NodeJS.ProcessEnv = {}): PiStartupDiagnosticOptions {
  return { cwd, agentDir, env }
}

test('runtime extension diagnostics expose the frozen canonical shape', () => {
  const extensionPath = join(cwd, '.pi', 'extensions', 'failing.ts')
  const diagnostic = formatPiRuntimeExtensionError(
    {
      type: 'extension_error',
      extensionPath,
      event: 'before_agent_start',
      error: 'C1.2_SAFE_REASON',
      stack: `C1.2_PRIVATE_STACK at ${join(cwd, 'private-stack.ts')}:1:1`
    },
    options()
  )

  assert.deepEqual(diagnostic, {
    schemaVersion: 1,
    code: 'PI_EXTENSION_RUNTIME_ERROR',
    phase: 'runtime',
    source: 'project:.pi/extensions/failing.ts',
    event: 'before_agent_start',
    summary:
      'Pi extension error (source: project:.pi/extensions/failing.ts; event: before_agent_start):\nC1.2_SAFE_REASON',
    truncated: false,
    redacted: true,
    summaryLimitBytes: 4_096
  })
  assert.equal(Object.isFrozen(diagnostic), true)
  assert.equal(JSON.stringify(diagnostic).includes(extensionPath), false)
  assert.equal(JSON.stringify(diagnostic).includes('C1.2_PRIVATE_STACK'), false)
  assert.equal(PI_RUNTIME_EXTENSION_SUMMARY_LIMIT_BYTES, 4_096)
  assert.equal(PI_RUNTIME_EXTENSION_SOURCE_LIMIT_BYTES, 512)
  assert.equal(PI_RUNTIME_EXTENSION_EVENT_LIMIT_BYTES, 128)
})

test('runtime extension diagnostics label project, global, external, relative, and unknown sources', () => {
  const cases = [
    {
      extensionPath: join(cwd, 'extensions', 'project.ts'),
      source: 'project:extensions/project.ts'
    },
    {
      extensionPath: join(agentDir, 'extensions', 'global.ts'),
      source: 'global:extensions/global.ts'
    },
    {
      extensionPath: './.pi/extensions/relative.ts',
      source: 'project:.pi/extensions/relative.ts'
    },
    {
      extensionPath: '/Users/alice/private/external.ts',
      source: 'external:<redacted>'
    }
  ] as const

  for (const entry of cases) {
    const diagnostic = formatPiRuntimeExtensionError(
      {
        extensionPath: entry.extensionPath,
        event: 'tool_call',
        error: 'handler failed'
      },
      options()
    )

    assert.equal(diagnostic.source, entry.source)
    assert.equal(diagnostic.summary, `Pi extension error (source: ${entry.source}; event: tool_call):\nhandler failed`)
    assert.equal(diagnostic.summary.includes(entry.extensionPath), false)
    assert.equal(diagnostic.redacted, true)
  }

  const unknown = formatPiRuntimeExtensionError(
    { event: 'tool_call', error: 'missing source remains actionable' },
    options()
  )
  assert.equal(unknown.source, 'unknown')
  assert.equal(
    unknown.summary,
    'Pi extension error (source: unknown; event: tool_call):\nmissing source remains actionable'
  )
  assert.equal(unknown.redacted, true)

  const oversizedPath = join(cwd, 'extensions', `${'界'.repeat(600)}.ts`)
  const oversized = formatPiRuntimeExtensionError(
    { extensionPath: oversizedPath, event: 'tool_call', error: 'bounded source' },
    options()
  )
  assert.equal(oversized.source, 'external:<redacted>')
  assert.ok(Buffer.byteLength(oversized.source, 'utf8') <= PI_RUNTIME_EXTENSION_SOURCE_LIMIT_BYTES)
  assert.equal(oversized.summary.includes(oversizedPath), false)

  const whitespaceWrappedPath = ' /Users/alice/private/runtime.ts '
  const whitespaceWrapped = formatPiRuntimeExtensionError(
    { extensionPath: whitespaceWrappedPath, event: 'tool_call', error: 'malformed source' },
    options()
  )
  assert.equal(whitespaceWrapped.source, 'external:<redacted>')
  assert.equal(whitespaceWrapped.summary.includes(whitespaceWrappedPath), false)
  assert.equal(whitespaceWrapped.redacted, true)
})

test('runtime extension diagnostics use independent deterministic fallbacks and never inspect stack', () => {
  let stackReads = 0
  const malformed = {
    extensionPath: 42,
    event: '',
    error: new Error('C1.2_PRIVATE_ERROR_MESSAGE'),
    get stack(): string {
      stackReads += 1
      throw new Error('C1.2_PRIVATE_STACK_GETTER')
    }
  }

  let diagnostic: ReturnType<typeof formatPiRuntimeExtensionError> | undefined
  assert.doesNotThrow(() => {
    diagnostic = formatPiRuntimeExtensionError(malformed, options())
  })

  assert.deepEqual(diagnostic, {
    schemaVersion: 1,
    code: 'PI_EXTENSION_RUNTIME_ERROR',
    phase: 'runtime',
    source: 'unknown',
    event: 'unknown',
    summary: 'Pi extension error (source: unknown; event: unknown):\nPi reported an extension runtime error.',
    truncated: false,
    redacted: true,
    summaryLimitBytes: 4_096
  })
  assert.equal(stackReads, 0)
  assert.equal(JSON.stringify(diagnostic).includes('C1.2_PRIVATE_ERROR_MESSAGE'), false)

  const throwingInput = new Proxy(
    {},
    {
      get() {
        throw new Error('C1.2_PRIVATE_THROWING_GETTER')
      }
    }
  )
  let throwingDiagnostic: ReturnType<typeof formatPiRuntimeExtensionError> | undefined
  assert.doesNotThrow(() => {
    throwingDiagnostic = formatPiRuntimeExtensionError(throwingInput, options())
  })
  assert.ok(throwingDiagnostic)
  assert.equal(throwingDiagnostic.source, 'unknown')
  assert.equal(throwingDiagnostic.event, 'unknown')
  assert.equal(
    throwingDiagnostic.summary,
    'Pi extension error (source: unknown; event: unknown):\nPi reported an extension runtime error.'
  )

  const malformedReason = formatPiRuntimeExtensionError(
    {
      extensionPath: join(cwd, '.pi', 'extensions', 'valid-source.ts'),
      event: 'tool_call',
      error: '\ud800'
    },
    options()
  )
  assert.equal(malformedReason.source, 'project:.pi/extensions/valid-source.ts')
  assert.equal(malformedReason.event, 'tool_call')
  assert.equal(
    malformedReason.summary,
    'Pi extension error (source: project:.pi/extensions/valid-source.ts; event: tool_call):\n' +
      'Pi reported an extension runtime error.'
  )
  assert.equal(malformedReason.redacted, true)
})

test('runtime extension diagnostics apply current control, path, credential, env, and actionability rules', () => {
  const alreadySafe = formatPiRuntimeExtensionError(
    {
      extensionPath: 'external:<redacted>',
      event: 'signatureAlgorithm',
      error: 'signatureAlgorithm=ed25519 C1.2_SAFE_ACTION'
    },
    options()
  )
  assert.equal(alreadySafe.source, 'external:<redacted>')
  assert.equal(alreadySafe.event, 'signatureAlgorithm')
  assert.equal(alreadySafe.summary.includes('signatureAlgorithm=ed25519 C1.2_SAFE_ACTION'), true)
  assert.equal(alreadySafe.redacted, false)

  const privatePath = '/Users/alice/private/runtime-stack.ts'
  const sanitized = formatPiRuntimeExtensionError(
    {
      extensionPath: join(cwd, '.pi', 'extensions', 'private.ts'),
      event: '\u001b[31mbefore_agent_start\u001b[0m',
      error:
        `\u001b[31mC1.2_SAFE_PREFIX\u001b[0m env=exact-env-secret-123 ` +
        `known=sk_agent_ABCDEFGH1234\n    at handler (${privatePath}:4:2)`
    },
    options({ SERVICE_API_KEY: 'exact-env-secret-123' })
  )

  assert.equal(sanitized.event, 'before_agent_start')
  assert.equal(sanitized.summary.includes('C1.2_SAFE_PREFIX'), true)
  assert.equal(sanitized.summary.includes('exact-env-secret-123'), false)
  assert.equal(sanitized.summary.includes('sk_agent_ABCDEFGH1234'), false)
  assert.equal(sanitized.summary.includes(privatePath), false)
  assert.equal(sanitized.summary.includes(PI_DIAGNOSTIC_REDACTION), true)
  assert.equal(sanitized.summary.includes('\u001b'), false)
  assert.equal(sanitized.redacted, true)
})

test('runtime extension diagnostics retain actionable prefixes before sensitive assignments', () => {
  const cases = [
    {
      error: 'Initialization failed: apiKey=PRIVATE_PLAIN_VALUE',
      expectedPrefix: 'Initialization failed: '
    },
    {
      error: 'C1.2_SAFE_PREFIX headers["Authorization"]="PRIVATE_BRACKET_VALUE"',
      expectedPrefix: 'C1.2_SAFE_PREFIX '
    },
    {
      error: 'C1.2_SAFE_PREFIX outer=token=PRIVATE_NESTED_VALUE',
      expectedPrefix: 'C1.2_SAFE_PREFIX '
    },
    {
      error: 'Initialization failed: API Key: PRIVATE_SPACED_VALUE',
      expectedPrefix: 'Initialization failed: '
    },
    {
      error: 'C1.2_SAFE_PREFIX headers["API Key"]=PRIVATE_BRACKET_SPACED_VALUE',
      expectedPrefix: 'C1.2_SAFE_PREFIX '
    },
    {
      error: 'C1.2_SAFE_PREFIX headers["API Key"][0]=PRIVATE_MULTI_BRACKET_VALUE',
      expectedPrefix: 'C1.2_SAFE_PREFIX '
    },
    {
      error: 'C1.2_SAFE_PREFIX outer=API Key[0]=PRIVATE_NESTED_SPACED_VALUE',
      expectedPrefix: 'C1.2_SAFE_PREFIX '
    },
    {
      error: 'C1.2_SAFE_PREFIX headers[API][Key]=PRIVATE_SPLIT_VALUE',
      expectedPrefix: 'C1.2_SAFE_PREFIX '
    },
    {
      error: 'C1.2_SAFE_PREFIX headers[API][Key][0]=PRIVATE_SPLIT_INDEX_VALUE',
      expectedPrefix: 'C1.2_SAFE_PREFIX '
    },
    {
      error: 'C1.2_SAFE_PREFIX API[Key][0]=PRIVATE_PRIMARY_SPLIT_INDEX_VALUE',
      expectedPrefix: 'C1.2_SAFE_PREFIX '
    },
    {
      error: 'C1.2_SAFE_PREFIX headers["x]Authorization"]=PRIVATE_QUOTED_BRACKET_VALUE',
      expectedPrefix: 'C1.2_SAFE_PREFIX '
    },
    {
      error: 'C1.2_SAFE_PREFIX headers["x\\]Authorization"][0]=PRIVATE_ESCAPED_BRACKET_VALUE',
      expectedPrefix: 'C1.2_SAFE_PREFIX '
    },
    {
      error: "C1.2_SAFE_PREFIX headers['x\\]API Key'][0]=PRIVATE_ESCAPED_SPACED_VALUE",
      expectedPrefix: 'C1.2_SAFE_PREFIX '
    },
    {
      error: 'C1.2_SAFE_PREFIX headers[API][0][Key]=PRIVATE_INTERPOSED_INDEX_VALUE',
      expectedPrefix: 'C1.2_SAFE_PREFIX '
    },
    {
      error: 'C1.2_SAFE_PREFIX API[0][Key]=PRIVATE_PRIMARY_INTERPOSED_INDEX_VALUE',
      expectedPrefix: 'C1.2_SAFE_PREFIX '
    }
  ] as const

  for (const entry of cases) {
    const diagnostic = formatPiRuntimeExtensionError(
      {
        extensionPath: 'external:<redacted>',
        event: 'before_agent_start',
        error: entry.error
      },
      options()
    )
    const reason = diagnostic.summary.slice(diagnostic.summary.indexOf('\n') + 1)

    assert.equal(reason.startsWith(entry.expectedPrefix), true, entry.error)
    assert.equal(reason.includes(PI_DIAGNOSTIC_REDACTION), true, entry.error)
    assert.equal(reason.includes('PRIVATE_'), false, entry.error)
    assert.equal(diagnostic.redacted, true, entry.error)
  }
})

test('runtime extension diagnostics retain benign sensitive words that are not assignment-name suffixes', () => {
  const reasons = [
    'Token refresh failed: service unavailable',
    'Authorization handshake failed: unsupported scheme',
    'C1.2_SAFE_PREFIX token count=VISIBLE_VALUE',
    'headers["service token metadata"]=VISIBLE_VALUE'
  ] as const

  for (const reason of reasons) {
    const diagnostic = formatPiRuntimeExtensionError(
      {
        extensionPath: 'external:<redacted>',
        event: 'before_agent_start',
        error: reason
      },
      options()
    )

    assert.equal(diagnostic.summary.endsWith(reason), true, reason)
    assert.equal(diagnostic.redacted, false, reason)
  }
})

test('runtime extension diagnostics normalize terminal sequences before applying existing privacy matchers', () => {
  const cases = [
    {
      error: '\u001b[31m/Users/alice/private/runtime.ts\u001b[0m',
      forbidden: '/Users/alice/private/runtime.ts',
      env: {}
    },
    {
      error: '\u001b[31mC:\\Users\\alice\\private\\runtime.ts\u001b[0m',
      forbidden: 'C:\\Users\\alice\\private\\runtime.ts',
      env: {}
    },
    {
      error: '\u001b[31mfile:///Users/alice/private/runtime.ts\u001b[0m',
      forbidden: 'file:///Users/alice/private/runtime.ts',
      env: {}
    },
    {
      error: 'sk_\u001b[31magent_ABCDEFGH1234\u001b[0m',
      forbidden: 'sk_agent_ABCDEFGH1234',
      env: {}
    },
    {
      error: 'exact-\u001b[31menv-secret-123\u001b[0m',
      forbidden: 'exact-env-secret-123',
      env: { SERVICE_API_KEY: 'exact-env-secret-123' }
    }
  ] as const

  for (const entry of cases) {
    const diagnostic = formatPiRuntimeExtensionError(
      {
        extensionPath: 'external:<redacted>',
        event: 'before_agent_start',
        error: entry.error
      },
      options(entry.env)
    )

    assert.equal(diagnostic.summary.includes(entry.forbidden), false)
    assert.equal(diagnostic.summary.includes('\u001b'), false)
    assert.equal(diagnostic.redacted, true)
  }
})

test('runtime extension diagnostics count tidy-only event and reason normalization as redaction', () => {
  const tidyEvent = formatPiRuntimeExtensionError(
    {
      extensionPath: 'external:<redacted>',
      event: ' tool_call ',
      error: 'event normalization remains actionable'
    },
    options()
  )
  assert.equal(tidyEvent.event, 'tool_call')
  assert.equal(tidyEvent.redacted, true)

  const tidyReason = formatPiRuntimeExtensionError(
    {
      extensionPath: 'external:<redacted>',
      event: 'tool_call',
      error: 'reason remains actionable   '
    },
    options()
  )
  assert.equal(
    tidyReason.summary,
    'Pi extension error (source: external:<redacted>; event: tool_call):\nreason remains actionable'
  )
  assert.equal(tidyReason.redacted, true)
})

test('runtime extension event labels honor the exact UTF-8 byte boundary', () => {
  const exactEvent = '😀'.repeat(32)
  assert.equal(Buffer.byteLength(exactEvent, 'utf8'), PI_RUNTIME_EXTENSION_EVENT_LIMIT_BYTES)
  const exact = formatPiRuntimeExtensionError(
    { extensionPath: 'external:<redacted>', event: exactEvent, error: 'exact event boundary' },
    options()
  )
  assert.equal(exact.event, exactEvent)
  assert.equal(exact.truncated, false)
  assert.equal(exact.redacted, false)

  const over = formatPiRuntimeExtensionError(
    { extensionPath: 'external:<redacted>', event: `${exactEvent}x`, error: 'over event boundary' },
    options()
  )
  assert.equal(over.event, exactEvent)
  assert.equal(Buffer.byteLength(over.event, 'utf8'), PI_RUNTIME_EXTENSION_EVENT_LIMIT_BYTES)
  assert.equal(over.truncated, true)
  assert.equal(over.redacted, true)
  assert.equal(over.summary.includes(`${exactEvent}x`), false)
})

test('runtime extension summaries retain their prefix and truncate on complete UTF-8 characters', () => {
  const source = 'external:<redacted>'
  const event = 'tool_call'
  const prefix = `Pi extension error (source: ${source}; event: ${event}):\n`
  const exactReason = 'a'.repeat(PI_RUNTIME_EXTENSION_SUMMARY_LIMIT_BYTES - Buffer.byteLength(prefix, 'utf8'))
  const exact = formatPiRuntimeExtensionError({ extensionPath: source, event, error: exactReason }, options())
  assert.equal(Buffer.byteLength(exact.summary, 'utf8'), PI_RUNTIME_EXTENSION_SUMMARY_LIMIT_BYTES)
  assert.equal(exact.summary, `${prefix}${exactReason}`)
  assert.equal(exact.truncated, false)
  assert.equal(exact.redacted, false)

  const over = formatPiRuntimeExtensionError({ extensionPath: source, event, error: '🌍'.repeat(2_000) }, options())
  assert.equal(over.summary.startsWith(`${prefix}${PI_STARTUP_TRUNCATION_MARKER}`), true)
  assert.ok(Buffer.byteLength(over.summary, 'utf8') <= PI_RUNTIME_EXTENSION_SUMMARY_LIMIT_BYTES)
  assert.equal(over.summary.includes('\ufffd'), false)
  assert.equal(over.truncated, true)
  assert.equal(over.redacted, true)
})
