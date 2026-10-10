/**
 * PR6 runtime evidence (1/2): replays the measured per-source run durations
 * (MEASURED.md, 2026-10-08, log p50 incl. the 120 s curate pass) through the
 * real `runContinuously` scheduler, on a scaled clock, at 2 and 8 slots.
 *
 * Every bron has interval `*\/15`, so every source is always due and the
 * start order is longest-waiting first (`byLongestWaiting`), as in prod.
 * Durable bronnen (tenderned, inhuurdesk) are queued, so they free their slot
 * at once.
 *
 * When the scheduler accepts `isLong`/`maxLongInFlight` (#465), the long lane
 * is switched on too: sources with a raised run budget (Techniekwerkt,
 * Randstad) count as long, capped at `concurrency - 1`.
 *
 *   bun docs/evidence/poller-concurrency/replay-harness.ts
 */
import { runContinuously } from "../../../apps/worker/src/poller/pool";

/** Real milliseconds per simulated minute. */
const MS_PER_SIM_MINUTE = 6;
const SIM_HOURS = 30;
const WARM_UP_HOURS = 6;

const MEASURED_MINUTES: Record<string, number> = {
  asml: 26,
  bam: 13,
  "bij-oranje": 29,
  bluetrail: 14,
  datajobs: 9,
  heijmans: 14,
  "opdrachtoverheid": 34,
  randstad: 103,
  "tbi": 24,
  techniekwerkt: 330,
  tenmonks: 8,
  unica: 22,
  volkerwessels: 20,
  wvn: 44,
  "zzp-opdrachten": 57,
};
const SHORT_SOURCES = 16; // "everything else ≤ 3 min": modelled at 3 min
const DURABLE = ["tenderned", "inhuurdesk"]; // queued, slot freed at once
const LONG = new Set(["randstad", "techniekwerkt"]);

const sources: { minutes: number; slug: string }[] = [
  ...Object.entries(MEASURED_MINUTES).map(([slug, minutes]) => ({
    minutes,
    slug,
  })),
  ...Array.from({ length: SHORT_SOURCES }, (_, index) => ({
    minutes: 3,
    slug: `short-${index + 1}`,
  })),
  ...DURABLE.map((slug) => ({ minutes: 0, slug })),
];

const percentile = (values: readonly number[], p: number): number => {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? Number.NaN;
};

const replay = async (concurrency: number, lane: boolean) => {
  const controller = new AbortController();
  const t0 = performance.now();
  const simMinutes = () => (performance.now() - t0) / MS_PER_SIM_MINUTE;
  const starts = new Map<string, number[]>();
  let peakInFlight = 0;
  let inFlightNow = 0;
  const lastStart = new Map<string, number>();
  const options = {
    concurrency,
    dueItems: () =>
      Promise.resolve(
        sources.toSorted(
          (left, right) =>
            (lastStart.get(left.slug) ?? -1) - (lastStart.get(right.slug) ?? -1)
        )
      ),
    isLong: lane ? (item: (typeof sources)[number]) => LONG.has(item.slug) : undefined,
    keyOf: (item: (typeof sources)[number]) => item.slug,
    maxLongInFlight: lane ? Math.max(1, concurrency - 1) : undefined,
    run: async (item: (typeof sources)[number]) => {
      const now = simMinutes();
      lastStart.set(item.slug, now);
      starts.set(item.slug, [...(starts.get(item.slug) ?? []), now]);
      inFlightNow += 1;
      peakInFlight = Math.max(peakInFlight, inFlightNow);
      await Bun.sleep(item.minutes * MS_PER_SIM_MINUTE);
      inFlightNow -= 1;
    },
    signal: controller.signal,
    tickMs: MS_PER_SIM_MINUTE, // the 60 s tick
  };
  const done = runContinuously(options);
  await Bun.sleep(SIM_HOURS * 60 * MS_PER_SIM_MINUTE);
  controller.abort();
  await done;

  const gapsFor = (slug: string) => {
    const list = (starts.get(slug) ?? []).filter((at) => at >= WARM_UP_HOURS * 60);
    return list.slice(1).map((at, index) => (at - (list[index] ?? 0)) / 60);
  };
  const allGaps = sources.flatMap((source) => gapsFor(source.slug));
  const shortGaps = sources
    .filter((source) => !LONG.has(source.slug))
    .flatMap((source) => gapsFor(source.slug));
  return {
    concurrency,
    lane,
    n: allGaps.length,
    p10: percentile(allGaps, 10),
    p50: percentile(allGaps, 50),
    p90: percentile(allGaps, 90),
    peakInFlight,
    randstadP50: percentile(gapsFor("randstad"), 50),
    shortP50: percentile(shortGaps, 50),
    techniekwerktP50: percentile(gapsFor("techniekwerkt"), 50),
  };
};

const fmt = (hours: number) => (Number.isFinite(hours) ? `${hours.toFixed(2)} h` : "n/a");
const laneSupported = process.argv.includes("--lane");
console.log(
  `replay: ${sources.length} sources, ${SIM_HOURS} simulated hours (first ${WARM_UP_HOURS} h warm-up dropped), 1 sim-min = ${MS_PER_SIM_MINUTE} ms`
);
const configs: [number, boolean][] = laneSupported
  ? [[2, false], [2, true], [8, false], [8, true]]
  : [[2, false], [8, false]];
for (const [concurrency, lane] of configs) {
  // oxlint-disable-next-line no-await-in-loop -- configurations run one after another on the same clock
  const result = await replay(concurrency, lane);
  console.log(
    `slots=${result.concurrency}${result.lane ? " +long-lane(#465)" : ""}: round (start-to-start per source) p10 ${fmt(result.p10)} · p50 ${fmt(result.p50)} · p90 ${fmt(result.p90)} (n=${result.n}); short sources p50 ${fmt(result.shortP50)}; Randstad ${fmt(result.randstadP50)}; Techniekwerkt ${fmt(result.techniekwerktP50)}; peak in flight ${result.peakInFlight}`
  );
}
