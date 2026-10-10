import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { SOURCES } from "@ji/application/sources";
import { emptyRunMetrics, RunAlreadyInProgressError } from "@ji/connectors";
import { abandonStaleRuns } from "@ji/db/abandon-stale-runs";
import { PostgresBronPersistence, PostgresRunStore } from "@ji/db/bron-runtime";
import { bron, bronHealth, scrapeRun } from "@ji/db/schema/curated";
import * as schema from "@ji/db/schema/index";
import type { BronId } from "@ji/domain";
import { and, count, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type { SliceABronSlug } from "../slice-a-bronnen";
import { runContinuously } from "./pool";
import type { PollCandidate } from "./schedule";
import {
  byLongestWaiting,
  dueCandidates,
  loadPollCandidates,
  partitionByLiveFlag,
} from "./schedule";

const testDatabaseUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
const applicationUrl =
  process.env.DATABASE_APP_TEST_URL ??
  "postgresql://ji_app:ji_app_local@127.0.0.1:5432/ji_test";
const testDatabaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;

const STALE_AFTER_MS = 60_000;
const TICK_MS = 5;
const progress = { checkpoint: null, metrics: emptyRunMetrics() };

const isPostgresAvailable = async (): Promise<boolean> => {
  const probe = postgres(testDatabaseUrl, { connect_timeout: 2, max: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
    return true;
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return false;
  }
};

/** Polls a condition at 1 ms; the schedulers tick at 5 ms. */
const waitFor = async (condition: () => boolean): Promise<void> => {
  while (!condition()) {
    // oxlint-disable-next-line no-await-in-loop, promise/avoid-new -- timers have no promise API
    await new Promise((resolve) => {
      setTimeout(resolve, 1);
    });
  }
};

/**
 * CTP-619 integration coverage against real Postgres: the persisted
 * scheduler state (interval + newest run + running-row fencing) must make
 * missed-tick coalescing crash-safe and keep two scheduler instances from
 * producing duplicate runs. The `run` stub claims and completes runs
 * through the real `PostgresRunStore`, so the per-bron
 * `pg_advisory_xact_lock` and fence-token path under test is the production
 * one — only the connector work itself is stubbed out.
 */
describe("continuous poller scheduling", () => {
  let available = false;
  let client: ReturnType<typeof postgres> | null = null;
  let database: PostgresJsDatabase<typeof schema> | null = null;
  const bronIds: string[] = [];

  beforeAll(async () => {
    available = await isPostgresAvailable();
    if (!available) {
      if (testDatabaseRequired) {
        throw new Error("Required test database is unavailable");
      }
      return;
    }
    client = postgres(applicationUrl, { max: 4 });
    database = drizzle(client, { schema });
  });

  afterAll(async () => {
    if (database && bronIds.length > 0) {
      await database
        .delete(bronHealth)
        .where(inArray(bronHealth.bronId, bronIds));
      await database
        .delete(scrapeRun)
        .where(inArray(scrapeRun.bronId, bronIds));
      await database.delete(bron).where(inArray(bron.id, bronIds));
    }
    await client?.end({ timeout: 5 });
  });

  const seedBron = async (naam: string): Promise<string> => {
    if (!database) {
      throw new Error("Postgres fixture is unavailable");
    }
    const bronId = crypto.randomUUID();
    bronIds.push(bronId);
    await database.insert(bron).values({
      actief: true,
      categorie: "overheidsportaal",
      id: bronId,
      interval: "*/15 * * * *",
      naam,
      status: "ready",
      voorwaardenStatus: "toegestaan",
    });
    return bronId;
  };

  /**
   * The real candidate feed from `main.ts`, scoped to this spec's seeded
   * bronnen so a caller-provided shared test database cannot make the stub
   * claim runs for bronnen it does not own.
   */
  const dueItemsFor =
    (trackedBronIds: ReadonlySet<string>, evaluations: { count: number }) =>
    async (): Promise<PollCandidate[]> => {
      if (!database) {
        throw new Error("Postgres fixture is unavailable");
      }
      evaluations.count += 1;
      const candidates = await loadPollCandidates(
        {
          bronPersistence: new PostgresBronPersistence(database),
          database,
        },
        { now: new Date(), olderThanMs: STALE_AFTER_MS }
      );
      const { live } = partitionByLiveFlag(
        dueCandidates(candidates, new Date()),
        process.env
      );
      return live
        .filter((candidate) => trackedBronIds.has(candidate.bronId))
        .toSorted(byLongestWaiting);
    };

  /** Claims a poll run through the real store, then completes it. */
  const claimAndComplete = async (
    store: PostgresRunStore,
    candidate: PollCandidate,
    gate?: Promise<void>
  ): Promise<string> => {
    const scrapeRunId = crypto.randomUUID();
    const started = await store.start({
      key: { bronId: candidate.bronId, scrapeRunId },
      mode: "reset",
      progress,
      runKind: "poll",
      startedAt: new Date(),
    });
    await gate;
    await store.complete({
      fenceToken: started.fenceToken,
      finishedAt: new Date(),
      key: { bronId: candidate.bronId, scrapeRunId },
      progress,
    });
    return scrapeRunId;
  };

  it("coalesces three missed ticks into exactly one run, before and after a restart", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const bronId = await seedBron(SOURCES.tenderned.naam);
    // Three */15 ticks went by without a run: last success 46 minutes ago.
    const past = new Date(Date.now() - 46 * 60_000);
    await database.insert(scrapeRun).values({
      bronId,
      createdAt: past,
      fenceToken: 1,
      geindigd: past,
      gestart: past,
      id: crypto.randomUUID(),
      runKind: "poll",
      status: "succeeded",
    });
    const store = new PostgresRunStore(database, {
      pollRunStaleAfterMs: STALE_AFTER_MS,
    });
    const evaluations = { count: 0 };
    const starts: string[] = [];
    const first = new AbortController();

    const firstScheduler = runContinuously<PollCandidate>({
      concurrency: 1,
      dueItems: dueItemsFor(new Set([bronId]), evaluations),
      keyOf: (candidate) => candidate.bronId,
      run: async (candidate) => {
        starts.push(await claimAndComplete(store, candidate));
      },
      signal: first.signal,
      tickMs: TICK_MS,
    });

    await waitFor(() => starts.length === 1);
    // Many more evaluations pass: the bron ran, so no second run appears
    // even though three ticks were missed when it started.
    const evalsAtFirstStart = evaluations.count;
    await waitFor(() => evaluations.count >= evalsAtFirstStart + 4);
    expect(starts).toHaveLength(1);
    first.abort();
    await firstScheduler;

    // A restart re-derives due-ness from the persisted rows only: the bron
    // just ran, so the second instance must not schedule anything.
    const restartEvaluations = { count: 0 };
    const restart = new AbortController();
    const restarted = runContinuously<PollCandidate>({
      concurrency: 1,
      dueItems: dueItemsFor(new Set([bronId]), restartEvaluations),
      keyOf: (candidate) => candidate.bronId,
      run: async (candidate) => {
        starts.push(await claimAndComplete(store, candidate));
      },
      signal: restart.signal,
      tickMs: TICK_MS,
    });
    await waitFor(() => restartEvaluations.count >= 4);
    restart.abort();
    await restarted;
    expect(starts).toHaveLength(1);
  });

  it("does not duplicate an active run across a restart and repairs to exactly one follow-up", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const bronId = await seedBron(SOURCES.inhuurdesk.naam);
    const store = new PostgresRunStore(database, {
      pollRunStaleAfterMs: STALE_AFTER_MS,
    });
    // The crashed scheduler's leftover: a `running` row with no process
    // behind it. `createdAt` sits three ticks back so the bron is due the
    // moment the stale row is repaired — while it is fresh, the running
    // row alone is what keeps the restarted scheduler out.
    const crashedRunId = crypto.randomUUID();
    await database.insert(scrapeRun).values({
      bronId,
      createdAt: new Date(Date.now() - 46 * 60_000),
      fenceToken: 1,
      gestart: new Date(),
      id: crashedRunId,
      runKind: "poll",
      status: "running",
    });

    const evaluations = { count: 0 };
    const starts: string[] = [];
    const controller = new AbortController();
    const scheduler = runContinuously<PollCandidate>({
      concurrency: 1,
      dueItems: dueItemsFor(new Set([bronId]), evaluations),
      keyOf: (candidate) => candidate.bronId,
      run: async (candidate) => {
        starts.push(await claimAndComplete(store, candidate));
      },
      signal: controller.signal,
      tickMs: TICK_MS,
    });

    // While the crashed row still reads as active, the restarted scheduler
    // must not start a duplicate.
    await waitFor(() => evaluations.count >= 4);
    expect(starts).toHaveLength(0);

    // Once the row goes stale and maintenance abandons it, the bron is due
    // and gets exactly one follow-up run.
    await database
      .update(scrapeRun)
      .set({ gestart: new Date(Date.now() - STALE_AFTER_MS - 1000) })
      .where(eq(scrapeRun.id, crashedRunId));
    const abandoned = await abandonStaleRuns(database, {
      now: new Date(),
      olderThanMs: STALE_AFTER_MS,
    });
    expect(abandoned).toContain(crashedRunId);

    await waitFor(() => starts.length === 1);
    const evalsAtStart = evaluations.count;
    await waitFor(() => evaluations.count >= evalsAtStart + 4);
    expect(starts).toHaveLength(1);
    controller.abort();
    await scheduler;

    const [running] = await database
      .select({ value: count() })
      .from(scrapeRun)
      .where(
        and(eq(scrapeRun.bronId, bronId), eq(scrapeRun.status, "running"))
      );
    expect(running?.value).toBe(0);
  });

  it("lets only one of two scheduler instances claim a due bron", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const bronId = await seedBron(SOURCES.bluetrail.naam);
    const storeA = new PostgresRunStore(database, {
      pollRunStaleAfterMs: STALE_AFTER_MS,
    });
    const storeB = new PostgresRunStore(database, {
      pollRunStaleAfterMs: STALE_AFTER_MS,
    });
    const holdA = Promise.withResolvers<null>();
    const aClaimed = Promise.withResolvers<null>();
    const errorsB: unknown[] = [];
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const evaluationsA = { count: 0 };
    let aRunId = "";

    // Scheduler A is fully real: it loads the due bron and claims it.
    const schedulerA = runContinuously<PollCandidate>({
      concurrency: 1,
      dueItems: dueItemsFor(new Set([bronId]), evaluationsA),
      keyOf: (candidate) => candidate.bronId,
      run: async (candidate) => {
        const scrapeRunId = crypto.randomUUID();
        const started = await storeA.start({
          key: { bronId: candidate.bronId, scrapeRunId },
          mode: "reset",
          progress,
          runKind: "poll",
          startedAt: new Date(),
        });
        aRunId = scrapeRunId;
        aClaimed.resolve(null);
        await holdA.promise;
        await storeA.complete({
          fenceToken: started.fenceToken,
          finishedAt: new Date(),
          key: { bronId: candidate.bronId, scrapeRunId },
          progress,
        });
      },
      signal: controllerA.signal,
      tickMs: TICK_MS,
    });
    await aClaimed.promise;

    // Scheduler B still holds its stale due evaluation — as a second
    // poller would when both evaluated before either claim landed. The
    // per-bron xact lock must fence it out instead of double-starting.
    const staleCandidate: PollCandidate = {
      // SAFETY: `bronId` is a fresh `crypto.randomUUID()` — the only shape
      // the BronId brand wraps.
      bronId: bronId as BronId,
      // SAFETY: literal supported slug; `SOURCES.bluetrail` seeded the bron.
      bronSlug: "bluetrail" as SliceABronSlug,
      interval: "*/15 * * * *",
      lastRunAt: null,
    };
    let bEvals = 0;
    const schedulerB = runContinuously<PollCandidate>({
      concurrency: 1,
      dueItems: () => {
        bEvals += 1;
        return Promise.resolve(bEvals === 1 ? [staleCandidate] : []);
      },
      keyOf: (candidate) => candidate.bronId,
      onRunError: (error) => {
        errorsB.push(error);
      },
      run: async (candidate) => {
        await storeB.start({
          key: { bronId: candidate.bronId, scrapeRunId: crypto.randomUUID() },
          mode: "reset",
          progress,
          runKind: "poll",
          startedAt: new Date(),
        });
      },
      signal: controllerB.signal,
      tickMs: TICK_MS,
    });

    await waitFor(() => errorsB.length === 1);
    expect(errorsB[0]).toBeInstanceOf(RunAlreadyInProgressError);

    // Exactly one active run, owned by A's health row, ever existed.
    const [running] = await database
      .select({ value: count() })
      .from(scrapeRun)
      .where(
        and(eq(scrapeRun.bronId, bronId), eq(scrapeRun.status, "running"))
      );
    expect(running?.value).toBe(1);
    const [health] = await database
      .select()
      .from(bronHealth)
      .where(eq(bronHealth.bronId, bronId));
    expect(health?.activeRunId).toBe(aRunId);

    holdA.resolve(null);
    controllerA.abort();
    controllerB.abort();
    await schedulerA;
    await schedulerB;

    // One domain mutation total: a single scrape_run row, now succeeded.
    const [total] = await database
      .select({ value: count() })
      .from(scrapeRun)
      .where(eq(scrapeRun.bronId, bronId));
    expect(total?.value).toBe(1);
  });
});
