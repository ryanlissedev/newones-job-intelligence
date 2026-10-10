/**
 * Per-key serialization for in-memory store mutations.
 *
 * Mutation + audit must complete (commit or rollback) before another mutation
 * on the same key starts. Independent keys stay concurrent. The first task on
 * an idle key starts synchronously so callers can observe side effects (e.g.
 * audit gate registration) before yielding.
 */
export class MutationKeyQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key);
    const next = (async (): Promise<T> => {
      if (previous !== undefined) {
        try {
          await previous;
        } catch {
          // Prior failure must not block the next mutation on this key.
        }
      }
      return await task();
    })();
    const settled = (async (): Promise<void> => {
      try {
        await next;
      } catch {
        // Keep the queue chain alive after failures.
      }
    })();
    this.tails.set(key, settled);
    void (async (): Promise<void> => {
      await settled;
      if (this.tails.get(key) === settled) {
        this.tails.delete(key);
      }
    })();
    return next;
  }
}
