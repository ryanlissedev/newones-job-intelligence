import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";

import { emptyRunMetrics } from "@ji/connectors";
import { abandonStaleRuns } from "@ji/db/abandon-stale-runs";
import { PostgresRunStore } from "@ji/db/bron-runtime";
import { bron, bronHealth, scrapeRun } from "@ji/db/schema/curated";
import * as schema from "@ji/db/schema/index";
import { and, count, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  BRON_INGEST_QUEUE,
  createBronIngestQueue,
  offerBronIngestJob,
  runDurableBronJobConsumer,
} from "./durable-jobs";
import type { BronIngestJob } from "./durable-jobs";

const testDatabaseUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
const applicationUrl =
  process.env.DATABASE_APP_TEST_URL ??
  "postgresql://ji_app:ji_app_local@127.0.0.1:5432/ji_test";
const testDatabaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;

const progress = { checkpoint: null, metrics: emptyRunMetrics() };
const STRIIVE_ID = "00000000-0000-4000-8000-000000000008";
// The queue name is fixed (`bron-ingest`); isolation comes from the
// per-spec test database the test-isolation preload hands each spec file.
const QUEUE = BRON_INGEST_QUEUE;

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

const waitFor = async (
  condition: () => boolean | Promise<boolean>
): Promise<void> => {
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- polling is the point of the helper
    if (await condition()) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop, promise/avoid-new -- timers have no promise API
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
};

const sleep = (ms: number): Promise<void> =>
  // oxlint-disable-next-line promise/avoid-new -- timers have no promise API
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

interface JobRow {
  readonly acquired_by: string | null;
  readonly attempts: number;
  readonly completed: boolean;
  readonly id: string;
  readonly last_failure: string | null;
}

/**
 * CTP-622 worker-level restart matrix against real Postgres. `processJob`
 * mirrors `runBronIngestPipeline`'s dedupe-on-identity exactly — succeeded
 * run → replay, running run → resume through `store.start` (which bumps the
 * fence), missing → start+complete — but stops before the connector so the
 * deterministic parts of exactly-once (queue dedup, resume, ack ordering,
 * dead-letter inspection) stay deterministic.
 */
describe.serial("durable bron job consumer", () => {
  let available = false;
  let client: ReturnType<typeof postgres> | null = null;
  let database: PostgresJsDatabase<typeof schema> | null = null;
  let store: PostgresRunStore | null = null;
  let seededBron = false;
  const scrapeRunIds: string[] = [];

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
    store = new PostgresRunStore(database, { pollRunStaleAfterMs: 60_000 });
    const [existing] = await database
      .select({ id: bron.id })
      .from(bron)
      .where(eq(bron.id, STRIIVE_ID));
    if (!existing) {
      seededBron = true;
      await database.insert(bron).values({
        actief: true,
        categorie: "overheidsportaal",
        id: STRIIVE_ID,
        interval: "*/15 * * * *",
        naam: "Striive",
        status: "ready",
        voorwaardenStatus: "toegestaan",
      });
    }
  });

  afterEach(async () => {
    // A leftover `running` scrape_run would fence out the next test's start
    // (RunAlreadyInProgressError), and leftover queue rows would be claimed
    // by the next test's consumer — wipe both between tests.
    if (database && client) {
      await client`DELETE FROM curated.durable_job WHERE queue_name = ${QUEUE}`;
      if (scrapeRunIds.length > 0) {
        await database
          .delete(scrapeRun)
          .where(inArray(scrapeRun.id, scrapeRunIds));
        scrapeRunIds.length = 0;
      }
      await database
        .delete(bronHealth)
        .where(eq(bronHealth.bronId, STRIIVE_ID));
    }
  });

  afterAll(async () => {
    if (database && client) {
      await client`DELETE FROM curated.durable_job WHERE queue_name = ${QUEUE}`;
      if (scrapeRunIds.length > 0) {
        await database
          .delete(scrapeRun)
          .where(inArray(scrapeRun.id, scrapeRunIds));
      }
      if (seededBron) {
        await database
          .delete(bronHealth)
          .where(eq(bronHealth.bronId, STRIIVE_ID));
        await database.delete(bron).where(eq(bron.id, STRIIVE_ID));
      }
    }
    await client?.end({ timeout: 5 });
  });

  const rows = async (): Promise<JobRow[]> => {
    if (!client) {
      throw new Error("Postgres fixture is unavailable");
    }
    return await client<JobRow[]>`
      SELECT id, completed, attempts, last_failure, acquired_by
      FROM curated.durable_job
      WHERE queue_name = ${QUEUE}
      ORDER BY sequence ASC
    `;
  };

  const makeJob = (): BronIngestJob => {
    const scrapeRunId = crypto.randomUUID();
    scrapeRunIds.push(scrapeRunId);
    return { bronId: STRIIVE_ID, bronSlug: "striive", scrapeRunId };
  };

  /**
   * Pipeline-shaped processJob: replay a finished run, resume a live or
   * failed one (the store reopens a `failed` row on resume, CTP-643), start
   * a new one. `crashAfterCommit` throws once after the domain commit to
   * simulate kill-after-commit-before-ack; `failConnectorOnce` records the
   * run as `failed` through `store.fail` — what a real connector failure
   * does — then throws so the attempt counts.
   */
  const pipelineLikeJob =
    (behaviour: {
      readonly crashAfterCommit?: { current: boolean };
      readonly crashBeforeCommit?: { current: boolean };
      readonly failConnectorOnce?: { current: boolean };
      readonly alwaysFail?: boolean;
    }): ((job: BronIngestJob) => Promise<void>) =>
    async (job) => {
      if (!database || !store) {
        throw new Error("Postgres fixture is unavailable");
      }
      if (behaviour.alwaysFail) {
        // A permanently failing connector: no domain row ever commits, the
        // job burns attempts until the dead letter stops the claims.
        throw new Error("permanent connector failure");
      }
      const [existing] = await database
        .select({ status: scrapeRun.status })
        .from(scrapeRun)
        .where(eq(scrapeRun.id, job.scrapeRunId));
      if (existing?.status === "succeeded") {
        return;
      }
      const mode = existing ? "resume" : "reset";
      const started = await store.start({
        key: { bronId: job.bronId, scrapeRunId: job.scrapeRunId },
        mode,
        progress,
        runKind: "poll",
        startedAt: new Date(),
      });
      if (behaviour.crashBeforeCommit?.current) {
        behaviour.crashBeforeCommit.current = false;
        throw new Error("worker killed mid-run before the domain commit");
      }
      if (behaviour.failConnectorOnce?.current) {
        behaviour.failConnectorOnce.current = false;
        await store.fail({
          failure: {
            class: "internal",
            code: "UNEXPECTED_FAILURE",
            message: "Connector run failed",
            phase: "unknown",
          },
          fenceToken: started.fenceToken,
          finishedAt: new Date(),
          key: { bronId: job.bronId, scrapeRunId: job.scrapeRunId },
          progress,
        });
        throw new Error("connector exploded mid-run");
      }
      await store.complete({
        fenceToken: started.fenceToken,
        finishedAt: new Date(),
        key: { bronId: job.bronId, scrapeRunId: job.scrapeRunId },
        progress,
      });
      if (behaviour.crashAfterCommit?.current) {
        behaviour.crashAfterCommit.current = false;
        throw new Error("worker died after domain commit before queue ack");
      }
    };

  const runConsumer = (options: {
    readonly behaviour: Parameters<typeof pipelineLikeJob>[0];
    readonly job: BronIngestJob;
    readonly maxAttempts?: number;
  }) => {
    const controller = new AbortController();
    const consumerDone = Promise.withResolvers<boolean>();
    void (async () => {
      const queue = await createBronIngestQueue(applicationUrl, {
        lockExpiration: "1 seconds",
        lockRefreshInterval: "50 millis",
        pollInterval: "20 millis",
      });
      try {
        await offerBronIngestJob(queue.queue, options.job);
        await runDurableBronJobConsumer({
          maxAttempts: options.maxAttempts ?? 5,
          processJob: pipelineLikeJob(options.behaviour),
          queue: queue.queue,
          signal: controller.signal,
        });
      } finally {
        await queue.close();
        consumerDone.resolve(true);
      }
    })();
    return {
      abort: async () => {
        controller.abort();
        await consumerDone.promise;
      },
      done: consumerDone.promise,
    };
  };

  it("completes the domain run and the queue row once", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const job = makeJob();
    const consumer = runConsumer({ behaviour: {}, job });
    await waitFor(async () => {
      const [row] = await rows();
      return row?.completed === true;
    });
    await consumer.abort();

    const [run] = await database
      .select({ status: scrapeRun.status })
      .from(scrapeRun)
      .where(eq(scrapeRun.id, job.scrapeRunId));
    expect(run?.status).toBe("succeeded");
    const [row] = await rows();
    expect(row?.completed).toBe(true);
    expect(row?.attempts).toBe(1);
  });

  it("kill-before-commit: replay resumes the same run to exactly one result", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const job = makeJob();
    const consumer = runConsumer({
      behaviour: { crashBeforeCommit: { current: true } },
      job,
    });
    await waitFor(async () => {
      const [row] = await rows();
      return row?.completed === true;
    });
    await consumer.abort();

    const runs = await database
      .select({ status: scrapeRun.status })
      .from(scrapeRun)
      .where(
        and(eq(scrapeRun.id, job.scrapeRunId), eq(scrapeRun.bronId, STRIIVE_ID))
      );
    expect(runs).toEqual([{ status: "succeeded" }]);
    const [row] = await rows();
    expect(row?.completed).toBe(true);
    expect(row?.attempts).toBe(2);
  });

  it("kill-after-commit-before-ack: replay produces no second domain result", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const job = makeJob();
    const consumer = runConsumer({
      behaviour: { crashAfterCommit: { current: true } },
      job,
    });
    await waitFor(async () => {
      const [row] = await rows();
      return row?.completed === true;
    });
    await consumer.abort();

    const [aggregate] = await database
      .select({ runCount: count() })
      .from(scrapeRun)
      .where(eq(scrapeRun.id, job.scrapeRunId));
    expect(aggregate?.runCount).toBe(1);
    const [row] = await rows();
    expect(row?.completed).toBe(true);
    expect(row?.attempts).toBe(2);
  });

  it("exhausted attempts close the dead letter and free the bron for a fresh job", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const job = makeJob();
    const consumer = runConsumer({
      behaviour: { alwaysFail: true },
      job,
      maxAttempts: 2,
    });
    await waitFor(async () => {
      const [row] = await rows();
      return row?.attempts === 2;
    });
    // The dead letter must stay visible, not get re-claimed forever.
    await sleep(150);
    await consumer.abort();

    const [row] = await rows();
    // CTP-643: the exhausting attempt closes the row, so the open-bron index
    // no longer pins the bron to a job that will never run again.
    expect(row?.completed).toBe(true);
    expect(row?.attempts).toBe(2);
    expect(row?.last_failure).toContain("permanent connector failure");
    expect(row?.acquired_by).toBeNull();

    const [run] = await database
      .select({ status: scrapeRun.status })
      .from(scrapeRun)
      .where(eq(scrapeRun.id, job.scrapeRunId));
    // A permanently failing job commits no domain row at all — the dead
    // letter and the absent scrape_run are both inspectable after restart.
    expect(run).toBeUndefined();

    // Before the fix this offer was swallowed by durable_job_open_bron_uidx.
    const fresh = makeJob();
    const freshConsumer = runConsumer({ behaviour: {}, job: fresh });
    try {
      await waitFor(async () => {
        const all = await rows();
        return all.length === 2 && all.every((entry) => entry.completed);
      });
    } finally {
      await freshConsumer.abort();
    }
    const afterFreshJob = await rows();
    expect(afterFreshJob.map((entry) => entry.id)).toEqual([
      job.scrapeRunId,
      fresh.scrapeRunId,
    ]);
  });

  it("a stale claim from a dead worker is fenced out and re-claimed after lease expiry", async () => {
    if (!available || !database || !client || !store) {
      expect(available).toBe(false);
      return;
    }
    const job = makeJob();
    // The dead worker had claimed the row AND started the domain run; it
    // died holding a stale fence. The successor must resume under a new
    // fence and finish — the stale holder can never commit again.
    const deadWorker = await store.start({
      key: { bronId: job.bronId, scrapeRunId: job.scrapeRunId },
      mode: "reset",
      progress,
      runKind: "poll",
      startedAt: new Date(),
    });
    // Through drizzle, not the raw client: drizzle's postgres-js driver
    // replaces serializers[3802] with a pass-through, so sql.json() on the
    // wrapped client would push a live object into the wire encoder.
    await database.execute(drizzleSql`
      INSERT INTO curated.durable_job (id, queue_name, element, acquired_at, acquired_by)
      VALUES (
        ${job.scrapeRunId},
        ${QUEUE},
        ${JSON.stringify(job)}::jsonb,
        now() - interval '10 seconds',
        ${crypto.randomUUID()}::uuid
      )
    `);

    const consumer = runConsumer({ behaviour: {}, job });
    await waitFor(async () => {
      const [row] = await rows();
      return row?.completed === true;
    });
    await consumer.abort();

    const [run] = await database
      .select({ fenceToken: scrapeRun.fenceToken, status: scrapeRun.status })
      .from(scrapeRun)
      .where(eq(scrapeRun.id, job.scrapeRunId));
    expect(run?.status).toBe("succeeded");
    // Resume bumped the fence; the dead worker's token is now fenced out.
    expect(run?.fenceToken).toBe(deadWorker.fenceToken + 1);

    // Prove the stale fence is dead: completing with it must throw.
    await expect(
      store.complete({
        fenceToken: deadWorker.fenceToken,
        finishedAt: new Date(),
        key: { bronId: job.bronId, scrapeRunId: job.scrapeRunId },
        progress,
      })
    ).rejects.toThrow();
  });

  it("a recorded connector failure is resumed on retake: same scrapeRunId, one succeeded run", async () => {
    if (!available || !database) {
      expect(available).toBe(false);
      return;
    }
    const job = makeJob();
    const consumer = runConsumer({
      behaviour: { failConnectorOnce: { current: true } },
      job,
    });
    await waitFor(async () => {
      const [row] = await rows();
      return row?.completed === true;
    });
    await consumer.abort();

    const [row] = await rows();
    expect(row?.completed).toBe(true);
    // One failing take that recorded the `failed` run, one retake that
    // reopened it under a new fence and completed it.
    expect(row?.attempts).toBe(2);
    expect(row?.last_failure).toBeNull();
    // Before CTP-643 `store.start` refused the failed row on every retake
    // ("Cannot resume mismatched or completed scrape run") and the job
    // burned all attempts; now the same run resumes and commits once.
    const runs = await database
      .select({ fenceToken: scrapeRun.fenceToken, status: scrapeRun.status })
      .from(scrapeRun)
      .where(eq(scrapeRun.id, job.scrapeRunId));
    expect(runs).toEqual([{ fenceToken: 2, status: "succeeded" }]);
  });

  it("a run abandoned as stale is resumed on retake, not refused", async () => {
    if (!available || !database || !store) {
      expect(available).toBe(false);
      return;
    }
    const job = makeJob();
    // The shape a crashed worker leaves: a `running` row that
    // abandonStaleRuns flips to `failed` on the next maintenance tick.
    await store.start({
      key: { bronId: job.bronId, scrapeRunId: job.scrapeRunId },
      mode: "reset",
      progress,
      runKind: "poll",
      startedAt: new Date(),
    });
    const olderThanMs = 60_000;
    const abandoned = await abandonStaleRuns(database, {
      now: new Date(Date.now() + olderThanMs + 1),
      olderThanMs,
    });
    expect(abandoned).toContain(job.scrapeRunId);

    const consumer = runConsumer({ behaviour: {}, job });
    await waitFor(async () => {
      const [row] = await rows();
      return row?.completed === true;
    });
    await consumer.abort();

    const [row] = await rows();
    expect(row?.completed).toBe(true);
    expect(row?.attempts).toBe(1);
    const [run] = await database
      .select({ fenceToken: scrapeRun.fenceToken, status: scrapeRun.status })
      .from(scrapeRun)
      .where(eq(scrapeRun.id, job.scrapeRunId));
    // reset → 1, abandonStaleRuns → 2, reopen on resume → 3.
    expect(run).toEqual({ fenceToken: 3, status: "succeeded" });
  });
});
