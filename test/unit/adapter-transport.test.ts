import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createAdapterOutputGate, type AdapterOutput } from '../../src/adapter-output.js'
import { createAdapterShutdown } from '../../src/adapter-shutdown.js'
import { bindAdapterShutdownTriggers, createAdapterInputStream } from '../../src/adapter-transport.js'

type TriggerHarness = {
  input: EventEmitter
  output: FakeOutput
  connection: AbortController
}

type TriggerCase = {
  name: string
  inputOutcome?: 'close' | 'error'
  abortBeforeBinding?: boolean
  trigger: (harness: TriggerHarness) => void
}

class FakeOutput extends EventEmitter implements AdapterOutput {
  readonly destroyed = false
  readonly writable = true
  readonly writes: number[][] = []

  write(chunk: Uint8Array, callback: (error?: Error | null) => void): boolean {
    this.writes.push([...chunk])
    callback()
    return true
  }
}

const cases: TriggerCase[] = [
  {
    name: 'stdin end',
    inputOutcome: 'close',
    trigger: ({ input }) => input.emit('end')
  },
  {
    name: 'stdin close',
    inputOutcome: 'close',
    trigger: ({ input }) => input.emit('close')
  },
  {
    name: 'stdin error',
    inputOutcome: 'error',
    trigger: ({ input }) => input.emit('error', new Error('stdin failed'))
  },
  {
    name: 'stdout error',
    trigger: ({ output }) => output.emit('error', new Error('stdout failed'))
  },
  {
    name: 'stdout close',
    trigger: ({ output }) => output.emit('close')
  },
  {
    name: 'connection abort',
    trigger: ({ connection }) => connection.abort()
  },
  {
    name: 'already-aborted connection',
    abortBeforeBinding: true,
    trigger: () => {}
  }
]

for (const triggerCase of cases) {
  test(`${triggerCase.name} synchronously fences before disposal and drops post-fence output`, async () => {
    const input = new EventEmitter()
    const output = new FakeOutput()
    const connection = new AbortController()
    const gate = createAdapterOutputGate(output)
    const events: string[] = []
    let shutdownResult: Promise<void> | undefined
    const timeoutHandle = {} as ReturnType<typeof setTimeout>

    const requestShutdown = createAdapterShutdown({
      fenceOutput: () => {
        events.push('fence')
        return gate.fence()
      },
      dispose: async () => {
        events.push('dispose')
        await gate.write(new Uint8Array([9]))
      },
      exit: () => {
        events.push('exit')
      },
      scheduleTimeout: () => timeoutHandle
    })
    const shutdown = () => {
      events.push('shutdown')
      shutdownResult = requestShutdown()
    }

    const inputStream = createAdapterInputStream(input as NodeJS.ReadableStream, shutdown)
    let inputResult: Promise<'close' | 'error'> | undefined
    if (triggerCase.inputOutcome) {
      const reader = inputStream.getReader()
      inputResult = reader.read().then(
        result => {
          assert.equal(result.done, true)
          events.push('controller-close')
          return 'close' as const
        },
        () => {
          events.push('controller-error')
          return 'error' as const
        }
      )
    }

    if (triggerCase.abortBeforeBinding) connection.abort()
    bindAdapterShutdownTriggers({ output, connectionSignal: connection.signal, shutdown })
    triggerCase.trigger({ input, output, connection })

    assert.deepEqual(events.slice(0, 2), ['shutdown', 'fence'])
    assert.ok(shutdownResult)
    await shutdownResult
    assert.equal(events.filter(event => event === 'fence').length, 1)
    assert.equal(events.filter(event => event === 'dispose').length, 1)
    assert.equal(events.filter(event => event === 'exit').length, 1)
    assert.ok(events.indexOf('fence') < events.indexOf('dispose'))
    assert.deepEqual(output.writes, [])

    if (inputResult) {
      assert.equal(await inputResult, triggerCase.inputOutcome)
      const controllerEvent = `controller-${triggerCase.inputOutcome}`
      assert.ok(events.indexOf('fence') < events.indexOf(controllerEvent))
    }
  })
}
