import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";

import * as schema from "@ji/db/schema/index";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  countClaimableEnrichmentJobs,
  createEnrichmentQueue,
  drainEnrichmentQueue,
  ENRICHMENT_QUEUE,
  enrichmentJobId,
  offerEnrichmentJob,
} from "./enrichment-jobs";
import type { EnrichmentJob, EnrichmentQueue } from "./enrichment-jobs";

const testDatabaseUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
const applicationUrl =
  process.env.DATABASE_APP_TEST_URL ??
  "postgresql://ji_app:ji_app_local@127.0.0.1:5432/ji_test";
const testDatabaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;

const LOCK_EXPIRATION_SECONDS = 1;

interface JobRow {
  readonly attempts: number;
  readonly completed: boolean;
  readonly id: string;
}

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

const makeJob = (): EnrichmentJob => ({
  aanvraagId: crypto.randomUUID(),
  expectedUpdatedAt: "2026-09-20T10:00:00.000Z",
});

/**
 * CTP-626 queue mechanics. The domain apply is proven in
 * packages/db/src/enrichment-store.integration.spec.ts; this file proves the
 * job identity, the kill-after-commit replay path and that a drain ends on
 * an empty queue.
 */
describe.serial("enrichment job queue", () => {
  let available = false;
  let client: ReturnType<typeof postgres> | null = null;
  let database: PostgresJsDatabase<typeof schema> | null = null;
  let queue: EnrichmentQueue | null = null;

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
    queue = await createEnrichmentQueue(applicationUrl, {
      lockExpiration: `${LOCK_EXPIRATION_SECONDS} seconds`,
      lockRefreshInterval: "50 millis",
      pollInterval: "20 millis",
    });
  });

  afterEach(async () => {
    if (client) {
      await client`DELETE FROM curated.durable_job WHERE queue_name = ${ENRICHMENT_QUEUE}`;
    }
  });

  afterAll(async () => {
    await queue?.close();
    await client?.end({ timeout: 5 });
  });

  const rows = async (): Promise<JobRow[]> => {
    if (!client) {
      throw new Error("Postgres fixture is unavailable");
    }
    return await client<JobRow[]>`
      SELECT id, completed, attempts
      FROM curated.durable_job
      WHERE queue_name = ${ENRICHMENT_QUEUE}
      ORDER BY sequence ASC
    `;
  };

  it("keys a job on aanvraagId plus the updated_at token and dedupes a re-offer", async () => {
    if (!available || !queue) {
      expect(available).toBe(false);
      return;
    }
    const job = makeJob();
    expect(enrichmentJobId(job)).toBe(
      `${job.aanvraagId}:2026-09-20T10:00:00.000Z`
    );
    await offerEnrichmentJob(queue.queue, job);
    await offerEnrichmentJob(queue.queue, job);
    // A newer row state is a different job.
    await offerEnrichmentJob(queue.queue, {
      ...job,
      expectedUpdatedAt: "2026-09-20T10:05:00.000Z",
    });
    const offered = await rows();
    expect(offered.map((row) => row.id)).toEqual([
      enrichmentJobId(job),
      `${job.aanvraagId}:2026-09-20T10:05:00.000Z`,
    ]);
  });

  it("kill-after-commit-before-ack: the replay acks without a second domain write", async () => {
    if (!available || !queue || !database) {
      expect(available).toBe(false);
      return;
    }
    const job = makeJob();
    await offerEnrichmentJob(queue.queue, job);
    // Stand-in for applyEnrichmentAtomically: the first call "commits" and
    // the worker dies before the ack; the second call finds the token stale.
    const outcomes: string[] = [];
    let committed = false;
    const processJob = (taken: EnrichmentJob): Promise<void> => {
      expect(taken).toEqual(job);
      if (committed) {
        outcomes.push("stale");
        return Promise.resolve();
      }
      committed = true;
      outcomes.push("applied");
      return Promise.reject(new Error("worker died after commit before ack"));
    };

    const summary = await drainEnrichmentQueue({
      database,
      lockExpirationSeconds: LOCK_EXPIRATION_SECONDS,
      maxAttempts: 3,
      maxJobs: 5,
      processJob,
      queue: queue.queue,
      signal: new AbortController().signal,
    });
    expect(summary).toEqual({ failed: 1, processed: 1 });
    expect(outcomes).toEqual(["applied", "stale"]);
    const [row] = await rows();
    expect(row?.completed).toBe(true);
    expect(row?.attempts).toBe(2);
  });

  it("stops when the queue has nothing claimable instead of blocking", async () => {
    if (!available || !queue || !database) {
      expect(available).toBe(false);
      return;
    }
    expect(
      await countClaimableEnrichmentJobs(database, 3, LOCK_EXPIRATION_SECONDS)
    ).toBe(0);
    const startedAt = Date.now();
    const summary = await drainEnrichmentQueue({
      database,
      lockExpirationSeconds: LOCK_EXPIRATION_SECONDS,
      maxAttempts: 3,
      maxJobs: 5,
      processJob: () => Promise.reject(new Error("must not be called")),
      queue: queue.queue,
      signal: new AbortController().signal,
    });
    expect(summary).toEqual({ failed: 0, processed: 0 });
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });

  it("honours maxJobs and leaves the rest for the next run", async () => {
    if (!available || !queue || !database) {
      expect(available).toBe(false);
      return;
    }
    await offerEnrichmentJob(queue.queue, makeJob());
    await offerEnrichmentJob(queue.queue, makeJob());
    await offerEnrichmentJob(queue.queue, makeJob());
    const summary = await drainEnrichmentQueue({
      database,
      lockExpirationSeconds: LOCK_EXPIRATION_SECONDS,
      maxAttempts: 3,
      maxJobs: 2,
      processJob: () => Promise.resolve(),
      queue: queue.queue,
      signal: new AbortController().signal,
    });
    expect(summary).toEqual({ failed: 0, processed: 2 });
    const drained = await rows();
    expect(drained.map((row) => row.completed)).toEqual([true, true, false]);
  });
});
