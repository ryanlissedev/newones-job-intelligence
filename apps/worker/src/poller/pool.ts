import { abortableSleep } from "@ji/db/abortable-sleep";

/**
 * Bounded-concurrency runner for one poll cycle.
 *
 * A cycle used to be a plain `for` over the due sources, so its wall clock was
 * the sum of every source's run. Two sources pace themselves with their own
 * `crawl_delay_ms` (BlueTrail around 680 s, Opdrachtoverheid around 940 s),
 * which pushed a full cycle to 33 to 38 minutes and made the quarter-hour
 * intervals in `curated.bron.interval` unreachable. Running sources side by side
 * fixes that without touching politeness: each source still runs one at a
 * time, and the per-bron limiter inside `executeBronRun` keeps pacing per host.
 */

/**
 * Runs `worker` over `items` with at most `limit` calls in flight.
 *
 * - Items start in array order; a free slot always takes the lowest unstarted
 *   index, so the starting order is the input order.
 * - A rejecting worker is captured as a settled result and does not stop the
 *   others, which is what keeps one broken source from ending a cycle.
 * - `signal` is checked before every start, never mid-item: an abort stops new
 *   starts and lets the items already running finish.
 *
 * Returns one settled result per item that was started, in starting order.
 * Items skipped by an abort have no entry, so the length is the number of
 * items the cycle actually reached.
 */
export const runWithConcurrency = async <Item, Result>(
  items: readonly Item[],
  limit: number,
  worker: (item: Item) => Promise<Result>,
  signal: AbortSignal
): Promise<PromiseSettledResult<Result>[]> => {
  const settled: PromiseSettledResult<Result>[] = [];
  // Indices are handed out in ascending order and every handed-out index is
  // written back, so `settled` stays dense even when an abort cuts the run.
  let nextIndex = 0;

  const runOne = async (item: Item, index: number): Promise<void> => {
    try {
      settled[index] = { status: "fulfilled", value: await worker(item) };
    } catch (error) {
      settled[index] = { reason: error, status: "rejected" };
    }
  };

  // Wrapping every item keeps the queue probe total: an `undefined` entry
  // means "queue exhausted" and never "this item happens to be undefined".
  const queue = items.map((item, index) => ({ index, item }));
  const slots = Math.max(1, Math.min(Math.floor(limit), queue.length));
  const runners = Array.from({ length: slots }, async () => {
    while (!signal.aborted) {
      const entry = queue[nextIndex];
      if (entry === undefined) {
        return;
      }
      nextIndex += 1;
      // oxlint-disable-next-line no-await-in-loop -- a slot runs one item at a time; that is the bound
      await runOne(entry.item, entry.index);
    }
  });

  await Promise.all(runners);
  return settled;
};

export interface ContinuousSchedulerOptions<Item> {
  /**
   * Max runs in flight at once; also the ceiling on concurrent curation
   * drains against Postgres, exactly as the cycle concurrency was.
   */
  readonly concurrency: number;
  /**
   * Items due right now, in start-priority order. Called once per
   * evaluation; `context.inFlight` is the number of runs already started.
   * A rejection is fatal to the scheduler, matching how a failed candidate
   * load ended a cycle.
   */
  readonly dueItems: (context: {
    inFlight: number;
  }) => Promise<readonly Item[]>;
  /**
   * Marks an item whose run is known to hold its slot for hours (a source
   * with its own raised run budget). Together with `maxLongInFlight` this
   * keeps long crawls from taking every slot. Omitted: no item is long.
   */
  readonly isLong?: (item: Item) => boolean;
  /** Stable identity; used to keep one active run per item. */
  readonly keyOf: (item: Item) => string;
  /**
   * Max long items in flight at once. A due long item past this cap is left
   * for a later evaluation and the slot goes to the next short item, so short
   * sources always keep `concurrency - maxLongInFlight` slots. Ignored when
   * `isLong` is omitted.
   */
  readonly maxLongInFlight?: number;
  /**
   * Periodic maintenance hook (stale-run repair, outbox prune) invoked at
   * the top of every evaluation. The caller decides the actual cadence —
   * evaluations can happen more often than `tickMs` when runs finish.
   */
  readonly onTick?: () => Promise<void>;
  /**
   * A rejecting `run` is reported here instead of ending the scheduler —
   * the same isolation `runWithConcurrency` gave one broken source in a
   * cycle. Non-Error rejections are normalized to `Error` first.
   */
  readonly onRunError?: (error: Error, item: Item) => void;
  /** One full source run. Must settle eventually; see the abort contract. */
  readonly run: (item: Item) => Promise<void>;
  readonly signal: AbortSignal;
  /** Longest wall-clock gap between two due re-evaluations. */
  readonly tickMs: number;
}

/**
 * Per-bron continuous scheduler (CTP-619).
 *
 * The cycle this replaces awaited its whole cohort before the next tick, so
 * one long-running sitemap/detail crawl held back every other bron's next
 * scheduled check. Here a run never blocks the loop: each evaluation starts
 * the currently due items — in the order `dueItems` returns — up to
 * `concurrency` in flight, then sleeps until the earlier of `tickMs` or the
 * next run settling. A freed slot therefore triggers an immediate
 * re-evaluation instead of waiting out the tick.
 *
 * - No overlapping runs per key: `inFlightKeys` covers the window between
 *   dispatch and the moment the run's `scrape_run` row exists; the store's
 *   per-bron `pg_advisory_xact_lock` covers everything after that.
 * - Missed-tick coalescing: due-ness is derived per evaluation, not queued,
 *   so N ticks missed during a run or a restart produce exactly one
 *   follow-up run, started once the bron is due and a slot is free.
 * - On abort, new starts stop and in-flight runs are awaited, so shutdown
 *   never abandons a write mid-flight — the same contract the cycle had.
 */
export const runContinuously = async <Item>(
  options: ContinuousSchedulerOptions<Item>
): Promise<void> => {
  const {
    concurrency,
    dueItems,
    isLong,
    keyOf,
    maxLongInFlight,
    onRunError,
    onTick,
    run,
    signal,
    tickMs,
  } = options;
  const inFlightKeys = new Set<string>();
  const inFlightRuns = new Set<Promise<null>>();
  const maxInFlight = Math.max(1, Math.floor(concurrency));
  const longCap = Math.max(1, Math.floor(maxLongInFlight ?? maxInFlight));
  const longInFlightKeys = new Set<string>();

  while (!signal.aborted) {
    // oxlint-disable-next-line no-await-in-loop -- maintenance and candidate reads must not overlap
    await onTick?.();
    // oxlint-disable-next-line no-await-in-loop -- the due set is re-read every evaluation
    const due = await dueItems({ inFlight: inFlightRuns.size });
    for (const item of due) {
      if (inFlightRuns.size >= maxInFlight) {
        break;
      }
      const key = keyOf(item);
      if (inFlightKeys.has(key)) {
        continue;
      }
      const long = isLong?.(item) ?? false;
      if (long && longInFlightKeys.size >= longCap) {
        continue;
      }
      if (long) {
        longInFlightKeys.add(key);
      }
      inFlightKeys.add(key);
      const tracked = Promise.withResolvers<null>();
      inFlightRuns.add(tracked.promise);
      const work = async (): Promise<void> => {
        try {
          await run(item);
        } catch (error) {
          try {
            onRunError?.(
              error instanceof Error ? error : new Error(String(error)),
              item
            );
          } catch {
            // A broken reporter must never reject the tracked run.
          }
        } finally {
          longInFlightKeys.delete(key);
          inFlightRuns.delete(tracked.promise);
          inFlightKeys.delete(key);
          tracked.resolve(null);
        }
      };
      // The task's promise is not awaited directly: `tracked.promise` is
      // what `inFlightRuns` races and drains on.
      void work();
    }
    // Wake on the tick or as soon as any run frees a slot — whichever comes
    // first — so a finishing long bron never delays a due short one. An
    // empty set races nothing, leaving the plain tick.
    // oxlint-disable-next-line no-await-in-loop -- the evaluation interval must elapse before the next pass
    await Promise.race([
      abortableSleep(tickMs, signal),
      Promise.race(inFlightRuns),
    ]);
  }
  await Promise.allSettled(inFlightRuns);
};
