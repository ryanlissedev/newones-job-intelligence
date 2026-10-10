import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { BronId, ScrapeRunId } from "@ji/domain";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { PostgresCurateStore } from "./postgres-curate-store";
import * as schema from "./schema";
import { aanvraag, bron, scrapeRun } from "./schema";

const migratorUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
const databaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;
const migrationsFolder = path.join(import.meta.dir, "migrations");
const scriptsFolder = path.join(
  import.meta.dir,
  "../../../tools/postgres/unique-key"
);
const LIVE_INDEX = "aanvraag_bron_referentie_live_uidx";
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

const readScript = (name: string): Promise<string> =>
  readFile(path.join(scriptsFolder, name), "utf-8");

/** The operator script without its own BEGIN/COMMIT, so a test transaction can roll it back. */
const withoutTransactionControl = (script: string): string =>
  script
    .split("\n")
    .filter((line) => !/^(?:BEGIN|COMMIT|ROLLBACK);$/u.test(line.trim()))
    .join("\n");

/** Splits a script into statements the way psql autocommit runs them (no DO bodies with ';'). */
const autocommitStatements = (script: string): string[] => {
  const withoutComments = script
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  const doStart = withoutComments.indexOf("DO $$");
  const head =
    doStart === -1 ? withoutComments : withoutComments.slice(0, doStart);
  const tail = doStart === -1 ? [] : [withoutComments.slice(doStart).trim()];
  return [
    ...head
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0),
    ...tail,
  ];
};

const NOW = new Date("2026-10-10T08:00:00.000Z");
const HOUR = 3_600_000;
const ignoreNotice = (): void => undefined;

/** What the rolled-back mark transaction observed. */
interface MarkOutcome {
  readonly archive: readonly {
    aanvraag_id: string;
    kept_aanvraag_id: string;
    snapshot_ref: string;
  }[];
  readonly archiveAfterRerun: number;
  readonly before: number;
  readonly marked: readonly {
    id: string;
    superseded_by: string | null;
    superseded_reason: string | null;
  }[];
  readonly rejected: string;
}

interface FixtureRow {
  readonly id: string;
  readonly ref: string;
  readonly v1Id: string | null;
  readonly lastSeen: Date;
}

describe
  .skipIf(!postgresAvailable)
  .serial("aanvraag unique live key (migrations 0033/0034)", () => {
    let client: ReturnType<typeof postgres>;
    let database: ReturnType<typeof drizzle<typeof schema>>;
    const bronId: BronId = crypto.randomUUID();
    const runId: ScrapeRunId = crypto.randomUUID();
    const createdAanvraagIds: string[] = [];

    const fixtureValues = (row: FixtureRow) => ({
      beschrijving: "beschrijving",
      bronId,
      bronReferentie: row.ref,
      contentHash: `hash-${row.id}`,
      eersteGezienOp: new Date(NOW.getTime() - 48 * HOUR),
      extractieMethode: "html_parser",
      id: row.id,
      laatstGezienOp: row.lastSeen,
      rawPayloadRef: `raw/${row.id}.html`,
      scrapeRunId: runId,
      status: "active",
      titel: "titel",
      v1Id: row.v1Id,
    });

    beforeAll(async () => {
      client = postgres(migratorUrl, { max: 1, onnotice: ignoreNotice });
      await migrate(drizzle(client), { migrationsFolder });
      database = drizzle(client, { schema });
      await database.insert(bron).values({
        actief: false,
        categorie: "msp_broker",
        id: bronId,
        naam: `UniqueKey ${bronId}`,
        status: "ready",
        voorwaardenStatus: "toegestaan",
      });
      await database.insert(scrapeRun).values({ bronId, id: runId });
    });

    afterAll(async () => {
      if (createdAanvraagIds.length > 0) {
        await database
          .delete(aanvraag)
          .where(inArray(aanvraag.id, createdAanvraagIds));
      }
      await client`DELETE FROM curated.scrape_run WHERE id = ${runId}`;
      await client`DELETE FROM curated.bron WHERE id = ${bronId}`;
      await client.end({ timeout: 5 });
    });

    it("adds only nullable columns, the archive table and a valid partial unique index", async () => {
      const columns = await client<
        {
          column_name: string;
          is_nullable: string;
          column_default: string | null;
        }[]
      >`
        SELECT column_name, is_nullable, column_default
          FROM information_schema.columns
         WHERE table_schema = 'curated' AND table_name = 'aanvraag'
           AND column_name LIKE 'superseded_%'
         ORDER BY column_name`;
      expect([...columns]).toEqual([
        {
          column_default: null,
          column_name: "superseded_at",
          is_nullable: "YES",
        },
        {
          column_default: null,
          column_name: "superseded_by",
          is_nullable: "YES",
        },
        {
          column_default: null,
          column_name: "superseded_reason",
          is_nullable: "YES",
        },
      ]);
      const [index] = await client<
        { valid: boolean; unique: boolean; def: string }[]
      >`
        SELECT x.indisvalid AS valid, x.indisunique AS unique, pg_get_indexdef(x.indexrelid) AS def
          FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
         WHERE i.relname = ${LIVE_INDEX}`;
      expect(index?.valid).toBe(true);
      expect(index?.unique).toBe(true);
      expect(index?.def).toContain("lower(btrim(bron_referentie))");
      expect(index?.def).toContain("WHERE (superseded_by IS NULL)");
      const [archive] = await client<{ owner: string; me: string }[]>`
        SELECT tableowner AS owner, current_user::text AS me
          FROM pg_tables WHERE schemaname = 'curated' AND tablename = 'aanvraag_dup_archive'`;
      expect(archive?.owner).toBe(archive?.me ?? "");
    });

    it("marks (never deletes) normalized duplicates with the keep rule, archives them, then lets the index build", async () => {
      const keepLive = crypto.randomUUID();
      const olderLive = crypto.randomUUID();
      const v1Row = crypto.randomUUID();
      const tieLive = crypto.randomUUID();
      const tieV1 = crypto.randomUUID();
      const loner = crypto.randomUUID();
      const rows: FixtureRow[] = [
        { id: keepLive, lastSeen: NOW, ref: "job-1", v1Id: null },
        {
          id: olderLive,
          lastSeen: new Date(NOW.getTime() - HOUR),
          ref: "JOB-1",
          v1Id: null,
        },
        {
          id: v1Row,
          lastSeen: new Date(NOW.getTime() - 2 * HOUR),
          ref: " job-1 ",
          v1Id: `v1-${v1Row}`,
        },
        { id: tieLive, lastSeen: NOW, ref: "Job-2", v1Id: null },
        { id: tieV1, lastSeen: NOW, ref: "job-2", v1Id: `v1-${tieV1}` },
        { id: loner, lastSeen: NOW, ref: "job-3", v1Id: null },
      ];
      const markScript = withoutTransactionControl(
        await readScript("03-mark-superseded.sql")
      );
      const migration0034 = await readFile(
        path.join(migrationsFolder, "0034_aanvraag_live_key_uidx.sql"),
        "utf-8"
      );
      const createIndex = migration0034
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n");

      // One reserved connection, explicit BEGIN/ROLLBACK: the transactional DROP INDEX,
      // the fixtures and the marks all disappear afterwards.
      const tx = await client.reserve();
      let result: MarkOutcome;
      try {
        await tx`BEGIN`;
        await tx.unsafe(`DROP INDEX curated.${LIVE_INDEX}`);
        for (const row of rows) {
          // oxlint-disable-next-line no-await-in-loop -- fixture setup, one row each
          await tx`INSERT INTO curated.aanvraag ${tx({
            beschrijving: "beschrijving",
            bron_id: bronId,
            bron_referentie: row.ref,
            content_hash: `hash-${row.id}`,
            eerste_gezien_op: new Date(NOW.getTime() - 48 * HOUR).toISOString(),
            extractie_methode: "html_parser",
            id: row.id,
            laatst_gezien_op: row.lastSeen.toISOString(),
            raw_payload_ref: `raw/${row.id}.html`,
            scrape_run_id: runId,
            status: "active",
            titel: "titel",
            v1_id: row.v1Id,
          })}`;
        }
        const beforeRows = await tx<{ before: number }[]>`
          SELECT count(*)::int AS before FROM curated.aanvraag WHERE bron_id = ${bronId}`;
        await tx.unsafe(markScript);
        const marked = await tx<
          {
            id: string;
            superseded_by: string | null;
            superseded_reason: string | null;
          }[]
        >`SELECT id, superseded_by, superseded_reason FROM curated.aanvraag
           WHERE bron_id = ${bronId} ORDER BY id`;
        const archive = await tx<
          {
            aanvraag_id: string;
            kept_aanvraag_id: string;
            snapshot_ref: string;
          }[]
        >`SELECT aanvraag_id, kept_aanvraag_id, row_snapshot->>'bron_referentie' AS snapshot_ref
            FROM curated.aanvraag_dup_archive WHERE bron_id = ${bronId} ORDER BY aanvraag_id`;
        // Idempotent: a second run marks nothing new.
        await tx.unsafe(markScript);
        const rerunRows = await tx<{ archived: number }[]>`
          SELECT count(*)::int AS archived FROM curated.aanvraag_dup_archive WHERE bron_id = ${bronId}`;
        await tx.unsafe(createIndex);
        await tx`SAVEPOINT live_key_probe`;
        let rejected = "inserted";
        try {
          await tx`INSERT INTO curated.aanvraag ${tx({
            beschrijving: "beschrijving",
            bron_id: bronId,
            bron_referentie: "JOB-3 ",
            content_hash: "hash-new",
            eerste_gezien_op: NOW.toISOString(),
            extractie_methode: "html_parser",
            laatst_gezien_op: NOW.toISOString(),
            raw_payload_ref: "raw/new.html",
            scrape_run_id: runId,
            titel: "titel",
          })}`;
        } catch (error) {
          rejected = String(error);
          await tx`ROLLBACK TO SAVEPOINT live_key_probe`;
        }
        result = {
          archive,
          archiveAfterRerun: rerunRows[0]?.archived ?? -1,
          before: beforeRows[0]?.before ?? -1,
          marked,
          rejected,
        };
      } finally {
        await tx`ROLLBACK`;
        tx.release();
      }

      expect(result.before).toBe(rows.length);
      expect(result.marked).toHaveLength(rows.length);
      const supersededBy = new Map(
        result.marked.map((row) => [row.id, row.superseded_by])
      );
      expect(supersededBy.get(keepLive)).toBeNull();
      expect(supersededBy.get(olderLive)).toBe(keepLive);
      expect(supersededBy.get(v1Row)).toBe(keepLive);
      // Same laatst_gezien_op: the live row wins over the v1 backfill row.
      expect(supersededBy.get(tieLive)).toBeNull();
      expect(supersededBy.get(tieV1)).toBe(tieLive);
      expect(supersededBy.get(loner)).toBeNull();
      expect(
        result.marked
          .filter((row) => row.superseded_by !== null)
          .every((row) => row.superseded_reason === REASON)
      ).toBe(true);
      expect(result.archive.map((row) => row.aanvraag_id).toSorted()).toEqual(
        [olderLive, v1Row, tieV1].toSorted()
      );
      expect(
        result.archive.find((row) => row.aanvraag_id === v1Row)?.snapshot_ref
      ).toBe(" job-1 ");
      expect(result.archiveAfterRerun).toBe(3);
      expect(result.rejected).toContain(LIVE_INDEX);

      const [{ count } = { count: -1 }] = await client<{ count: number }[]>`
        SELECT count(*)::int AS count FROM curated.aanvraag WHERE bron_id = ${bronId}`;
      expect(count).toBe(0);
    });

    it("keeps the dry-run plan read-only", async () => {
      const statements = autocommitStatements(
        await readScript("02-plan-dry-run.sql")
      );
      expect(statements[0]).toBe("BEGIN READ ONLY");
      expect(statements.at(-1)).toBe("ROLLBACK");
      for (const statement of statements) {
        // oxlint-disable-next-line no-await-in-loop -- psql runs them in order
        await client.unsafe(statement);
      }
    });

    it("keeps the prepare and CONCURRENTLY scripts runnable as no-ops once 0033/0034 are applied", async () => {
      for (const name of [
        "01-prepare.sql",
        "04-unique-index-concurrently.sql",
      ]) {
        // oxlint-disable-next-line no-await-in-loop -- one script after the other
        const statements = autocommitStatements(await readScript(name));
        for (const statement of statements) {
          // oxlint-disable-next-line no-await-in-loop -- psql autocommit order
          await client.unsafe(statement);
        }
      }
      await client`RESET lock_timeout`;
      await client`RESET statement_timeout`;
    });

    it("resolves casing/whitespace variants and superseded rows to the kept aanvraag", async () => {
      const keep = crypto.randomUUID();
      const superseded = crypto.randomUUID();
      createdAanvraagIds.push(keep, superseded);
      await database
        .insert(aanvraag)
        .values(
          fixtureValues({ id: keep, lastSeen: NOW, ref: "ref-a", v1Id: null })
        );
      await database.insert(aanvraag).values({
        ...fixtureValues({
          id: superseded,
          lastSeen: NOW,
          ref: "REF-A ",
          v1Id: null,
        }),
        supersededAt: NOW,
        supersededBy: keep,
        supersededReason: REASON,
      });
      const store = new PostgresCurateStore(database);

      for (const variant of ["ref-a", "REF-A ", " Ref-A"]) {
        // oxlint-disable-next-line no-await-in-loop -- one lookup per variant
        const found = await store.findAanvraagByIdentity(bronId, variant);
        expect(found?.aanvraagId).toBe(keep);
      }
      expect(await store.findAanvraagByIdentity(bronId, "ref-b")).toBeNull();

      const updated = await store.updateAanvraag(keep, {
        bronReferentie: "REF-A ",
      });
      expect(updated.bronReferentie).toBe("ref-a");
    });
  });
