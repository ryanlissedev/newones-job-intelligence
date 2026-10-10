export interface SingleflightRun<T> {
  readonly coalesced: boolean;
  readonly promise: Promise<T>;
}

/**
 * In-process request coalescing (RJC-388): concurrent calls for the same
 * key share one in-flight task instead of issuing N identical engine calls.
 * The entry is removed as soon as the task settles (success or failure), so
 * a failed flight never poisons a later, non-concurrent call — the next
 * caller after settlement always gets a fresh attempt. Callers concurrent
 * with a failed flight do still all reject together; that's the coalescing
 * contract, not a leak.
 */
export class Singleflight<T> {
  private readonly inFlight = new Map<string, Promise<T>>();

  run(key: string, task: () => Promise<T>): SingleflightRun<T> {
    const existing = this.inFlight.get(key);
    if (existing) {
      return { coalesced: true, promise: existing };
    }

    const promise = this.runAndClear(key, task);
    this.inFlight.set(key, promise);
    return { coalesced: false, promise };
  }

  private async runAndClear(key: string, task: () => Promise<T>): Promise<T> {
    try {
      return await task();
    } finally {
      this.inFlight.delete(key);
    }
  }
}
