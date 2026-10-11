import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { SOURCES } from "@ji/application/sources";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { buildSliceABronSeedValues } from "./smoke-seed";

const migratorUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
const databaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;
const migrationsFolder = path.join(
  import.meta.dir,
  "../../../packages/db/src/migrations"
);
const applyScript = path.join(
  import.meta.dir,
  "../../../tools/postgres/bron-ids/02-apply-seed-rows.sql"
);

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

const ignoreNotice = (): void => undefined;

/** The operator script without its own BEGIN/COMMIT, so the test transaction can roll it back. */
const withoutTransactionControl = (script: string): string =>
  script
    .split("\n")
    .filter((line) => !/^(?:BEGIN|COMMIT|ROLLBACK);$/u.test(line.trim()))
    .join("\n");

interface SeededRow {
  readonly actief: boolean;
  readonly categorie: string;
  readonly crawl_delay_ms: number;
  readonly id: string;
  readonly ingestie_type: string;
  readonly interval: string;
  readonly login_vereist: boolean;
  readonly mapping_ref: string | null;
  readonly naam: string;
  readonly rate_limit_per_minute: number;
  readonly retention_days: number;
  readonly secret_ref: string | null;
  readonly status: string;
  readonly voorwaarden_status: string;
}

describe
  .skipIf(!postgresAvailable)
  .serial(
    "Stedin/Gasunie bron-id operator seed (tools/postgres/bron-ids)",
    () => {
      let client: ReturnType<typeof postgres>;

      beforeAll(async () => {
        client = postgres(migratorUrl, { max: 1, onnotice: ignoreNotice });
        await migrate(drizzle(client), { migrationsFolder });
      });

      afterAll(async () => {
        await client.end({ timeout: 5 });
      });

      it("writes exactly the registry seed values on the new ids, and is idempotent", async () => {
        const script = withoutTransactionControl(
          await readFile(applyScript, "utf-8")
        );
        const tx = await client.reserve();
        let rows: readonly SeededRow[] = [];
        try {
          await tx`BEGIN`;
          await tx.unsafe(script);
          await tx.unsafe(script);
          rows = await tx<SeededRow[]>`
          SELECT id, naam, actief, categorie, crawl_delay_ms, ingestie_type, interval, login_vereist,
                 mapping_ref, rate_limit_per_minute, retention_days, secret_ref, status, voorwaarden_status
            FROM curated.bron
           WHERE id IN (${SOURCES.stedin.bronId}, ${SOURCES.gasunie.bronId})
           ORDER BY id`;
        } finally {
          await tx`ROLLBACK`;
          tx.release();
        }

        const expected = [SOURCES.stedin, SOURCES.gasunie].map((source) => {
          const seed = buildSliceABronSeedValues(source);
          return {
            actief: seed.actief,
            categorie: seed.categorie,
            crawl_delay_ms: seed.crawlDelayMs,
            id: seed.id,
            ingestie_type: seed.ingestieType,
            interval: seed.interval,
            login_vereist: seed.loginVereist,
            mapping_ref: seed.mappingRef,
            naam: seed.naam,
            rate_limit_per_minute: seed.rateLimitPerMinute,
            retention_days: seed.retentionDays,
            secret_ref: seed.secretRef,
            status: seed.status,
            voorwaarden_status: seed.voorwaardenStatus,
          };
        });
        expect([...rows]).toEqual(expected);
      });

      it("aborts without writing when another bron already holds a new id", async () => {
        const script = withoutTransactionControl(
          await readFile(applyScript, "utf-8")
        );
        const tx = await client.reserve();
        let outcome = "applied";
        try {
          await tx`BEGIN`;
          await tx`INSERT INTO curated.bron (id, naam, categorie, ingestie_type, interval, rate_limit_per_minute, retention_days, status, voorwaarden_status)
                 VALUES (${SOURCES.stedin.bronId}, ${`Other ${crypto.randomUUID()}`}, 'jobboard', 'html', 'manual', 1, 90, 'deferred', 'toegestaan')
                 ON CONFLICT (id) DO UPDATE SET naam = excluded.naam`;
          await tx`SAVEPOINT apply_probe`;
          try {
            await tx.unsafe(script);
          } catch (error) {
            outcome = String(error);
            await tx`ROLLBACK TO SAVEPOINT apply_probe`;
          }
        } finally {
          await tx`ROLLBACK`;
          tx.release();
        }
        expect(outcome).toContain("bron id/naam collision for Stedin/Gasunie");
      });
    }
  );
