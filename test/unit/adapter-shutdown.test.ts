import assert from 'node:assert/strict'
import test from 'node:test'
import { createAdapterOutputGate, type AdapterOutput } from '../../src/adapter-output.js'
import {
  ADAPTER_SHUTDOWN_TIMEOUT_MS,
  createAdapterShutdown,
  createAdapterShutdownCoordinator
} from '../../src/adapter-shutdown.js'

type TimeoutHandle = ReturnType<typeof setTimeout>

test('adapter shutdown triggers share one cleanup and exit chain', async () => {
  let disposeCalls = 0
  let exitCalls = 0
  let resolveDispose!: () => void
  const dispose = new Promise<void>(resolve => {
    resolveDispose = resolve
  })
  const timeoutHandle = {} as TimeoutHandle
  const cancelled: TimeoutHandle[] = []

  const shutdown = createAdapterShutdownCoordinator({
    dispose: () => {
      disposeCalls += 1
      return dispose
    },
    exit: () => {
      exitCalls += 1
    },
    scheduleTimeout: () => timeoutHandle,
    cancelTimeout: timeout => cancelled.push(timeout)
  })

  const first = shutdown()
  const second = shutdown()
  assert.strictEqual(second, first)
  await Promise.resolve()
  assert.equal(disposeCalls, 1)

  resolveDispose()
  await first
  assert.equal(exitCalls, 1)
  assert.deepEqual(cancelled, [timeoutHandle])
  assert.strictEqual(shutdown(), first)
  assert.equal(disposeCalls, 1)
  assert.equal(exitCalls, 1)
})

test('adapter shutdown exits at the 2,000ms deadline when dispose never settles', async () => {
  let deadline: (() => void) | undefined
  let scheduledDelay: number | undefined
  let exitCalls = 0
  const timeoutHandle = {} as TimeoutHandle
  const cancelled: TimeoutHandle[] = []

  const shutdown = createAdapterShutdownCoordinator({
    dispose: () => new Promise<void>(() => {}),
    exit: () => {
      exitCalls += 1
    },
    scheduleTimeout: (callback, timeoutMs) => {
      deadline = callback
      scheduledDelay = timeoutMs
      return timeoutHandle
    },
    cancelTimeout: timeout => cancelled.push(timeout)
  })

  const result = shutdown()
  assert.equal(ADAPTER_SHUTDOWN_TIMEOUT_MS, 2_000)
  assert.equal(scheduledDelay, 2_000)
  assert.ok(deadline)
  assert.equal(exitCalls, 0)

  deadline()
  await result
  assert.equal(exitCalls, 1)
  assert.deepEqual(cancelled, [timeoutHandle])
})

test('adapter shutdown waits for the fixed pre-fence output drain after disposal', async () => {
  const events: string[] = []
  let finishWrite: (() => void) | undefined
  const output: AdapterOutput = {
    destroyed: false,
    writable: true,
    write(_chunk, callback) {
      finishWrite = callback
    }
  }
  const gate = createAdapterOutputGate(output)
  const acceptedWrite = gate.write(new Uint8Array([1]))
  const timeoutHandle = {} as TimeoutHandle

  const shutdown = createAdapterShutdown({
    fenceOutput: () => {
      events.push('fence')
      return gate.fence()
    },
    dispose: () => {
      events.push('dispose')
    },
    exit: () => {
      events.push('exit')
    },
    scheduleTimeout: () => timeoutHandle
  })

  const first = shutdown()
  assert.strictEqual(shutdown(), first)
  assert.deepEqual(events, ['fence'])
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(events, ['fence', 'dispose'])

  assert.ok(finishWrite)
  finishWrite()
  await Promise.all([acceptedWrite, first])
  assert.deepEqual(events, ['fence', 'dispose', 'exit'])
})

test('adapter shutdown gives a permanently stuck accepted write only the shared 2,000ms bound', async () => {
  let deadline: (() => void) | undefined
  let scheduledDelay: number | undefined
  let exitCalls = 0
  const output: AdapterOutput = {
    destroyed: false,
    writable: true,
    write() {
      // Simulate stdout accepting the chunk without ever invoking its callback.
    }
  }
  const gate = createAdapterOutputGate(output)
  void gate.write(new Uint8Array([1]))
  const timeoutHandle = {} as TimeoutHandle

  const shutdown = createAdapterShutdown({
    fenceOutput: () => gate.fence(),
    dispose: () => {},
    exit: () => {
      exitCalls += 1
    },
    scheduleTimeout: (callback, timeoutMs) => {
      deadline = callback
      scheduledDelay = timeoutMs
      return timeoutHandle
    }
  })

  const result = shutdown()
  assert.equal(scheduledDelay, ADAPTER_SHUTDOWN_TIMEOUT_MS)
  assert.equal(scheduledDelay, 2_000)
  assert.ok(deadline)
  assert.equal(exitCalls, 0)

  deadline()
  await result
  assert.equal(exitCalls, 1)
})
