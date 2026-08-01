import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import test from 'node:test'
import { LfJsonlReader } from '../../src/pi-rpc/lf-jsonl-reader.js'

test('LF JSONL reader preserves UTF-8 characters across every byte boundary', () => {
  const records: string[] = []
  const reader = new LfJsonlReader(record => {
    records.push(record)
  })
  const expected = [
    '{"text":"BEFORE\u2028MIDDLE\u2029AFTER"}',
    '{"text":"non-BMP 🫡 and escaped \\n stay in one record"}'
  ]
  const bytes = Buffer.from(`${expected.join('\n')}\n`, 'utf8')

  for (const byte of bytes) reader.push(Buffer.from([byte]))

  assert.deepEqual(records, expected)
  assert.equal(reader.active, true)
})

test('LF JSONL reader splits only LF and strips exactly one preceding CR', () => {
  const records: string[] = []
  const reader = new LfJsonlReader(record => {
    records.push(record)
  })

  reader.push(Buffer.from('one\rtwo\nthree\\nfour\r'))
  reader.push(Buffer.from('\nfive\r\r\n\r\n'))

  assert.deepEqual(records, ['one\rtwo', 'three\\nfour', 'five\r', ''])
})

test('LF JSONL reader handles many records and CR/LF split across chunks', () => {
  const records: string[] = []
  const reader = new LfJsonlReader(record => {
    records.push(record)
  })

  reader.push(Buffer.from('first\nsecond\nthird\r'))
  reader.push(Buffer.from('\nfour'))
  reader.push(Buffer.from('\nfifth\n'))

  assert.deepEqual(records, ['first', 'second', 'third', 'four', 'fifth'])
})

test('LF JSONL reader flushes one non-empty clean-EOF tail exactly once', () => {
  const records: string[] = []
  const reader = new LfJsonlReader(record => {
    records.push(record)
  })

  reader.push(Buffer.from('terminated\nfinal-with-bare-cr\r'))

  assert.equal(reader.finish(), true)
  assert.equal(reader.finish(), false)
  assert.equal(reader.push(Buffer.from('ignored\n')), false)
  assert.equal(reader.active, false)
  assert.deepEqual(records, ['terminated', 'final-with-bare-cr\r'])
})

test('LF JSONL reader does not invent an EOF record after a trailing LF', () => {
  const records: string[] = []
  const reader = new LfJsonlReader(record => {
    records.push(record)
  })

  reader.push(Buffer.from('record\n'))
  assert.equal(reader.finish(), true)

  assert.deepEqual(records, ['record'])
})

test('LF JSONL reader permits clean-EOF tail delivery to quarantine the reader', () => {
  const records: string[] = []
  const reader = new LfJsonlReader(record => {
    records.push(record)
    return false
  })

  reader.push(Buffer.from('unterminated'))

  assert.equal(reader.finish(), false)
  assert.equal(reader.active, false)
  assert.deepEqual(records, ['unterminated'])
})

test('LF JSONL reader applies StringDecoder replacement only when clean EOF promotes the tail', () => {
  const cleanRecords: string[] = []
  const cleanReader = new LfJsonlReader(record => {
    cleanRecords.push(record)
  })
  cleanReader.push(Buffer.from([0x70, 0x72, 0x65, 0x66, 0x69, 0x78, 0xe2]))
  assert.equal(cleanReader.finish(), true)
  assert.deepEqual(cleanRecords, ['prefix\ufffd'])

  const discardedRecords: string[] = []
  const discardedReader = new LfJsonlReader(record => {
    discardedRecords.push(record)
  })
  discardedReader.push(Buffer.from([0x70, 0x72, 0x65, 0x66, 0x69, 0x78, 0xe2]))
  discardedReader.discard()
  assert.equal(discardedReader.finish(), false)
  assert.deepEqual(discardedRecords, [])
})

test('LF JSONL reader accumulates many no-LF chunks without rescanning the prior tail', () => {
  const records: string[] = []
  const reader = new LfJsonlReader(record => {
    records.push(record)
  })

  for (let index = 0; index < 4_096; index += 1) reader.push(Buffer.from('x'))
  reader.push(Buffer.from('\n'))

  assert.deepEqual(records, ['x'.repeat(4_096)])
})

test('LF JSONL reader discard drops a partial tail and all future input', () => {
  const records: string[] = []
  const reader = new LfJsonlReader(record => {
    records.push(record)
  })

  reader.push(Buffer.from('complete\npartial'))
  reader.discard()

  assert.equal(reader.active, false)
  assert.equal(reader.push(Buffer.from('-remainder\n')), false)
  assert.equal(reader.finish(), false)
  assert.deepEqual(records, ['complete'])
})

test('LF JSONL reader callback can quarantine later records in the same chunk', () => {
  const records: string[] = []
  const reader = new LfJsonlReader(record => {
    records.push(record)
    return false
  })

  assert.equal(reader.push(Buffer.from('winner\nquarantined\npartial')), false)
  assert.equal(reader.push(Buffer.from('-remainder\n')), false)
  assert.equal(reader.finish(), false)
  assert.deepEqual(records, ['winner'])
})

test('LF JSONL reader supports synchronous explicit discard from a handler', () => {
  const records: string[] = []
  const reader = new LfJsonlReader(record => {
    records.push(record)
    reader.discard()
  })

  assert.equal(reader.push(Buffer.from('winner\nquarantined\n')), false)
  assert.deepEqual(records, ['winner'])
})

test('LF JSONL reader queues recursive push behind the already-received outer chunk', () => {
  const records: string[] = []
  const reader = new LfJsonlReader(record => {
    records.push(record)
    if (record === 'outer-one') reader.push(Buffer.from('later-partial'))
  })

  reader.push(Buffer.from('outer-one\nouter-two\n'))
  reader.finish()

  assert.deepEqual(records, ['outer-one', 'outer-two', 'later-partial'])
})
