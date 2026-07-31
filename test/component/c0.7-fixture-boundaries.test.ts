import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { connect, type Socket } from 'node:net'
import { performance } from 'node:perf_hooks'
import test from 'node:test'
import {
  BaselineSignatureMismatchError,
  runWithinFixtureDeadline,
  runUntrustedPromptUnrelatedRequestControl
} from '../helpers/real-pi-baseline-scenarios.js'
import { RealPiFixtureDeadlineError, startRealPiFixture } from '../helpers/real-pi-fixture.js'

const TEST_GIT_HEAD = '0'.repeat(40)

async function connectedSocket(port: number): Promise<Socket> {
  return await new Promise<Socket>((resolve, reject) => {
    const socket = connect({
      host: '127.0.0.1',
      port
    })
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

async function assertPortClosed(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect({
      host: '127.0.0.1',
      port
    })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('C0.7 loopback port remained reachable past the close deadline'))
    }, 1_000)
    timer.unref()
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      reject(new Error('C0.7 loopback port accepted a connection after cleanup'))
    })
    socket.once('error', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function readSocketResponse(socket: Socket): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let source = ''
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(source)
    }
    const timer = setTimeout(() => {
      socket.destroy()
      finish(new Error('C0.7 partial request did not receive a bounded terminal response'))
    }, 5_000)
    timer.unref()
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      source += chunk
    })
    socket.once('end', () => finish())
    socket.once('close', () => finish())
    socket.once('error', finish)
  })
}

test('C0.7 fixture records completed and timed-out accepted requests exactly once', { timeout: 15_000 }, async t => {
  const fixture = await startRealPiFixture({
    transcriptCheckpoint: 'C0.7',
    transcriptCaseId: 'C0.7-request-observation-control',
    transcriptMetadata: {
      baselineGitHead: TEST_GIT_HEAD
    }
  })
  t.after(async () => {
    await fixture.cleanup()
  })

  const completedBody = Buffer.from('{"control":"completed"}')
  const completedStatus = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(
      {
        host: fixture.loopbackAddress.host,
        port: fixture.loopbackAddress.port,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: {
          'content-length': completedBody.length
        }
      },
      response => {
        response.resume()
        response.once('end', () => resolve(response.statusCode))
        response.once('error', reject)
      }
    )
    request.once('error', reject)
    request.end(completedBody)
  })
  assert.equal(completedStatus, 503)
  assert.deepEqual(fixture.requests, [
    {
      method: 'POST',
      url: '/v1/chat/completions',
      host: `${fixture.loopbackAddress.host}:${String(fixture.loopbackAddress.port)}`,
      body: completedBody,
      bodyByteLength: completedBody.length,
      bodyExceededLimit: false,
      outcome: 'end'
    }
  ])

  const incompleteBody = 'partial'
  const incompleteSocket = await connectedSocket(fixture.loopbackAddress.port)
  incompleteSocket.write(
    `POST /v1/chat/completions HTTP/1.1\r\nHost: ${fixture.loopbackAddress.host}:${String(
      fixture.loopbackAddress.port
    )}\r\nContent-Length: 64\r\n\r\n${incompleteBody}`
  )
  const timeoutResponse = await readSocketResponse(incompleteSocket)
  assert.match(timeoutResponse, /^HTTP\/1\.1 408 /u)
  assert.equal(fixture.requests.length, 2)
  assert.deepEqual(fixture.requests[1], {
    method: 'POST',
    url: '/v1/chat/completions',
    host: `${fixture.loopbackAddress.host}:${String(fixture.loopbackAddress.port)}`,
    body: Buffer.from(incompleteBody),
    bodyByteLength: Buffer.byteLength(incompleteBody),
    bodyExceededLimit: false,
    outcome: 'timeout'
  })
  await fixture.closeLoopback()
  assert.equal(fixture.requests.length, 2)
  assert.equal(
    fixture.requests.some(request => request.outcome === 'pending'),
    false
  )
})

test(
  'C0.7 XF02 rejects an unrelated GET observation followed by a refused model connection',
  { timeout: 20_000 },
  async () => {
    await assert.rejects(
      runUntrustedPromptUnrelatedRequestControl({
        baselineGitHead: TEST_GIT_HEAD
      }),
      (error: unknown) => {
        assert.ok(error instanceof BaselineSignatureMismatchError)
        assert.match(error.message, /not one bounded POST/u)
        assert.equal(error.message.includes('C0_7_UNTRUSTED_PROMPT_CANARY'), false)
        return true
      }
    )
  }
)

test(
  'C0.7 fixture cleanup bounds idle TCP and incomplete HTTP connections on every runtime',
  { timeout: 10_000 },
  async t => {
    const fixture = await startRealPiFixture({
      transcriptCheckpoint: 'C0.7',
      transcriptCaseId: 'C0.7-cleanup-control',
      transcriptMetadata: {
        baselineGitHead: TEST_GIT_HEAD
      }
    })
    const sockets: Socket[] = []
    t.after(async () => {
      for (const socket of sockets) socket.destroy()
      await fixture.cleanup().catch(() => undefined)
    })

    const idleSocket = await connectedSocket(fixture.loopbackAddress.port)
    sockets.push(idleSocket)
    const incompleteHttpSocket = await connectedSocket(fixture.loopbackAddress.port)
    sockets.push(incompleteHttpSocket)
    incompleteHttpSocket.write(
      `POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1:${String(
        fixture.loopbackAddress.port
      )}\r\nContent-Length: 64\r\n\r\npartial`
    )

    const startedAt = performance.now()
    await Promise.all([fixture.closeLoopback(), fixture.cleanup(), fixture.cleanup()])
    const elapsedMs = performance.now() - startedAt
    assert.ok(elapsedMs < 2_000, `C0.7 fixture cleanup took ${elapsedMs.toFixed(1)}ms`)
    assert.equal(idleSocket.destroyed, true)
    assert.equal(incompleteHttpSocket.destroyed, true)
    assert.equal(
      fixture.requests.some(request => request.outcome === 'pending'),
      false
    )
    await assert.rejects(access(fixture.rootDir), (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT')
      return true
    })
    await assertPortClosed(fixture.loopbackAddress.port)
    const exit = await fixture.client.closed
    assert.deepEqual({ code: exit.code, signal: exit.signal }, { code: 0, signal: null })
    assert.equal(fixture.client.transcript().at(-1)?.kind, 'process_exit')
  }
)

test('C0.7 fixture hard deadline performs bounded idempotent teardown', { timeout: 5_000 }, async () => {
  const startedAt = performance.now()
  const fixture = await startRealPiFixture({
    hardDeadlineMs: 250,
    transcriptCheckpoint: 'C0.7',
    transcriptCaseId: 'C0.7-hard-deadline-control',
    transcriptMetadata: {
      baselineGitHead: TEST_GIT_HEAD
    }
  })
  const sockets = await Promise.all(
    Array.from({ length: 4 }, async () => await connectedSocket(fixture.loopbackAddress.port))
  )
  let operationError: unknown
  try {
    await runWithinFixtureDeadline(fixture, async () => {
      while (!fixture.hardDeadlineExceeded) {
        await new Promise<void>(resolve => setTimeout(resolve, 5))
      }
      return 'operation-completed-during-deadline-cleanup'
    })
  } catch (error) {
    operationError = error
  } finally {
    for (const socket of sockets) socket.destroy()
  }
  assert.ok(operationError instanceof RealPiFixtureDeadlineError)
  const deadlineError = await fixture.hardDeadline
  assert.ok(deadlineError instanceof RealPiFixtureDeadlineError)
  assert.equal(deadlineError.deadlineMs, 250)
  assert.equal(fixture.hardDeadlineExceeded, true)
  await Promise.all([fixture.cleanup(), fixture.cleanup()])
  const elapsedMs = performance.now() - startedAt
  assert.ok(elapsedMs < 2_500, `C0.7 hard-deadline teardown took ${elapsedMs.toFixed(1)}ms`)
  await assert.rejects(access(fixture.rootDir), (error: unknown) => {
    assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT')
    return true
  })
  await assertPortClosed(fixture.loopbackAddress.port)
  const exit = await fixture.client.closed
  assert.deepEqual({ code: exit.code, signal: exit.signal }, { code: 0, signal: null })
})
