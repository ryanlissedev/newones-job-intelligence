import { nextCronRun } from "@ji/application/observability";
import { SOURCES } from "@ji/application/sources";
import { runStalenessCutoff } from "@ji/db/run-staleness";
import { bron, scrapeRun } from "@ji/db/schema/curated";
import type { BronId } from "@ji/domain";
import { and, eq, gte, inArray, max } from "drizzle-orm";

import type { PollBronRuntime } from "../poll-bron-run";
import type { SliceABronSlug } from "../slice-a-bronnen";
import { listPollableSliceABronnen } from "../slice-a-pollable";

/** Wall-clock zone the Trigger schedule used; bron intervals are read the same way. */
export const POLL_TIME_ZONE = "Europe/Amsterdam";

export interface PollCandidate {
  bronId: BronId;
  bronSlug: SliceABronSlug;
  interval: string;
  lastRunAt: Date | null;
}

const isDue = (candidate: PollCandidate, now: Date): boolean => {
  if (candidate.lastRunAt === null) {
    return true;
  }
  const scheduled = nextCronRun(
    candidate.interval,
    candidate.lastRunAt,
    POLL_TIME_ZONE
  );
  return scheduled !== null && scheduled.getTime() <= now.getTime();
};

export const dueCandidates = (
  candidates: readonly PollCandidate[],
  now: Date
): PollCandidate[] => candidates.filter((candidate) => isDue(candidate, now));

/**
 * Start-priority order for due bronnen: longest-waiting first, never-run
 * bronnen ahead of everything.
 *
 * `lastRunAt` is the previous run's *start*, so a bron whose run outlasts
 * its interval re-enters the due set with a fresh, recent `lastRunAt` —
 * behind every bron that has been waiting longer. That is what keeps a
 * permanently-due long crawl from starving short bronnen when slots are
 * scarce (CTP-619): each missed-tick coalescing still yields one follow-up
 * run, but it queues after the bronnen that waited longer for it.
 */
export const byLongestWaiting = (
  a: PollCandidate,
  b: PollCandidate
): number => {
  if (a.lastRunAt === null) {
    return b.lastRunAt === null ? 0 : -1;
  }
  if (b.lastRunAt === null) {
    return 1;
  }
  return a.lastRunAt.getTime() - b.lastRunAt.getTime();
};

export interface LiveFlagPartition {
  live: PollCandidate[];
  notLive: PollCandidate[];
}

/**
 * A connector whose live flag is unset reads its listing from a repo fixture
 * (`live: process.env[source.liveEnv] === "1"` in `poll-bron-run.ts`), and the
 * pipeline then commits that fixture into `curated` as if it were the real
 * source. Outside production that is the point; in production it is data
 * corruption a healthy container would produce silently, so those sources are
 * skipped instead. The flag name comes from the source definition, never from
 * a list kept in step by hand.
 */
export const partitionByLiveFlag = (
  candidates: readonly PollCandidate[],
  env: Record<string, string | undefined>
): LiveFlagPartition => {
  if (env.NODE_ENV !== "production") {
    return { live: [...candidates], notLive: [] };
  }
  const live: PollCandidate[] = [];
  const notLive: PollCandidate[] = [];
  for (const candidate of candidates) {
    const target =
      env[SOURCES[candidate.bronSlug].liveEnv] === "1" ? live : notLive;
    target.push(candidate);
  }
  return { live, notLive };
};

export interface HostGatePartition {
  readonly held: PollCandidate[];
  readonly ready: PollCandidate[];
}

/**
 * Due sources whose host gate refuses a new run right now (circuit open after
 * repeated 403/bot challenges, or a 429/503 pause that outlasts the next
 * evaluation) are held back: starting them would only fail at once or sit in a
 * slot waiting. They come back on their own once the gate reopens.
 */
export const partitionByHostGate = (
  candidates: readonly PollCandidate[],
  holdsStart: (bronId: string) => boolean
): HostGatePartition => {
  const held: PollCandidate[] = [];
  const ready: PollCandidate[] = [];
  for (const candidate of candidates) {
    (holdsStart(candidate.bronId) ? held : ready).push(candidate);
  }
  return { held, ready };
};

/**
 * Pollable Slice A bronnen without a non-stale running poll, paired with their
 * interval and most recent poll run.
 *
 * `lastRunAt` is the newest poll run of any status, not the newest successful
 * one: a source that keeps failing must retry on its own cadence rather than
 * on every tick. This filter only avoids work; `PostgresRunStore` enforces the
 * invariant again under a transaction-scoped advisory lock at launch time.
 */
export const loadPollCandidates = async (
  runtime: Pick<PollBronRuntime, "bronPersistence" | "database">,
  options: { now: Date; olderThanMs: number }
): Promise<PollCandidate[]> => {
  const pollable = await listPollableSliceABronnen(runtime);
  if (pollable.length === 0) {
    return [];
  }

  const pollableBronIds = pollable.map((entry) => entry.bronId);
  const cutoff = runStalenessCutoff(options.now, options.olderThanMs);
  const runningRows = await runtime.database
    .select({ bronId: scrapeRun.bronId })
    .from(scrapeRun)
    .where(
      and(
        inArray(scrapeRun.bronId, pollableBronIds),
        eq(scrapeRun.runKind, "poll"),
        eq(scrapeRun.status, "running"),
        gte(scrapeRun.gestart, cutoff)
      )
    )
    .groupBy(scrapeRun.bronId);
  const runningBronIds = new Set(runningRows.map((row) => row.bronId));
  const available = pollable.filter(
    (entry) => !runningBronIds.has(entry.bronId)
  );
  if (available.length === 0) {
    return [];
  }

  const rows = await runtime.database
    .select({
      bronId: bron.id,
      interval: bron.interval,
      lastRunAt: max(scrapeRun.createdAt),
    })
    .from(bron)
    .leftJoin(
      scrapeRun,
      and(eq(scrapeRun.bronId, bron.id), eq(scrapeRun.runKind, "poll"))
    )
    .where(
      inArray(
        bron.id,
        available.map((entry) => entry.bronId)
      )
    )
    .groupBy(bron.id, bron.interval);

  const scheduleByBronId = new Map(rows.map((row) => [row.bronId, row]));
  return available.flatMap((entry) => {
    const schedule = scheduleByBronId.get(entry.bronId);
    if (!schedule) {
      return [];
    }
    return [
      {
        bronId: entry.bronId,
        bronSlug: entry.bronSlug,
        interval: schedule.interval,
        lastRunAt: schedule.lastRunAt,
      },
    ];
  });
};
