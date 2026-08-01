import assert from 'node:assert/strict'
import test from 'node:test'
import { createAdapterOutputGate, type AdapterOutput } from '../../src/adapter-output.js'

test('adapter output gate resolves without writing when stdout is destroyed', async () => {
  let writes = 0
  const output: AdapterOutput = {
    destroyed: true,
    writable: false,
    write() {
      writes += 1
    }
  }

  await createAdapterOutputGate(output).write(new Uint8Array([1, 2, 3]))
  assert.equal(writes, 0)
})

test('adapter output gate retains pre-fence bytes and drops every post-fence write', async () => {
  const writes: number[][] = []
  let completeWrite: (() => void) | undefined
  const output: AdapterOutput = {
    destroyed: false,
    writable: true,
    write(chunk, callback) {
      writes.push([...chunk])
      completeWrite = callback
    }
  }
  const gate = createAdapterOutputGate(output)

  const preFenceWrite = gate.write(new Uint8Array([1]))
  let drained = false
  const fixedDrain = gate.fence()
  const drain = fixedDrain.then(() => {
    drained = true
  })
  assert.strictEqual(gate.fence(), fixedDrain)
  await Promise.resolve()
  assert.equal(drained, false)

  await gate.write(new Uint8Array([2]))
  await gate.write(new Uint8Array([3]))
  assert.deepEqual(writes, [[1]])

  assert.ok(completeWrite)
  completeWrite()
  await Promise.all([preFenceWrite, drain])

  assert.equal(drained, true)
  assert.deepEqual(writes, [[1]])
})
