import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

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
const rollbackScript = path.join(import.meta.dir, "91-rollback-unmark.sql");
const psqlBinary = Bun.which("psql");
const REASON = "dup-key-normalized-v1";

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
if (postgresAvailable && psqlBinary === null) {
  console.warn(
    "rollback-unmark.spec: psql not on PATH, operator script tests skipped"
  );
}

const ignoreNotice = (): void => undefined;

interface PsqlRun {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

const runRollback = (): PsqlRun => {
  const result = Bun.spawnSync({
    cmd: [
      psqlBinary ?? "psql",
      migratorUrl,
      "-X",
      "-A",
      "-t",
      "-F",
      "|",
      "-v",
      "ON_ERROR_STOP=1",
      "-f",
      rollbackScript,
    ],
  });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
};

/** The psql -A -t output lines, so a counts row like "2|2|2" is matched exactly. */
const outputLines = (stdout: string): string[] =>
  stdout.split("\n").map((line) => line.trim());

/**
 * Rollback section B of the unique-key plan (91-rollback-unmark.sql): restored_at is stamped
 * only on the archive rows of rows the run actually unmarked, and each unmarked row is
 * re-projected exactly once.
 */
describe
  .skipIf(!postgresAvailable || psqlBinary === null)
  .serial(
    "unique-key rollback section B (tools/postgres/unique-key/91-rollback-unmark.sql)",
    () => {
      let client: ReturnType<typeof postgres>;
      const bronId = crypto.randomUUID();
      const ids = new Map<string, string>();

      const insertRow = async (
        runId: string,
        referentie: string
      ): Promise<string> => {
        const [inserted] = await client<{ id: string }[]>`
        INSERT INTO curated.aanvraag
          (bron_id, bron_referentie, bron_url, titel, beschrijving, content_hash, extractie_methode,
           raw_payload_ref, scrape_run_id, eerste_gezien_op, laatst_gezien_op)
        VALUES (${bronId}, ${referentie}, ${`https://example.test/${referentie}`}, 'Fixture', 'Fixture',
                ${crypto.randomUUID()}, 'json-ld', 'raw/fixture', ${runId},
                '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z')
        RETURNING id`;
        return inserted?.id ?? "";
      };

      const archive = async (
        aanvraagId: string,
        keptId: string,
        referentie: string
      ): Promise<void> => {
        await client`
        INSERT INTO curated.aanvraag_dup_archive
          (aanvraag_id, kept_aanvraag_id, bron_id, bron_referentie, normalized_referentie, reason, row_snapshot)
        VALUES (${aanvraagId}, ${keptId}, ${bronId}, ${referentie}, ${referentie.toLowerCase()}, ${REASON},
                '{}'::jsonb)`;
      };

      const markSuperseded = async (
        aanvraagId: string,
        keptId: string,
        reason: string
      ): Promise<void> => {
        await client`
        UPDATE curated.aanvraag
           SET superseded_by = ${keptId}, superseded_at = now(), superseded_reason = ${reason}
         WHERE id = ${aanvraagId}`;
      };

      /** restored_at IS NOT NULL per fixture archive row, keyed by fixture name. */
      const restoredByName = async (): Promise<Record<string, boolean>> => {
        const rows = await client<{ aanvraag_id: string; restored: boolean }[]>`
        SELECT aanvraag_id, restored_at IS NOT NULL AS restored
          FROM curated.aanvraag_dup_archive WHERE bron_id = ${bronId}`;
        const byId = new Map(
          rows.map((row) => [row.aanvraag_id, row.restored])
        );
        return Object.fromEntries(
          [...ids].map(([name, id]) => [name, byId.get(id) ?? false])
        );
      };

      const gewijzigdIds = async (): Promise<string[]> => {
        const rows = await client<{ aggregate_id: string }[]>`
        SELECT o.aggregate_id FROM curated.outbox_event o
          JOIN curated.aanvraag a ON a.id = o.aggregate_id
         WHERE a.bron_id = ${bronId} AND o.event_type = 'aanvraag.gewijzigd'
         ORDER BY o.aggregate_id`;
        return rows.map((row) => row.aggregate_id);
      };

      beforeAll(async () => {
        client = postgres(migratorUrl, { max: 1, onnotice: ignoreNotice });
        await migrate(drizzle(client), { migrationsFolder });
        await client`INSERT INTO curated.bron (id, naam, categorie, actief, status, voorwaarden_status)
                   VALUES (${bronId}, ${`Unique-key rollback ${bronId}`}, 'jobboard', false, 'deferred', 'te_toetsen')`;
        const [run] = await client<{ id: string }[]>`
        INSERT INTO curated.scrape_run (bron_id) VALUES (${bronId}) RETURNING id`;
        const runId = run?.id ?? "";
        // Distinct referenties keep the 0034 live unique index satisfied once rows are unmarked;
        // the script itself only looks at the archive reason tag.
        for (const name of [
          "kept",
          "loser1",
          "loser2",
          "alreadyLive",
          "otherReason",
        ]) {
          // oxlint-disable-next-line no-await-in-loop -- tiny fixture, order keeps ids readable
          ids.set(name, await insertRow(runId, `${name}-${bronId}`));
        }
        const kept = ids.get("kept") ?? "";
        for (const name of ["loser1", "loser2", "alreadyLive", "otherReason"]) {
          // oxlint-disable-next-line no-await-in-loop -- tiny fixture
          await archive(ids.get(name) ?? "", kept, `${name}-${bronId}`);
        }
        await markSuperseded(ids.get("loser1") ?? "", kept, REASON);
        await markSuperseded(ids.get("loser2") ?? "", kept, REASON);
        // alreadyLive: archived but no longer marked (unmarked by hand earlier).
        // otherReason: archived under this tag but now superseded for another reason.
        await markSuperseded(ids.get("otherReason") ?? "", kept, "dup-url-v1");
      });

      afterAll(async () => {
        await client?.end({ timeout: 1 });
      });

      it("unmarks only the rows it marked, stamps restored_at only for those, and re-projects each once", async () => {
        const losers = [
          ids.get("loser1") ?? "",
          ids.get("loser2") ?? "",
        ].toSorted();
        const first = runRollback();
        expect(first.exitCode).toBe(0);
        // unmarked | archive_rows_restored | index_upserts_enqueued
        expect(outputLines(first.stdout)).toContain("2|2|2");
        expect(await gewijzigdIds()).toEqual(losers);
        expect(await restoredByName()).toEqual({
          alreadyLive: false,
          kept: false,
          loser1: true,
          loser2: true,
          otherReason: false,
        });
        const [other] = await client<{ superseded_reason: string | null }[]>`
        SELECT superseded_reason FROM curated.aanvraag WHERE id = ${ids.get("otherReason") ?? ""}`;
        expect(other?.superseded_reason).toBe("dup-url-v1");
      });

      it("is idempotent: a second run unmarks nothing, stamps nothing and queues nothing", async () => {
        const losers = [
          ids.get("loser1") ?? "",
          ids.get("loser2") ?? "",
        ].toSorted();
        const second = runRollback();
        expect(second.exitCode).toBe(0);
        expect(outputLines(second.stdout)).toContain("0|0|0");
        expect(await gewijzigdIds()).toEqual(losers);
        const restored = await restoredByName();
        expect(restored.alreadyLive).toBe(false);
      });
    }
  );
