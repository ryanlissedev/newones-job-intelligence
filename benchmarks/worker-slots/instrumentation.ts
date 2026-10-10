import { monitorEventLoopDelay } from "node:perf_hooks";
import type { IntervalHistogram } from "node:perf_hooks";

import type { ReservedSql, Sql } from "postgres";

import { summarizeSamples } from "./probe";
import type { SampleSummary } from "./probe";

/**
 * CTP-634 worker-slot load probe: in-process + DB-side instrumentation.
 *
 * Each probe is a start/stop sampler that records during exactly one level:
 * - event-loop lag (`perf_hooks.monitorEventLoopDelay`) — the signal that
 *   tells "more slots in one process" apart from "needs a second process";
 * - RSS samples + `process.cpuUsage` deltas over the level;
 * - `sql.reserve()` acquisition latency on the runtime's OWN postgres-js
 *   pool — the only honest pool-wait signal; a separate pool would measure
 *   nothing about this pool's contention;
 * - sentinel app-read latency on a dedicated connection — the API/DB
 *   responsiveness stand-in — plus pg_stat_activity backend counts.
 */

export interface EventLoopLagSummary {
  readonly maxMs: number;
  readonly meanMs: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
}

const NANOS_PER_MS = 1_000_000;

export interface EventLoopLagProbe {
  readonly start: (resolutionMs?: number) => void;
  /** Disables the histogram; null when never started. */
  readonly stop: () => EventLoopLagSummary | null;
}

export const createEventLoopLagProbe = (): EventLoopLagProbe => {
  let histogram: IntervalHistogram | null = null;
  return {
    start: (resolutionMs = 20) => {
      histogram = monitorEventLoopDelay({ resolution: resolutionMs });
      histogram.enable();
    },
    stop: () => {
      const active = histogram;
      histogram = null;
      if (active === null) {
        return null;
      }
      active.disable();
      const toMs = (nanos: number): number => Math.round(nanos / NANOS_PER_MS);
      return {
        maxMs: toMs(active.max),
        meanMs: toMs(active.mean),
        p95Ms: toMs(active.percentile(95)),
        p99Ms: toMs(active.percentile(99)),
      };
    },
  };
};

export interface ResourceSummary {
  readonly cpuSystemMicroseconds: number;
  readonly cpuUserMicroseconds: number;
  /** cpu seconds per wall-clock second; >1 means the process ran multi-core. */
  readonly cpuUtilisation: number;
  readonly lastRssBytes: number;
  readonly peakRssBytes: number;
  readonly rssSamples: number;
}

export interface ResourceProbe {
  readonly start: (sampleIntervalMs?: number) => void;
  readonly stop: (wallMs: number) => ResourceSummary | null;
}

export const createResourceProbe = (): ResourceProbe => {
  let baselineCpu: NodeJS.CpuUsage | null = null;
  let lastRss = 0;
  let peakRss = 0;
  let samples = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    start: (sampleIntervalMs = 100) => {
      baselineCpu = process.cpuUsage();
      const record = (): void => {
        const { rss } = process.memoryUsage();
        lastRss = rss;
        peakRss = Math.max(peakRss, rss);
        samples += 1;
      };
      record();
      timer = setInterval(record, sampleIntervalMs);
      timer.unref();
    },
    stop: (wallMs) => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      const baseline = baselineCpu;
      baselineCpu = null;
      if (baseline === null) {
        return null;
      }
      // One trailing sample so the final RSS isn't missed between ticks.
      const { rss } = process.memoryUsage();
      lastRss = rss;
      peakRss = Math.max(peakRss, rss);
      const cpu = process.cpuUsage(baseline);
      // process.cpuUsage reports MICROseconds.
      const cpuSeconds = (cpu.user + cpu.system) / 1_000_000;
      return {
        cpuSystemMicroseconds: cpu.system,
        cpuUserMicroseconds: cpu.user,
        cpuUtilisation:
          wallMs > 0
            ? Math.round((cpuSeconds / (wallMs / 1000)) * 1000) / 1000
            : 0,
        lastRssBytes: lastRss,
        peakRssBytes: peakRss,
        rssSamples: samples,
      };
    },
  };
};

interface AbortListenerHolder {
  onAbort?: () => void;
}

/** Interval sleep that also resolves early on abort. */
export const sleepUntil = (
  intervalMs: number,
  signal: AbortSignal
): Promise<void> =>
  // oxlint-disable-next-line promise/avoid-new -- timers have no promise API
  new Promise((resolve) => {
    // The listener must be the same function object at add/remove time —
    // removing a different closure leaks a listener per probe tick (~2400
    // per level) and contaminates the RSS measurement.
    const listener: AbortListenerHolder = {};
    const finish = (): void => {
      if (listener.onAbort !== undefined) {
        signal.removeEventListener("abort", listener.onAbort);
      }
      resolve();
    };
    const timer = setTimeout(finish, intervalMs);
    listener.onAbort = () => {
      clearTimeout(timer);
      finish();
    };
    signal.addEventListener("abort", listener.onAbort, { once: true });
  });

export const sleepMs = (intervalMs: number): Promise<void> =>
  // oxlint-disable-next-line promise/avoid-new -- timers have no promise API
  new Promise((resolve) => {
    setTimeout(resolve, intervalMs);
  });

/**
 * Runs `probe` every `intervalMs` until `signal` fires. Each measurement is
 * awaited before the next interval starts so a backing-up probe cannot pile
 * up calls. Probe failures are swallowed — a probe must never fail the level
 * it observes; dropped measurements show up as a lower sample count.
 */
export const runProbeLoop = async (
  probe: () => Promise<void>,
  intervalMs: number,
  signal: AbortSignal
): Promise<void> => {
  while (!signal.aborted) {
    // oxlint-disable-next-line no-await-in-loop -- measurements stay sequential by design
    await probe().catch(() => null);
    // oxlint-disable-next-line no-await-in-loop -- the interval is the sampling cadence
    await sleepUntil(intervalMs, signal);
  }
};

const RESERVE_TIMEOUT_MS = 5000;

export interface PoolWaitProbe {
  /** Drains when the loop stops AND every in-flight reservation released. */
  readonly run: (
    sql: Sql,
    intervalMs: number,
    signal: AbortSignal
  ) => Promise<void>;
  readonly samples: readonly number[];
  readonly summary: () => SampleSummary | null;
}

/**
 * Times `sql.reserve()` acquisition — the caller MUST pass the runtime's own
 * client (`database.$client`) or the numbers describe a different pool. A
 * reserve that outlives RESERVE_TIMEOUT_MS is recorded at its true (longer)
 * wait and released whenever it lands, so a saturated pool shows up as huge
 * waits instead of hanging the level or leaking the connection.
 */
const releaseOnSettle = async (
  reservation: Promise<ReservedSql>,
  onAcquired: () => void
): Promise<void> => {
  try {
    const reserved = await reservation;
    onAcquired();
    reserved.release();
  } catch {
    // A failed reservation has nothing to release; the wait stands.
  }
};

export const createPoolWaitProbe = (): PoolWaitProbe => {
  const waits: number[] = [];
  const releasers: Promise<void>[] = [];
  return {
    run: async (sql, intervalMs, signal) => {
      await runProbeLoop(
        async () => {
          const started = performance.now();
          const pending = sql.reserve();
          const index = waits.length;
          waits.push(Number.NaN);
          // The settle path writes the TRUE acquisition latency whenever the
          // reservation lands — past the timeout included — so a saturated
          // pool shows up as huge waits instead of a clipped 5s sample.
          releasers.push(
            releaseOnSettle(pending, () => {
              waits[index] = Math.round(performance.now() - started);
            })
          );
          await Promise.race([pending, sleepMs(RESERVE_TIMEOUT_MS)]);
          if (Number.isNaN(waits[index])) {
            waits[index] = Math.round(performance.now() - started);
          }
        },
        intervalMs,
        signal
      );
      // Bounded drain: a reservation that only settles when consumers release
      // connections must never block the level's failure artifact.
      await Promise.race([
        Promise.allSettled(releasers),
        sleepMs(RESERVE_TIMEOUT_MS),
      ]);
    },
    samples: waits,
    summary: () => summarizeSamples(waits.filter(Number.isFinite)),
  };
};

export interface SentinelSummary {
  /** Peak concurrent backends observed on the probe database. */
  readonly backendPeak: number | null;
  readonly latency: SampleSummary | null;
}

export interface SentinelProbe {
  readonly latencySamples: readonly number[];
  readonly run: (
    sql: Sql,
    databaseName: string,
    intervalMs: number,
    signal: AbortSignal
  ) => Promise<void>;
  readonly summary: () => SentinelSummary;
}

/**
 * Times a realistic app read (`count(*) FROM curated.aanvraag`) plus a
 * pg_stat_activity backend count for the probe database, on a dedicated
 * single-connection client outside the measured pool.
 */
export const createSentinelProbe = (): SentinelProbe => {
  const backendCounts: number[] = [];
  const latencies: number[] = [];
  return {
    latencySamples: latencies,
    run: (sql, databaseName, intervalMs, signal) =>
      runProbeLoop(
        async () => {
          const started = performance.now();
          await sql`SELECT count(*)::int AS n FROM curated.aanvraag`;
          latencies.push(Math.round(performance.now() - started));
          const [activity] = await sql<{ backends: number }[]>`
            SELECT count(*)::int AS backends
            FROM pg_stat_activity
            WHERE datname = ${databaseName}
          `;
          if (activity) {
            backendCounts.push(activity.backends);
          }
        },
        intervalMs,
        signal
      ),
    summary: () => ({
      backendPeak: backendCounts.length > 0 ? Math.max(...backendCounts) : null,
      latency: summarizeSamples(latencies),
    }),
  };
};
