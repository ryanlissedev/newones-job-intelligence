import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";

import { SOURCES } from "@ji/application/sources";
import { RunOwnershipLostError } from "@ji/connectors";
import { PostgresPollerHealthTelemetryStore } from "@ji/db/poller-health-telemetry-store";
import {
  bron,
  bronHealth,
  pollerRuntime,
  scrapeRun,
} from "@ji/db/schema/curated";
import * as schema from "@ji/db/schema/index";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import type { PollBronRuntime } from "../poll-bron-run";
import { createPollerRuntimeHealth } from "./runtime-health";
import { createSourceHealthCallbacks } from "./source-health";

const testDatabaseUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
process.env.DATABASE_URL ??= testDatabaseUrl;
const migrationsFolder = path.join(
  import.meta.dir,
  "../../../../packages/db/src/migrations"
);
const databaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;

const isPostgresAvailable = async (): Promise<boolean> => {
  const probe = postgres(testDatabaseUrl, { connect_timeout: 2, max: 1 });
  try {
    await probe`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.end({ timeout: 1 }).catch(() => {});
  }
};
const postgresAvailable = await isPostgresAvailable();
if (!postgresAvailable && databaseRequired) {
  throw new Error("Required test database is unavailable");
}

const baseline = new Date("2026-09-19T12:00:00.000Z");

describe
  .skipIf(!postgresAvailable)
  .serial("poller abort finalization integration", () => {
    let sqlClient: ReturnType<typeof postgres>;
    let database: ReturnType<typeof drizzle<typeof schema>>;
    let runtimeHealth: Awaited<ReturnType<typeof createPollerRuntimeHealth>>;
    let runtime: PollBronRuntime;
    let bronId: string;
    let sourceSlug: string;
    let firstRunId: string;
    let successorRunId: string;
    let sourceWasAdded = false;

    beforeAll(async () => {
      sqlClient = postgres(testDatabaseUrl, { max: 2 });
      database = drizzle(sqlClient, { schema });
      await migrate(database, { migrationsFolder });

      const source = SOURCES.hero;
      bronId = crypto.randomUUID();
      sourceSlug = `abort-pipeline-${bronId.slice(0, 8)}`;
      firstRunId = crypto.randomUUID();
      successorRunId = crypto.randomUUID();
      // SAFETY: this test-only registry entry is unique and removed in afterAll.
      Object.assign(SOURCES, {
        [sourceSlug]: {
          ...source,
          // SAFETY: the generated UUID is the bron row inserted by this test.
          bronId: bronId as typeof source.bronId,
          naam: sourceSlug,
          slug: sourceSlug,
        } as typeof source,
      });
      sourceWasAdded = true;

      await database.insert(bron).values({
        actief: true,
        categorie: "test",
        id: bronId,
        naam: sourceSlug,
        status: "ready",
        voorwaardenStatus: "toegestaan",
      });
      await database.insert(bronHealth).values({
        bronId,
        lastFullySuccessfulAt: baseline,
      });

      runtimeHealth = await createPollerRuntimeHealth({
        advisoryLockMaxAgeMs: 120_000,
        curationBudgetMs: 120_000,
        databaseUrl: testDatabaseUrl,
        heartbeatAt: baseline,
        heartbeatMaxAgeMs: 120_000,
        instanceId: `abort-finalization-${bronId}`,
        lastLockCheckAt: baseline,
        releaseSha: "a".repeat(40),
        runBudgetMs: 60_000,
        startedAt: baseline,
        telemetryClientOptions: { operationTimeoutMs: 2000 },
      });

      const pollBronRunModule = await import("../poll-bron-run");
      runtime = pollBronRunModule.createPollBronRuntime(testDatabaseUrl);
      runtime.loadBaseline = () => Promise.resolve([]);
      runtime.createConnector = () => ({
        // SAFETY: the generated UUID is the bron row inserted by this test.
        bronId: bronId as typeof source.bronId,
        discover: (_checkpoint, signal) => {
          signal?.throwIfAborted();
          return Promise.resolve({ checkpoint: {}, hasMore: false, items: [] });
        },
        fetch: () => Promise.resolve(null),
        fetchUsesNetwork: false,
      });
    });

    afterAll(async () => {
      const cleanupErrors: unknown[] = [];
      const cleanup = async (operation: Promise<unknown>): Promise<void> => {
        try {
          await operation;
        } catch (error) {
          cleanupErrors.push(error);
        }
      };

      await cleanup(runtime?.close() ?? Promise.resolve());
      await cleanup(runtimeHealth?.close() ?? Promise.resolve());
      if (runtimeHealth) {
        await cleanup(
          database
            ?.delete(pollerRuntime)
            .where(eq(pollerRuntime.ownerToken, runtimeHealth.ownerToken)) ??
            Promise.resolve()
        );
      }
      await cleanup(
        database
          ?.delete(scrapeRun)
          .where(inArray(scrapeRun.id, [firstRunId, successorRunId])) ??
          Promise.resolve()
      );
      await cleanup(
        database?.delete(bronHealth).where(eq(bronHealth.bronId, bronId)) ??
          Promise.resolve()
      );
      await cleanup(
        database?.delete(bron).where(eq(bron.id, bronId)) ?? Promise.resolve()
      );
      await cleanup(sqlClient?.end({ timeout: 5 }) ?? Promise.resolve());
      if (sourceWasAdded) {
        Reflect.deleteProperty(SOURCES, sourceSlug);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          cleanupErrors,
          "abort integration cleanup failed"
        );
      }
    });

    it("clears aborted ownership and rejects the old finalizer after successor takeover", async () => {
      const { runBronIngestPipeline } = await import("../poll-bron-run");
      const health = createSourceHealthCallbacks(
        runtimeHealth.layer,
        () => baseline
      );
      const controller = new AbortController();
      const abortReason = new Error("abort during curation");
      let abortedRun:
        | Parameters<NonNullable<typeof health.callbacks.onAborted>>[0]
        | undefined;

      const previousProjector = process.env.SEARCH_PROJECTOR;
      process.env.SEARCH_PROJECTOR = "onbox";
      try {
        const onCurationStarted = async (
          run: Parameters<
            NonNullable<typeof health.callbacks.onCurationStarted>
          >[0]
        ) => {
          abortedRun = run;
          await health.callbacks.onCurationStarted?.(run);
          controller.abort(abortReason);
        };
        const { onAborted } = health.callbacks;
        if (!onAborted) {
          throw new Error("source health abort callback is required");
        }

        await expect(
          runBronIngestPipeline(
            // SAFETY: sourceSlug is the test-only registry key installed above.
            {
              bronId,
              bronSlug: sourceSlug,
              scrapeRunId: firstRunId,
            } as Parameters<typeof runBronIngestPipeline>[0],
            runtime,
            "poll",
            {
              onAborted,
              onCurationStarted,
              signal: controller.signal,
            }
          )
        ).rejects.toBe(abortReason);

        const [afterAbort] = await database
          .select({
            activeRunId: bronHealth.activeRunId,
            lastCompletionOutcome: bronHealth.lastCompletionOutcome,
            lastFullySuccessfulAt: bronHealth.lastFullySuccessfulAt,
          })
          .from(bronHealth)
          .where(eq(bronHealth.bronId, bronId));
        expect(afterAbort).toMatchObject({
          activeRunId: null,
          lastCompletionOutcome: "incomplete",
          lastFullySuccessfulAt: baseline,
        });

        await database.insert(scrapeRun).values({
          bronId,
          fenceToken: 2,
          id: successorRunId,
          runKind: "poll",
          status: "running",
        });
        const telemetry = new PostgresPollerHealthTelemetryStore(database);
        expect(
          await telemetry.claimSourceOwnership({
            bronId,
            fenceToken: 2,
            phase: "fetch",
            phaseStartedAt: new Date("2026-09-19T12:00:02.000Z"),
            runId: successorRunId,
          })
        ).toBe(true);

        if (!abortedRun) {
          throw new Error("pipeline did not reach curation");
        }
        await expect(onAborted(abortedRun)).rejects.toBeInstanceOf(
          RunOwnershipLostError
        );

        const [afterSuccessor] = await database
          .select({
            activeRunId: bronHealth.activeRunId,
            lastCompletionOutcome: bronHealth.lastCompletionOutcome,
            lastFullySuccessfulAt: bronHealth.lastFullySuccessfulAt,
          })
          .from(bronHealth)
          .where(eq(bronHealth.bronId, bronId));
        expect(afterSuccessor).toMatchObject({
          activeRunId: successorRunId,
          lastCompletionOutcome: "incomplete",
          lastFullySuccessfulAt: baseline,
        });
      } finally {
        if (previousProjector === undefined) {
          delete process.env.SEARCH_PROJECTOR;
        } else {
          process.env.SEARCH_PROJECTOR = previousProjector;
        }
      }
    });
  });
