import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";

import { executeBronRun } from "@ji/application/bronnen";
import { InMemoryObjectStore } from "@ji/connectors";
import type { Connector, ObservationRecordInput } from "@ji/connectors";
import type { BronId, ScrapeRunId } from "@ji/domain";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import {
  PostgresBronPersistence,
  PostgresObservationRecorder,
  PostgresRunStore,
} from "./bron-runtime";
import { PostgresResumeOrderLookup } from "./resume-order-store";
import * as schema from "./schema";
import { bron, sourceRecord } from "./schema";

const migratorUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
const applicationUrl =
  process.env.DATABASE_APP_TEST_URL ??
  "postgresql://ji_app:ji_app_local@127.0.0.1:5432/ji_test";
const databaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;
const migrationsFolder = path.join(import.meta.dir, "migrations");

const isPostgresAvailable = async (): Promise<boolean> => {
  const probe = postgres(migratorUrl, { connect_timeout: 2, max: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
    return true;
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return false;
  }
};

const postgresAvailable = await isPostgresAvailable();
if (!postgresAvailable && databaseRequired) {
  throw new Error("Required test database is unavailable");
}

const hexDigest = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

const PAGE = ["J1", "J2", "J3", "J4", "J5", "J6"];

describe
  .skipIf(!postgresAvailable)
  .serial(
    "resumable fetch order on staging.source_record (migration 0032)",
    () => {
      let migratorClient: ReturnType<typeof postgres>;
      let client: ReturnType<typeof postgres>;
      let database: ReturnType<typeof drizzle<typeof schema>>;
      // SAFETY: BronId is a nominal UUID string brand; randomUUID yields a valid value.
      const bronId = crypto.randomUUID() as BronId;

      beforeAll(async () => {
        migratorClient = postgres(migratorUrl, { max: 1 });
        await migrate(drizzle(migratorClient, { schema }), {
          migrationsFolder,
        });
        client = postgres(applicationUrl, { max: 2 });
        database = drizzle(client, { schema });
        await database.insert(bron).values({
          actief: true,
          categorie: "werving",
          crawlDelayMs: 0,
          id: bronId,
          ingestieType: "html",
          interval: "*/15 * * * *",
          naam: `Resume ${bronId}`,
          rateLimitPerMinute: 600,
          retentionDays: 30,
          status: "ready",
          voorwaardenStatus: "toegestaan",
        });
      });

      afterAll(async () => {
        await database?.delete(bron).where(eq(bron.id, bronId));
        await client?.end({ timeout: 5 });
        await migratorClient?.end({ timeout: 5 });
      });

      const connectorLogging = (fetched: string[]): Connector => ({
        bronId,
        discover: () =>
          Promise.resolve({
            checkpoint: {},
            hasMore: false,
            items: PAGE.map((ref) => ({
              bronReferentie: ref,
              contentHash: "",
            })),
          }),
        fetch: (item) => {
          fetched.push(item.bronReferentie);
          return Promise.resolve({
            body: new TextEncoder().encode(item.bronReferentie),
            bronReferentie: item.bronReferentie,
            contentHash: hexDigest(item.bronReferentie),
            contentType: "html" as const,
            status: "fetched" as const,
          });
        },
      });

      /** One poll run; the budget "elapses" after `budget` persisted items. */
      const pollRun = async (budget: number | null): Promise<string[]> => {
        const fetched: string[] = [];
        const controller = new AbortController();
        const recorder = new PostgresObservationRecorder(database);
        const record = recorder.record.bind(recorder);
        let persisted = 0;
        recorder.record = async (input: ObservationRecordInput) => {
          const result = await record(input);
          persisted += 1;
          if (budget !== null && persisted >= budget) {
            controller.abort();
          }
          return result;
        };
        await executeBronRun(new PostgresBronPersistence(database), {
          bronId,
          bronSlug: "resume",
          connector: connectorLogging(fetched),
          objectStore: new InMemoryObjectStore(),
          observationRecorder: recorder,
          resumeOrder: new PostgresResumeOrderLookup(database),
          runLifecycleStore: new PostgresRunStore(database),
          // SAFETY: ScrapeRunId is a nominal UUID string brand.
          scrapeRunId: crypto.randomUUID() as ScrapeRunId,
          signal: controller.signal,
          wait: () => Promise.resolve(),
        });
        return fetched;
      };

      const lastFetchedAt = async (ref: string) => {
        const [row] = await database
          .select({ lastFetchedAt: sourceRecord.lastFetchedAt })
          .from(sourceRecord)
          .where(
            and(
              eq(sourceRecord.bronId, bronId),
              eq(sourceRecord.bronReferentie, ref)
            )
          );
        return row?.lastFetchedAt;
      };

      it("adds last_fetched_at as a nullable timestamptz without a default", async () => {
        const [column] = await migratorClient<
          {
            column_default: string | null;
            data_type: string;
            is_nullable: string;
          }[]
        >`SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'staging' AND table_name = 'source_record' AND column_name = 'last_fetched_at'`;
        expect(column).toEqual({
          column_default: null,
          data_type: "timestamp with time zone",
          is_nullable: "YES",
        });
      });

      it("a budget-cut run stamps what it fetched; the next run starts with what it never reached", async () => {
        expect(await pollRun(3)).toEqual(["J1", "J2", "J3"]);
        expect(await lastFetchedAt("J3")).toBeInstanceOf(Date);
        expect(await lastFetchedAt("J4")).toBeUndefined();

        expect(await pollRun(3)).toEqual(["J4", "J5", "J6"]);

        // A record from before 0032 (unknown fetch time) goes before every
        // record with a time; the rest follow oldest first.
        await database
          .update(sourceRecord)
          .set({ lastFetchedAt: null })
          .where(
            and(
              eq(sourceRecord.bronId, bronId),
              eq(sourceRecord.bronReferentie, "J5")
            )
          );
        expect(await pollRun(null)).toEqual([
          "J5",
          "J1",
          "J2",
          "J3",
          "J4",
          "J6",
        ]);
      });

      it("the lookup reads every chunk and leaves never-recorded references out", async () => {
        const lookup = new PostgresResumeOrderLookup(database);
        const many = [
          ...PAGE,
          ...Array.from({ length: 2500 }, (_, index) => `never-${index}`),
        ];
        const found = await lookup.lastFetchedAt(bronId, many);
        expect([...found.keys()].toSorted()).toEqual(PAGE);
        const [row] = await database
          .select({ count: sql<number>`count(*)::int` })
          .from(sourceRecord)
          .where(eq(sourceRecord.bronId, bronId));
        expect(row?.count).toBe(PAGE.length);
      });
    }
  );
