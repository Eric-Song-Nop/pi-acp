export type AdapterOutput = {
  readonly destroyed: boolean
  readonly writable: boolean
  write(chunk: Uint8Array, callback: (error?: Error | null) => void): unknown
}

export function createAdapterOutputGate(output: AdapterOutput) {
  let fenced = false
  let pendingWrites = 0
  let drainPromise: Promise<void> | undefined
  let resolveDrain: (() => void) | undefined

  return {
    fence(): Promise<void> {
      if (drainPromise) return drainPromise

      fenced = true
      drainPromise =
        pendingWrites === 0
          ? Promise.resolve()
          : new Promise<void>(resolve => {
              resolveDrain = resolve
            })

      return drainPromise
    },

    write(chunk: Uint8Array): Promise<void> {
      return new Promise(resolve => {
        if (fenced || output.destroyed || !output.writable) {
          resolve()
          return
        }

        pendingWrites += 1
        let finished = false
        const finish = () => {
          if (finished) return
          finished = true
          pendingWrites -= 1
          resolve()

          if (fenced && pendingWrites === 0) {
            resolveDrain?.()
            resolveDrain = undefined
          }
        }

        try {
          output.write(chunk, finish)
        } catch {
          finish()
        }
      })
    }
  }
}
