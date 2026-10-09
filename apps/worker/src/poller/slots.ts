/**
 * Runs `work` with at most `limit` calls inside at once; later callers queue
 * in arrival order. A rejecting `work` still frees its slot.
 *
 * The poller uses one of these for curation drains: more sources may be in
 * flight than drains may hit Postgres at once.
 */
export type SlotAttempt<T> = { ran: false } | { ran: true; value: T };

export interface SlotLimit {
  <T>(work: () => Promise<T>): Promise<T>;
  /**
   * Runs `work` only when a slot is free right now; never queues. For a
   * caller whose wait would eat a budget that someone else can spend later.
   */
  tryRun: <T>(work: () => Promise<T>) => Promise<SlotAttempt<T>>;
}

export const createSlotLimit = (limit: number): SlotLimit => {
  const capacity = Math.max(1, Math.floor(limit));
  let active = 0;
  const waiting: (() => void)[] = [];

  const release = (): void => {
    const next = waiting.shift();
    if (next) {
      // The slot passes straight to the next waiter; `active` is unchanged.
      next();
      return;
    }
    active -= 1;
  };

  const runHeld = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } finally {
      release();
    }
  };

  const run = async <T>(work: () => Promise<T>): Promise<T> => {
    if (active < capacity) {
      active += 1;
    } else {
      const turn = Promise.withResolvers<null>();
      waiting.push(() => turn.resolve(null));
      await turn.promise;
    }
    return runHeld(work);
  };

  const tryRun = async <T>(work: () => Promise<T>): Promise<SlotAttempt<T>> => {
    if (active >= capacity) {
      return { ran: false };
    }
    active += 1;
    return { ran: true, value: await runHeld(work) };
  };

  return Object.assign(run, { tryRun });
};
