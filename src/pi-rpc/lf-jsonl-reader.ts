import { StringDecoder } from 'node:string_decoder'

export type LfJsonlRecordHandler = (record: string) => boolean | void

type ReaderState = 'open' | 'finishing' | 'finished' | 'discarded'

/**
 * Incrementally decodes UTF-8 JSONL records using LF as the only delimiter.
 *
 * Returning `false` from `onRecord`, or calling `discard()`, quarantines the
 * reader synchronously. That drops the current partial record and prevents
 * later records from the same chunk (and all later chunks) from being decoded
 * or delivered.
 */
export class LfJsonlReader {
  private decoder: StringDecoder | undefined = new StringDecoder('utf8')
  // Keep unterminated input as fragments. Repeated string concatenation would
  // copy the whole tail for every chunk and make a long no-LF record quadratic.
  private tailFragments: string[] = []
  private decodedQueue: string[] = []
  private draining = false
  private state: ReaderState = 'open'

  constructor(private readonly onRecord: LfJsonlRecordHandler) {}

  get active(): boolean {
    return this.state === 'open'
  }

  /**
   * Decodes and delivers all complete LF-terminated records in `chunk`.
   * Returns whether the reader remains open for more input.
   */
  push(chunk: Uint8Array): boolean {
    if (this.state !== 'open') return false
    if (chunk.byteLength === 0) return true

    this.drainDecoded(this.decoder!.write(chunk))
    return this.state === 'open'
  }

  /**
   * Completes a clean EOF. A non-empty unterminated final record is delivered
   * exactly once. A trailing CR is stripped only when it immediately precedes
   * an LF, so an EOF tail ending in CR is preserved verbatim.
   */
  finish(): boolean {
    if (this.state !== 'open') return false

    this.state = 'finishing'
    const decoder = this.decoder!
    this.decoder = undefined
    this.drainDecoded(decoder.end())

    if (this.state !== 'finishing') return false

    const finalRecord = this.joinTail('')
    if (finalRecord.length > 0 && this.onRecord(finalRecord) === false) {
      this.discard()
      return false
    }
    if (this.state !== 'finishing') return false

    this.state = 'finished'
    return true
  }

  /** Drops buffered and future input without delivering an unterminated tail. */
  discard(): void {
    if (this.state === 'finished' || this.state === 'discarded') return

    this.state = 'discarded'
    this.decoder = undefined
    this.tailFragments = []
    this.decodedQueue = []
  }

  private consume(decoded: string): void {
    if (!this.canConsume() || decoded.length === 0) return

    let start = 0
    while (this.canConsume()) {
      const lf = decoded.indexOf('\n', start)
      if (lf < 0) {
        if (start < decoded.length) this.tailFragments.push(decoded.slice(start))
        return
      }

      let record = this.joinTail(decoded.slice(start, lf))
      start = lf + 1
      if (record.endsWith('\r')) record = record.slice(0, -1)

      if (this.onRecord(record) === false) {
        this.discard()
        return
      }
    }
  }

  private canConsume(): boolean {
    return this.state === 'open' || this.state === 'finishing'
  }

  private drainDecoded(decoded: string): void {
    if (decoded.length > 0) this.decodedQueue.push(decoded)
    if (this.draining) return

    this.draining = true
    try {
      // A record callback can synchronously cause another data emission in a
      // test or wrapper. The outer chunk was already received in full, so drain
      // it before any reentrant decoded input instead of merging shared tails.
      for (let index = 0; index < this.decodedQueue.length && this.canConsume(); index += 1) {
        this.consume(this.decodedQueue[index]!)
      }
    } finally {
      this.decodedQueue = []
      this.draining = false
    }
  }

  private joinTail(suffix: string): string {
    if (this.tailFragments.length === 0) return suffix
    this.tailFragments.push(suffix)
    const record = this.tailFragments.join('')
    this.tailFragments = []
    return record
  }
}
