type AdapterReadable = {
  on(event: 'data', listener: (chunk: Buffer) => void): unknown
  on(event: 'end' | 'close', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

type AdapterWritable = {
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'close', listener: () => void): unknown
}

export type AdapterShutdownTriggerOptions = {
  output: AdapterWritable
  connectionSignal: AbortSignal
  shutdown: () => void
}

/**
 * Adapt stdin to the ACP Web stream while synchronously starting shutdown
 * before exposing any terminal close/error to the stream consumer.
 */
export function createAdapterInputStream(input: AdapterReadable, shutdown: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let terminal = false

      const close = () => {
        if (terminal) return
        terminal = true
        shutdown()
        controller.close()
      }

      input.on('data', (chunk: Buffer) => {
        if (!terminal) controller.enqueue(new Uint8Array(chunk))
      })
      input.on('end', close)
      input.on('close', close)
      input.on('error', error => {
        if (terminal) return
        terminal = true
        shutdown()
        controller.error(error)
      })
    }
  })
}

/** Bind the remaining adapter transport terminal signals to one shutdown. */
export function bindAdapterShutdownTriggers(options: AdapterShutdownTriggerOptions): void {
  options.output.on('error', options.shutdown)
  options.output.on('close', options.shutdown)
  options.connectionSignal.addEventListener('abort', options.shutdown, { once: true })

  if (options.connectionSignal.aborted) options.shutdown()
}
