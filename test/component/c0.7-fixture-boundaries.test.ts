import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
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
