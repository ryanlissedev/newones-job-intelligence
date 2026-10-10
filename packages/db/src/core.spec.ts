import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { writeAanvraagVersion } from "./scd2";
import * as schema from "./schema";
import {
  aanvraag,
  aanvraagVersie,
  bron,
  scrapeRun,
  sourceRecord,
} from "./schema";

const defaultAppDatabaseUrl =
  "postgresql://ji_app:ji_app_local@127.0.0.1:5432/ji_test";

const testDatabaseUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
const appDatabaseUrl =
  process.env.DATABASE_APP_TEST_URL ?? defaultAppDatabaseUrl;
const testDatabaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;

const migrationsFolder = path.join(import.meta.dir, "migrations");

const requiredTables = [
  { name: "bron", schema: "curated" },
  { name: "scrape_run", schema: "curated" },
  { name: "search_projection_checkpoint", schema: "curated" },
  { name: "source_record", schema: "staging" },
  { name: "aanvraag_observation", schema: "staging" },
  { name: "aanvraag", schema: "curated" },
  { name: "aanvraag_versie", schema: "curated" },
  { name: "aanvraag_bron_link", schema: "curated" },
  { name: "dedup_groep", schema: "curated" },
  { name: "aanvraag_markering", schema: "curated" },
  { name: "saved_search", schema: "curated" },
  { name: "approval_record", schema: "curated" },
  { name: "query_snapshot", schema: "curated" },
  { name: "audit_event", schema: "curated" },
  { name: "outbox_event", schema: "curated" },
  { name: "agent_context", schema: "curated" },
  { name: "bron_health", schema: "curated" },
  { name: "alert", schema: "curated" },
];

const forbiddenTables = [
  { name: "contact", schema: "curated" },
  { name: "candidate", schema: "curated" },
  { name: "aanvraag_contact", schema: "curated" },
];

const requireRow = <Row>(row: Row | undefined, description: string): Row => {
  if (row === undefined) {
    throw new Error(`Expected ${description}`);
  }

  return row;
};

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

describe("core schema migrations", () => {
  let postgresAvailable = false;
  let sqlClient: ReturnType<typeof postgres> | undefined;
  let db: ReturnType<typeof drizzle<typeof schema>> | undefined;

  beforeAll(async () => {
    postgresAvailable = await isPostgresAvailable();
    if (!postgresAvailable) {
      if (testDatabaseRequired) {
        throw new Error("Required test database is unavailable");
      }
      return;
    }

    sqlClient = postgres(testDatabaseUrl, { max: 1 });
    db = drizzle(sqlClient, { schema });
    await migrate(db, { migrationsFolder });
  });

  afterAll(async () => {
    await sqlClient?.end({ timeout: 5 });
  });

  it("creates staging, curated, and marts schemas with required tables", async () => {
    if (!postgresAvailable || !db) {
      expect(postgresAvailable).toBe(false);
      return;
    }
    const database = db;

    const schemas = await db.execute<{ schema_name: string }>(sql`
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name IN ('staging', 'curated', 'marts')
      ORDER BY schema_name
    `);

    expect(schemas.map((row) => row.schema_name)).toEqual([
      "curated",
      "marts",
      "staging",
    ]);

    const tableChecks = requiredTables.map(async (entry) => {
      const rows = await database.execute<{ table_name: string }>(sql`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = ${entry.schema}
          AND table_name = ${entry.name}
      `);

      expect(rows).toHaveLength(1);
    });

    await Promise.all(tableChecks);

    const forbiddenChecks = forbiddenTables.map(async (entry) => {
      const rows = await database.execute<{ table_name: string }>(sql`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = ${entry.schema}
          AND table_name = ${entry.name}
      `);

      expect(rows).toHaveLength(0);
    });

    await Promise.all(forbiddenChecks);
  });

  it("keeps legacy observation migration fail-closed and history-aware", async () => {
    const migrationSql = await Bun.file(
      path.join(migrationsFolder, "0001_u3_durable_ingestion.sql")
    ).text();

    expect(migrationSql).not.toContain('source."content_hash"');
    expect(migrationSql).toContain(
      "Cannot migrate aanvraag observations without an immutable payload contentHash"
    );
    expect(migrationSql).toContain(
      "Cannot migrate duplicate aanvraag observation replay keys"
    );
    expect(migrationSql).toContain('LAG("content_hash") OVER');
  });

  it("keeps migration and runtime roles non-superuser and runtime read-only for DDL", async () => {
    if (!postgresAvailable || !sqlClient) {
      expect(postgresAvailable).toBe(false);
      return;
    }

    const appClient = postgres(appDatabaseUrl, { max: 1 });

    try {
      const migrationRoles = await sqlClient<
        [{ rolcreaterole: boolean; rolcreatedb: boolean; rolsuper: boolean }]
      >`
        SELECT rolcreaterole, rolcreatedb, rolsuper
        FROM pg_roles
        WHERE rolname = current_user
      `;
      const appRoles = await appClient<
        [
          {
            canCreateCurated: boolean;
            canReadMigrationJournal: boolean;
            rolcreaterole: boolean;
            rolcreatedb: boolean;
            rolsuper: boolean;
          },
        ]
      >`
        SELECT
          has_schema_privilege(current_user, 'curated', 'CREATE') AS "canCreateCurated",
          has_table_privilege(
            current_user,
            'drizzle.__drizzle_migrations',
            'SELECT'
          ) AS "canReadMigrationJournal",
          rolcreaterole,
          rolcreatedb,
          rolsuper
        FROM pg_roles
        WHERE rolname = current_user
      `;
      const migrationRole = requireRow(
        migrationRoles[0],
        "the active migration role"
      );
      const appRole = requireRow(appRoles[0], "the active application role");

      expect(migrationRole).toEqual({
        rolcreatedb: false,
        rolcreaterole: false,
        rolsuper: false,
      });
      expect(appRole).toEqual({
        canCreateCurated: false,
        canReadMigrationJournal: true,
        rolcreatedb: false,
        rolcreaterole: false,
        rolsuper: false,
      });
    } finally {
      await appClient.end({ timeout: 5 });
    }
  });

  it("allows the same content hash for distinct source references", async () => {
    if (!postgresAvailable || !db) {
      expect(postgresAvailable).toBe(false);
      return;
    }

    const bronRows = await db
      .insert(bron)
      .values({
        categorie: "overheidsportaal",
        naam: "TenderNed test",
        status: "ready",
        voorwaardenStatus: "toegestaan",
      })
      .returning({ id: bron.id });
    const bronRow = requireRow(bronRows[0], "the inserted source");

    const runRows = await db
      .insert(scrapeRun)
      .values({ bronId: bronRow.id })
      .returning({ id: scrapeRun.id });
    const runRow = requireRow(runRows[0], "the inserted scrape run");

    await db.insert(sourceRecord).values({
      bronId: bronRow.id,
      bronReferentie: "TN-1",
      contentHash: "hash-a",
      rawPayloadRef: "raw/tenderned/2026/08/28/run/tn-1.json",
      scrapeRunId: runRow.id,
    });

    const duplicateHashRows = await db
      .insert(sourceRecord)
      .values({
        bronId: bronRow.id,
        bronReferentie: "TN-2",
        contentHash: "hash-a",
        rawPayloadRef: "raw/tenderned/2026/08/28/run/tn-2.json",
        scrapeRunId: runRow.id,
      })
      .returning({ id: sourceRecord.id });
    expect(duplicateHashRows).toHaveLength(1);
  });

  it("rejects activation unless the bron is ready and allowed", async () => {
    if (!postgresAvailable || !db) {
      expect(postgresAvailable).toBe(false);
      return;
    }

    await expect(
      Promise.resolve(
        db.insert(bron).values({
          actief: true,
          categorie: "overheidsportaal",
          naam: "Unsafe active source",
          status: "deferred",
          voorwaardenStatus: "toegestaan",
        })
      )
    ).rejects.toThrow();
  });

  it("rejects plaintext secret references through direct DML", async () => {
    if (!postgresAvailable || !db) {
      expect(postgresAvailable).toBe(false);
      return;
    }

    const bronId = crypto.randomUUID();
    await expect(
      Promise.resolve(
        db.execute(sql`
          INSERT INTO curated.bron (
            id,
            categorie,
            naam,
            secret_ref
          ) VALUES (
            ${bronId},
            'overheidsportaal',
            'Unsafe plaintext secret source',
            'plaintext-secret'
          )
        `)
      )
    ).rejects.toThrow();

    const persisted = await db
      .select({ id: bron.id })
      .from(bron)
      .where(sql`${bron.id} = ${bronId}`);
    expect(persisted).toHaveLength(0);
  });

  it("rejects aanvraag insert without bron_id", async () => {
    if (!postgresAvailable || !db) {
      expect(postgresAvailable).toBe(false);
      return;
    }

    await expect(
      Promise.resolve(
        db.execute(sql`
          INSERT INTO curated.aanvraag (
            bron_referentie,
            content_hash,
            raw_payload_ref,
            scrape_run_id,
            titel,
            beschrijving,
            extractie_methode,
            eerste_gezien_op,
            laatst_gezien_op
          ) VALUES (
            'TN-999',
            'hash-direct',
            'raw/direct.json',
            gen_random_uuid(),
            'Platform engineer',
            'Beschrijving',
            'api',
            NOW(),
            NOW()
          )
        `)
      )
    ).rejects.toThrow();
  });

  it("writes SCD2 version, closes previous geldig_tot, and inserts outbox row", async () => {
    if (!postgresAvailable || !db) {
      expect(postgresAvailable).toBe(false);
      return;
    }

    const bronRows = await db
      .insert(bron)
      .values({
        categorie: "jobboard",
        naam: "Inhuurdesk test",
        status: "ready",
        voorwaardenStatus: "toegestaan",
      })
      .returning({ id: bron.id });
    const bronRow = requireRow(bronRows[0], "the inserted source");

    const runRows = await db
      .insert(scrapeRun)
      .values({ bronId: bronRow.id })
      .returning({ id: scrapeRun.id });
    const runRow = requireRow(runRows[0], "the inserted scrape run");

    const seenAt = new Date("2026-08-28T08:00:00.000Z");

    const aanvraagRows = await db
      .insert(aanvraag)
      .values({
        beschrijving: "Eerste beschrijving",
        bronId: bronRow.id,
        bronReferentie: "IH-1",
        contentHash: "hash-v1",
        eersteGezienOp: seenAt,
        extractieMethode: "api",
        laatstGezienOp: seenAt,
        rawPayloadRef: "raw/inhuurdesk/v1.json",
        scrapeRunId: runRow.id,
        tariefMax: "120.00",
        tariefMin: "90.00",
        tariefValuta: "EUR",
        titel: "Data engineer",
        versie: 1,
      })
      .returning({ id: aanvraag.id });
    const aanvraagRow = requireRow(aanvraagRows[0], "the inserted aanvraag");

    const firstVersies = await db
      .insert(aanvraagVersie)
      .values({
        aanvraagId: aanvraagRow.id,
        contentHash: "hash-v1",
        geldigVan: seenAt,
        rawPayloadRef: "raw/inhuurdesk/v1.json",
        scrapeRunId: runRow.id,
        snapshot: { tarief_max: "120.00", titel: "Data engineer" },
        versie: 1,
      })
      .returning({
        geldigTot: aanvraagVersie.geldigTot,
        id: aanvraagVersie.id,
      });
    const firstVersie = requireRow(
      firstVersies[0],
      "the initial aanvraag version"
    );

    expect(firstVersie.geldigTot).toBeNull();

    const result = await writeAanvraagVersion(db, {
      aanvraagId: aanvraagRow.id,
      contentHash: "hash-v2",
      eventType: "aanvraag.gewijzigd",
      outboxPayload: { tarief_max: "130.00" },
      rawPayloadRef: "raw/inhuurdesk/v2.json",
      scrapeRunId: runRow.id,
      snapshot: { tarief_max: "130.00", titel: "Data engineer" },
      versie: 2,
    });

    const closedFirst = await db.query.aanvraagVersie.findFirst({
      where: (table, { eq: equals }) => equals(table.id, firstVersie.id),
    });
    const openVersie = await db.query.aanvraagVersie.findFirst({
      where: (table, { and: combine, eq: equals, isNull: isNullValue }) =>
        combine(
          equals(table.aanvraagId, aanvraagRow.id),
          isNullValue(table.geldigTot)
        ),
    });
    const outboxRow = await db.query.outboxEvent.findFirst({
      where: (table, { eq: equals }) => equals(table.id, result.outboxEventId),
    });

    expect(closedFirst?.geldigTot).not.toBeNull();
    expect(openVersie?.versie).toBe(2);
    expect(openVersie?.contentHash).toBe("hash-v2");
    expect(outboxRow?.eventType).toBe("aanvraag.gewijzigd");
    expect(outboxRow?.aggregateId).toBe(aanvraagRow.id);
  });
});
