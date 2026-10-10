/**
 * Read model for the brondashboard (RJC-407 / D1).
 *
 * Windows, not lifetime. Motian's dashboard reported a success percentage over
 * every run ever recorded, which averaged a source that broke this morning
 * against months of green history and counted `partial` as success. A source
 * that is down right now has to look down right now, so every figure here is
 * scoped to a window and only `succeeded` counts as success.
 */

export type BronRunStatsWindow = "7d" | "24u" | "30d";

export type BronRunKindFilter = "all" | "backfill" | "poll" | "test";

export type BronRunTimeseriesBucket = "day" | "hour";

/**
 * Buckets are cut on Amsterdam local days, not UTC days. A run at 23:30 UTC
 * happened on the next calendar day for the operator reading the dashboard,
 * and a chart whose days are two hours out is quietly wrong every evening.
 */
export const BRON_RUN_STATS_TIME_ZONE = "Europe/Amsterdam";

export const BRON_RUN_STATS_WINDOWS: readonly BronRunStatsWindow[] = [
  "24u",
  "7d",
  "30d",
];

const WINDOW_DURATION_MS = {
  "24u": 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
} satisfies Record<BronRunStatsWindow, number>;

export const isBronRunStatsWindow = (
  value: string
): value is BronRunStatsWindow =>
  BRON_RUN_STATS_WINDOWS.some((candidate) => candidate === value);

/**
 * Start of the window. `now` is a parameter rather than read from the clock so
 * the read model is deterministic under test.
 */
export const resolveBronRunStatsSince = (
  window: BronRunStatsWindow,
  now: Date
): Date => new Date(now.getTime() - WINDOW_DURATION_MS[window]);

/**
 * Succeeded over runs that actually finished.
 *
 * `running` runs are excluded from the denominator: a run still in flight has
 * not failed, and counting it as a non-success makes every source dip while it
 * polls. `null` when nothing finished in the window — that is "no data", which
 * a caller must render differently from 0%.
 */
export const computeBronSuccessRate = (input: {
  readonly runs: number;
  readonly running: number;
  readonly succeeded: number;
}): number | null => {
  const completed = input.runs - input.running;
  if (completed <= 0) {
    return null;
  }
  return input.succeeded / completed;
};
