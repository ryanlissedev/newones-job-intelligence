import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";

import { Cause, Effect, Exit, Schema, Scope } from "effect";
import {
  layer as persistedQueueLayer,
  make as makePersistedQueue,
  PersistedQueueStore,
} from "effect/unstable/persistence/PersistedQueue";
import type { PersistedQueue } from "effect/unstable/persistence/PersistedQueue";
import postgres from "postgres";

import { makePostgresPersistedQueueStore } from "./persisted-queue-store";
import type { PersistedQueueStorePostgres } from "./persisted-queue-store";

const migratorUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
const appUrl =
  process.env.DATABASE_APP_TEST_URL ??
  "postgresql://ji_app:ji_app_local@127.0.0.1:5432/ji_test";
const testDatabaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;

const QUEUE = `spec-bron-ingest-${crypto.randomUUID().slice(0, 8)}`;

const testJob = Schema.Struct({
  bronId: Schema.String.check(Schema.isUUID()),
  bronSlug: Schema.String,
  scrapeRunId: Schema.String.check(Schema.isUUID()),
});
type TestJob = typeof testJob.Type;

const makeJob = (overrides: Partial<TestJob> = {}): TestJob => ({
  bronId: crypto.randomUUID(),
  bronSlug: "striive",
  scrapeRunId: crypto.randomUUID(),
  ...overrides,
});

interface JobRow {
  readonly acquired_by: string | null;
  readonly attempts: number;
  readonly completed: boolean;
  readonly id: string;
  readonly last_failure: string | null;
}

const isPostgresAvailable = async (url: string): Promise<boolean> => {
  const probe = postgres(url, { connect_timeout: 2, max: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
    return true;
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return false;
  }
};

const sleep = (ms: number): Promise<void> =>
  // oxlint-disable-next-line promise/avoid-new -- timers have no promise API
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * CTP-622 store-level restart matrix against real Postgres. The store runs
 * on `DATABASE_APP_TEST_URL` — the least-privilege `ji_app` role — which is
 * the proof that the worker path never needs DDL rights: the table comes
 * from migration 0029 applied by the test-isolation preload as `ji_migrator`.
 */
describe.serial("postgres persisted queue store", () => {
  let available = false;
  let client: ReturnType<typeof postgres> | null = null;
  let scope: Scope.Closeable | null = null;
  let store: PersistedQueueStorePostgres | null = null;
  let queue: PersistedQueue<TestJob> | null = null;

  beforeAll(async () => {
    available = await isPostgresAvailable(migratorUrl);
    if (!available) {
      if (testDatabaseRequired) {
        throw new Error("Required test database is unavailable");
      }
      return;
    }
    client = postgres(appUrl, { max: 4 });
    scope = await Effect.runPromise(Scope.make());
    store = await Effect.runPromise(
      makePostgresPersistedQueueStore(appUrl, {
        lockExpiration: "1 seconds",
        lockRefreshInterval: "50 millis",
        pollInterval: "20 millis",
      }).pipe(Effect.provideService(Scope.Scope, scope))
    );
    queue = await Effect.runPromise(
      makePersistedQueue({ name: QUEUE, schema: testJob }).pipe(
        Effect.provide(persistedQueueLayer),
        Effect.provideService(PersistedQueueStore, store)
      )
    );
  });

  afterEach(async () => {
    // Tests share one queue name, so each leaves the table empty for the next.
    if (client) {
      await client`DELETE FROM curated.durable_job WHERE queue_name = ${QUEUE}`;
    }
  });

  afterAll(async () => {
    if (client) {
      await client`DELETE FROM curated.durable_job WHERE queue_name = ${QUEUE}`;
    }
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
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

  it("takes an offered job and completes its row on handler success", async () => {
    if (!available || !queue) {
      expect(available).toBe(false);
      return;
    }
    const job = makeJob();
    await Effect.runPromise(queue.offer(job, { id: job.scrapeRunId }));

    const seen: TestJob[] = [];
    await Effect.runPromise(
      queue.take((value) => {
        seen.push(value);
        return Effect.void;
      })
    );

    expect(seen).toEqual([job]);
    const [row] = await rows();
    expect(row?.id).toBe(job.scrapeRunId);
    expect(row?.completed).toBe(true);
    expect(row?.attempts).toBe(1);
    expect(row?.acquired_by).toBeNull();
  });

  it("dedupes a re-offered job id and a second open job for the same bron", async () => {
    if (!available || !queue) {
      expect(available).toBe(false);
      return;
    }
    const job = makeJob();
    await Effect.runPromise(queue.offer(job, { id: job.scrapeRunId }));
    await Effect.runPromise(queue.offer(job, { id: job.scrapeRunId }));
    // A different scrapeRunId for a bron with an open job must not become a
    // second domain run — durable_job_open_bron_uidx swallows the insert.
    const second = makeJob({ bronId: job.bronId });
    await Effect.runPromise(queue.offer(second, { id: second.scrapeRunId }));

    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(job.scrapeRunId);
  });

  it("releases a failed take with one attempt spent, then completes on retry", async () => {
    if (!available || !queue) {
      expect(available).toBe(false);
      return;
    }
    const job = makeJob();
    await Effect.runPromise(queue.offer(job, { id: job.scrapeRunId }));

    await Effect.runPromiseExit(
      queue.take(() => Effect.fail(new Error("connector blew up")))
    );
    const [failed] = await rows();
    expect(failed?.completed).toBe(false);
    expect(failed?.attempts).toBe(1);
    expect(failed?.last_failure).toContain("connector blew up");
    expect(failed?.acquired_by).toBeNull();

    await Effect.runPromise(queue.take(() => Effect.void));
    const [done] = await rows();
    expect(done?.completed).toBe(true);
    expect(done?.attempts).toBe(2);
    // Success clears the failure, so `completed AND last_failure IS NOT NULL`
    // is exactly the dead-letter set.
    expect(done?.last_failure).toBeNull();
  });

  it("releases an interrupted take without spending an attempt", async () => {
    if (!available || !queue) {
      expect(available).toBe(false);
      return;
    }
    const job = makeJob();
    await Effect.runPromise(queue.offer(job, { id: job.scrapeRunId }));

    const claimed = Promise.withResolvers<boolean>();
    const controller = new AbortController();
    const takePromise = Effect.runPromiseExit(
      queue.take(() =>
        Effect.suspend(() => {
          claimed.resolve(true);
          return Effect.never;
        })
      ),
      { signal: controller.signal }
    );
    await claimed.promise;
    controller.abort();
    await takePromise;

    const [row] = await rows();
    expect(row?.completed).toBe(false);
    expect(row?.attempts).toBe(0);
    expect(row?.acquired_by).toBeNull();

    await Effect.runPromise(queue.take(() => Effect.void));
    const [done] = await rows();
    expect(done?.completed).toBe(true);
    expect(done?.attempts).toBe(1);
  });

  it("re-claims a job whose lease expired under a dead worker", async () => {
    if (!available || !queue) {
      expect(available).toBe(false);
      return;
    }
    if (!client) {
      throw new Error("Postgres fixture is unavailable");
    }
    const job = makeJob();
    // Kill-before-commit shape: a claimed row whose owner vanished, stale
    // past lockExpiration (1 s in this suite), must be re-claimable.
    await client`
      INSERT INTO curated.durable_job (id, queue_name, element, acquired_at, acquired_by)
      VALUES (
        ${job.scrapeRunId},
        ${QUEUE},
        ${client.json(job)},
        now() - interval '10 seconds',
        ${crypto.randomUUID()}::uuid
      )
    `;

    const seen: TestJob[] = [];
    await Effect.runPromise(
      queue.take((value) => {
        seen.push(value);
        return Effect.void;
      })
    );
    expect(seen).toEqual([job]);
    const [row] = await rows();
    expect(row?.completed).toBe(true);
  });

  it("closes an exhausted job as a dead letter and frees its bron", async () => {
    if (!available || !queue) {
      expect(available).toBe(false);
      return;
    }
    const job = makeJob();
    await Effect.runPromise(queue.offer(job, { id: job.scrapeRunId }));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- attempts must serialize to count honestly
      await Effect.runPromiseExit(
        queue.take(() => Effect.fail(new Error("permanent failure")), {
          maxAttempts: 2,
        })
      );
    }
    const [row] = await rows();
    // CTP-643: the attempt that reaches maxAttempts closes the row. It stays
    // inspectable through `last_failure`, and because it is no longer open
    // the partial unique index lets the bron be offered again.
    expect(row?.completed).toBe(true);
    expect(row?.attempts).toBe(2);
    expect(row?.last_failure).toContain("permanent failure");

    // The dead letter is never claimed again — a pending take only sees silence.
    const controller = new AbortController();
    const orphan = Effect.runPromiseExit(
      queue.take(() => Effect.void, { maxAttempts: 2 }),
      { signal: controller.signal }
    );
    const winner = await Promise.race([
      orphan.then(() => "taken" as const),
      sleep(300).then(() => "waiting" as const),
    ]);
    controller.abort();
    await orphan;
    expect(winner).toBe("waiting");

    const fresh = makeJob({ bronId: job.bronId });
    await Effect.runPromise(queue.offer(fresh, { id: fresh.scrapeRunId }));
    const afterFreshOffer = await rows();
    expect(afterFreshOffer.map((entry) => entry.id)).toEqual([
      job.scrapeRunId,
      fresh.scrapeRunId,
    ]);
  });

  it("never hands one row to two takers", async () => {
    if (!available || !queue) {
      expect(available).toBe(false);
      return;
    }
    const liveQueue = queue;
    const job = makeJob();
    await Effect.runPromise(liveQueue.offer(job, { id: job.scrapeRunId }));

    const seen: string[] = [];
    const controller = new AbortController();
    const taker = (name: string) =>
      Effect.runPromiseExit(
        liveQueue.take((value) => {
          seen.push(`${name}:${value.scrapeRunId}`);
          return Effect.void;
        }),
        { signal: controller.signal }
      );
    const first = taker("a");
    const second = taker("b");
    // `second` stays pending — the row is claimed once and never re-offered —
    // so only the winner and the delay bound this wait.
    await Promise.allSettled([first, sleep(400)]);
    controller.abort();
    await Promise.allSettled([first, second]);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(`a:${job.scrapeRunId}`);
  });

  it("keeps polling through a DB outage instead of failing the take", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    const deadScope = await Effect.runPromise(Scope.make());
    const deadStore = await Effect.runPromise(
      makePostgresPersistedQueueStore(
        "postgresql://ji_app:ji_app_local@127.0.0.1:1/ji_test",
        { pollInterval: "20 millis" }
      ).pipe(Effect.provideService(Scope.Scope, deadScope))
    );
    try {
      const controller = new AbortController();
      const take = Effect.runPromiseExit(
        Effect.scoped(deadStore.take({ maxAttempts: 1, name: QUEUE })),
        { signal: controller.signal }
      );
      const winner = await Promise.race([
        take.then(() => "settled" as const),
        sleep(300).then(() => "waiting" as const),
      ]);
      controller.abort();
      await take;
      // An outage parks the take in the claim loop — it must never settle
      // as a failure, because a dead-lettered consumer would strand jobs.
      expect(winner).toBe("waiting");
    } finally {
      await Effect.runPromise(Scope.close(deadScope, Exit.void));
    }
    // sql.end's 5 s drain wait on a dead pool is what this timeout covers.
  }, 15_000);

  it("an interrupt during the claim ends the take instead of repolling", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    // A long poll interval parks the take in the claim loop: the interrupt
    // must end it, not be consumed by the claim-failure recovery.
    const slowScope = await Effect.runPromise(Scope.make());
    const slowStore = await Effect.runPromise(
      makePostgresPersistedQueueStore(appUrl, {
        lockExpiration: "1 seconds",
        lockRefreshInterval: "50 millis",
        pollInterval: "10 seconds",
      }).pipe(Effect.provideService(Scope.Scope, slowScope))
    );
    try {
      const controller = new AbortController();
      const take = Effect.runPromiseExit(
        Effect.scoped(slowStore.take({ maxAttempts: 1, name: QUEUE })),
        { signal: controller.signal }
      );
      await sleep(50);
      controller.abort();
      const winner = await Promise.race([
        take.then((exit) => ({ exit }) as const),
        sleep(2000).then(() => "hung" as const),
      ]);
      if (winner === "hung") {
        throw new Error("interrupted take did not settle within 2 s");
      }
      expect(Exit.isFailure(winner.exit)).toBe(true);
      if (Exit.isFailure(winner.exit)) {
        expect(Cause.hasInterruptsOnly(winner.exit.cause)).toBe(true);
      }
    } finally {
      await Effect.runPromise(Scope.close(slowScope, Exit.void));
    }
  });
});
