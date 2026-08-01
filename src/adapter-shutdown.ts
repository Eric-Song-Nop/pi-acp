export const ADAPTER_SHUTDOWN_TIMEOUT_MS = 2_000

type ShutdownTimeout = ReturnType<typeof setTimeout>

export type AdapterShutdownCoordinatorOptions = {
  dispose: () => void | Promise<void>
  exit: () => void
  timeoutMs?: number
  scheduleTimeout?: (callback: () => void, timeoutMs: number) => ShutdownTimeout
  cancelTimeout?: (timeout: ShutdownTimeout) => void
}

/**
 * Create the adapter's one-shot shutdown chain.
 *
 * Every transport or signal trigger receives the same promise. Cleanup gets a
 * bounded opportunity to stop nested Pi processes, after which the adapter
 * exits even when cleanup rejects or never settles.
 */
export function createAdapterShutdownCoordinator(options: AdapterShutdownCoordinatorOptions): () => Promise<void> {
  const timeoutMs = options.timeoutMs ?? ADAPTER_SHUTDOWN_TIMEOUT_MS
  const scheduleTimeout = options.scheduleTimeout ?? setTimeout
  const cancelTimeout = options.cancelTimeout ?? clearTimeout
  let shutdownPromise: Promise<void> | undefined

  return function requestShutdown(): Promise<void> {
    shutdownPromise ??= (async () => {
      let cleanupTimer: ShutdownTimeout | undefined
      try {
        const deadline = new Promise<void>(resolve => {
          cleanupTimer = scheduleTimeout(resolve, timeoutMs)
        })
        await Promise.race([Promise.resolve().then(options.dispose), deadline])
      } catch {
        // Cleanup failure cannot leave the adapter alive after ACP disconnects.
      } finally {
        if (cleanupTimer !== undefined) cancelTimeout(cleanupTimer)
      }

      try {
        options.exit()
      } catch {
        // The production process exit is best-effort, matching signal cleanup.
      }
    })()

    return shutdownPromise
  }
}

export type AdapterShutdownOptions = AdapterShutdownCoordinatorOptions & {
  fenceOutput: () => void | Promise<void>
}

/**
 * Fence adapter output synchronously, then give both agent disposal and the
 * fixed pre-fence output drain one shared bounded cleanup window.
 */
export function createAdapterShutdown(options: AdapterShutdownOptions): () => Promise<void> {
  let outputDrain: Promise<void> | undefined
  const requestCoordinatedShutdown = createAdapterShutdownCoordinator({
    ...options,
    dispose: async () => {
      await Promise.allSettled([Promise.resolve().then(options.dispose), outputDrain ?? Promise.resolve()])
    }
  })

  return function requestShutdown(): Promise<void> {
    if (!outputDrain) {
      let settleOutputDrain!: () => void
      outputDrain = new Promise<void>(resolve => {
        settleOutputDrain = resolve
      })

      try {
        void Promise.resolve(options.fenceOutput()).then(settleOutputDrain, settleOutputDrain)
      } catch {
        settleOutputDrain()
      }
    }

    return requestCoordinatedShutdown()
  }
}
