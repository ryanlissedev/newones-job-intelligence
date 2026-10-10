import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";

import type postgres from "postgres";

import {
  createMigrationUpgradeClient,
  requireMigrationUpgradeDatabaseUrl,
} from "./migration-upgrade-guard";

const upgradeDatabaseUrl = requireMigrationUpgradeDatabaseUrl(
  process.env.DATABASE_UPGRADE_TEST_URL
);
const upgradeDatabaseRequired =
  process.env.REQUIRE_DATABASE_UPGRADE_TESTS === "1";
const migrationsFolder = path.join(import.meta.dir, "migrations");

const readMigrationStatements = async (name: string): Promise<string[]> => {
  const migration = await Bun.file(path.join(migrationsFolder, name)).text();
  return migration
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
};

describe.serial("0000 to 0001 observation migration", () => {
  let client: ReturnType<typeof postgres> | undefined;
  let coreStatements: string[] = [];
  let ingestionStatements: string[] = [];

  beforeAll(async () => {
    if (!upgradeDatabaseUrl) {
      if (upgradeDatabaseRequired) {
        throw new Error("Required upgrade test database URL is unavailable");
      }
      return;
    }
    client = createMigrationUpgradeClient(upgradeDatabaseUrl);
    coreStatements = await readMigrationStatements("0000_core.sql");
    ingestionStatements = await readMigrationStatements(
      "0001_u3_durable_ingestion.sql"
    );
  });

  afterAll(async () => {
    await client?.end({ timeout: 5 });
  });

  const resetToCore = async (): Promise<void> => {
    if (!client) {
      return;
    }
    await client.unsafe(`
      DROP SCHEMA IF EXISTS curated CASCADE;
      DROP SCHEMA IF EXISTS marts CASCADE;
      DROP SCHEMA IF EXISTS staging CASCADE;
      DROP SCHEMA IF EXISTS drizzle CASCADE;
      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public;
    `);
    await client.begin(async (transaction) => {
      for (const statement of coreStatements) {
        // oxlint-disable-next-line no-await-in-loop -- migration statements are order-dependent
        await transaction.unsafe(statement);
      }
    });
  };

  const applyIngestionMigration = async (): Promise<void> => {
    if (!client) {
      return;
    }
    await client.begin(async (transaction) => {
      for (const statement of ingestionStatements) {
        // oxlint-disable-next-line no-await-in-loop -- migration statements are order-dependent
        await transaction.unsafe(statement);
      }
    });
  };

  const seedSource = async (): Promise<void> => {
    if (!client) {
      return;
    }
    await client.unsafe(`
      INSERT INTO curated.bron (id, categorie, config_ref, naam, schedule)
      VALUES
        (
          '10000000-0000-0000-0000-000000000001',
          'test',
          'mappings/legacy-source-v1.json',
          'Legacy source',
          '*/17 * * * *'
        ),
        (
          '10000000-0000-0000-0000-000000000002',
          'test',
          '   ',
          'Blank schedule',
          '   '
        );

      INSERT INTO curated.scrape_run (id, bron_id)
      VALUES
        ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001'),
        ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001'),
        ('20000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001');

      INSERT INTO curated.scrape_run (id, bron_id, status, geindigd)
      VALUES
        (
          '20000000-0000-0000-0000-000000000004',
          '10000000-0000-0000-0000-000000000001',
          'failed',
          '2026-08-29T09:00:00.000Z'
        ),
        (
          '20000000-0000-0000-0000-000000000005',
          '10000000-0000-0000-0000-000000000001',
          'succeeded',
          NULL
        );

      UPDATE curated.scrape_run
      SET gestart = '2026-08-29T08:30:00.000Z'
      WHERE id = '20000000-0000-0000-0000-000000000005';

      INSERT INTO staging.source_record (
        id,
        bron_id,
        bron_referentie,
        content_hash,
        raw_payload_ref,
        scrape_run_id
      ) VALUES (
        '30000000-0000-0000-0000-000000000001',
        '10000000-0000-0000-0000-000000000001',
        'legacy-reference',
        'mutable-current-hash',
        'raw/legacy.json',
        '20000000-0000-0000-0000-000000000003'
      );
    `);
  };

  it("classifies historical observations as new, unchanged, then changed", async () => {
    if (!client) {
      expect(upgradeDatabaseUrl).toBeUndefined();
      return;
    }
    await resetToCore();
    await seedSource();
    await client.unsafe(`
      INSERT INTO staging.aanvraag_observation (
        id,
        bron_id,
        payload,
        scrape_run_id,
        source_record_id
      ) VALUES
        (
          '40000000-0000-0000-0000-000000000003',
          '10000000-0000-0000-0000-000000000001',
          '{"contentHash":"hash-b","observedAt":"2026-08-29T12:00:00.000Z"}'::jsonb,
          '20000000-0000-0000-0000-000000000003',
          '30000000-0000-0000-0000-000000000001'
        ),
        (
          '40000000-0000-0000-0000-000000000001',
          '10000000-0000-0000-0000-000000000001',
          '{"contentHash":"hash-a","observedAt":"2026-08-29T10:00:00.000Z"}'::jsonb,
          '20000000-0000-0000-0000-000000000001',
          '30000000-0000-0000-0000-000000000001'
        ),
        (
          '40000000-0000-0000-0000-000000000002',
          '10000000-0000-0000-0000-000000000001',
          '{"contentHash":"hash-a","observedAt":"2026-08-29T11:00:00.000Z"}'::jsonb,
          '20000000-0000-0000-0000-000000000002',
          '30000000-0000-0000-0000-000000000001'
        );
    `);

    await applyIngestionMigration();

    const rows = await client<{ contentHash: string; outcome: string }[]>`
      SELECT
        content_hash AS "contentHash",
        outcome
      FROM staging.aanvraag_observation
      ORDER BY (payload->>'observedAt')::timestamptz, id
    `;
    expect([...rows]).toEqual([
      { contentHash: "hash-a", outcome: "new" },
      { contentHash: "hash-a", outcome: "unchanged" },
      { contentHash: "hash-b", outcome: "changed" },
    ]);
    const [legacyFailure] = await client<
      {
        failureClass: string;
        failureCode: string;
        failureMessage: string;
        failurePhase: string;
        fenceToken: string;
      }[]
    >`
      SELECT
        failure_class AS "failureClass",
        failure_code AS "failureCode",
        failure_message AS "failureMessage",
        failure_phase AS "failurePhase",
        fence_token AS "fenceToken"
      FROM curated.scrape_run
      WHERE id = '20000000-0000-0000-0000-000000000004'
    `;
    expect(legacyFailure).toEqual({
      failureClass: "internal",
      failureCode: "LEGACY_FAILURE",
      failureMessage: "Legacy run failed; details unavailable",
      failurePhase: "unknown",
      fenceToken: "0",
    });
    const intervals = await client<{ id: string; interval: string }[]>`
      SELECT id::text, interval
      FROM curated.bron
      ORDER BY id
    `;
    expect([...intervals]).toEqual([
      {
        id: "10000000-0000-0000-0000-000000000001",
        interval: "*/17 * * * *",
      },
      {
        id: "10000000-0000-0000-0000-000000000002",
        interval: "0 * * * *",
      },
    ]);
    const mappings = await client<{ id: string; mappingRef: string | null }[]>`
      SELECT id::text, mapping_ref AS "mappingRef"
      FROM curated.bron
      ORDER BY id
    `;
    expect([...mappings]).toEqual([
      {
        id: "10000000-0000-0000-0000-000000000001",
        mappingRef: "mappings/legacy-source-v1.json",
      },
      {
        id: "10000000-0000-0000-0000-000000000002",
        mappingRef: null,
      },
    ]);
    const [legacyTerminalRun] = await client<{ geindigd: Date }[]>`
      SELECT geindigd
      FROM curated.scrape_run
      WHERE id = '20000000-0000-0000-0000-000000000005'
    `;
    expect(legacyTerminalRun?.geindigd).toEqual(
      new Date("2026-08-29T08:30:00.000Z")
    );
  });

  it("rolls the migration back atomically when a payload hash is missing", async () => {
    if (!client) {
      expect(upgradeDatabaseUrl).toBeUndefined();
      return;
    }
    await resetToCore();
    await seedSource();
    await client.unsafe(`
      INSERT INTO staging.aanvraag_observation (
        bron_id,
        payload,
        scrape_run_id,
        source_record_id
      ) VALUES (
        '10000000-0000-0000-0000-000000000001',
        '{"observedAt":"2026-08-29T10:00:00.000Z"}'::jsonb,
        '20000000-0000-0000-0000-000000000001',
        '30000000-0000-0000-0000-000000000001'
      );
    `);

    await expect(applyIngestionMigration()).rejects.toThrow(
      "without an immutable payload contentHash"
    );
    const columns = await client<{ columnName: string }[]>`
      SELECT column_name AS "columnName"
      FROM information_schema.columns
      WHERE table_schema = 'staging'
        AND table_name = 'aanvraag_observation'
        AND column_name IN ('content_hash', 'outcome')
    `;
    expect(columns).toHaveLength(0);
  });

  it("rolls back and preserves legacy rows when equal timestamps have conflicting hashes", async () => {
    if (!client) {
      expect(upgradeDatabaseUrl).toBeUndefined();
      return;
    }
    await resetToCore();
    await seedSource();
    await client.unsafe(`
      INSERT INTO staging.aanvraag_observation (
        id,
        bron_id,
        payload,
        scrape_run_id,
        source_record_id
      ) VALUES
        (
          '40000000-0000-0000-0000-000000000011',
          '10000000-0000-0000-0000-000000000001',
          '{"contentHash":"hash-a","observedAt":"2026-08-29T10:00:00.000Z"}'::jsonb,
          '20000000-0000-0000-0000-000000000001',
          '30000000-0000-0000-0000-000000000001'
        ),
        (
          '40000000-0000-0000-0000-000000000012',
          '10000000-0000-0000-0000-000000000001',
          '{"contentHash":"hash-b","observedAt":"2026-08-29T10:00:00.000Z"}'::jsonb,
          '20000000-0000-0000-0000-000000000002',
          '30000000-0000-0000-0000-000000000001'
        );
    `);

    await expect(applyIngestionMigration()).rejects.toThrow(
      "ambiguous aanvraag observation ordering at equal observedAt"
    );
    const rows = await client<{ contentHash: string }[]>`
      SELECT payload->>'contentHash' AS "contentHash"
      FROM staging.aanvraag_observation
      ORDER BY id
    `;
    expect([...rows]).toEqual([
      { contentHash: "hash-a" },
      { contentHash: "hash-b" },
    ]);
    const columns = await client<{ columnName: string }[]>`
      SELECT column_name AS "columnName"
      FROM information_schema.columns
      WHERE table_schema = 'staging'
        AND table_name = 'aanvraag_observation'
        AND column_name IN ('content_hash', 'outcome')
    `;
    expect(columns).toHaveLength(0);
  });

  it("rolls the migration back atomically for duplicate replay keys", async () => {
    if (!client) {
      expect(upgradeDatabaseUrl).toBeUndefined();
      return;
    }
    await resetToCore();
    await seedSource();
    await client.unsafe(`
      INSERT INTO staging.aanvraag_observation (
        id,
        bron_id,
        payload,
        scrape_run_id,
        source_record_id
      ) VALUES
        (
          '40000000-0000-0000-0000-000000000001',
          '10000000-0000-0000-0000-000000000001',
          '{"contentHash":"hash-a","observedAt":"2026-08-29T10:00:00.000Z"}'::jsonb,
          '20000000-0000-0000-0000-000000000001',
          '30000000-0000-0000-0000-000000000001'
        ),
        (
          '40000000-0000-0000-0000-000000000002',
          '10000000-0000-0000-0000-000000000001',
          '{"contentHash":"hash-a","observedAt":"2026-08-29T10:01:00.000Z"}'::jsonb,
          '20000000-0000-0000-0000-000000000001',
          '30000000-0000-0000-0000-000000000001'
        );
    `);

    await expect(applyIngestionMigration()).rejects.toThrow(
      "duplicate aanvraag observation replay keys"
    );
    const columns = await client<{ columnName: string }[]>`
      SELECT column_name AS "columnName"
      FROM information_schema.columns
      WHERE table_schema = 'staging'
        AND table_name = 'aanvraag_observation'
        AND column_name IN ('content_hash', 'outcome')
    `;
    expect(columns).toHaveLength(0);
  });
});

describe.serial("0006 to 0007 snapshot search version migration", () => {
  let client: ReturnType<typeof postgres> | undefined;
  let priorStatements: string[] = [];
  let searchVersionStatements: string[] = [];
  const priorMigrations = [
    "0000_core.sql",
    "0001_u3_durable_ingestion.sql",
    "0002_u8_backfill_observability.sql",
    "0003_u9_snapshot_approval.sql",
    "0004_u10_export_idempotency.sql",
    "0005_u11_external_receipt.sql",
    "0006_search_projection_checkpoint.sql",
  ];

  beforeAll(async () => {
    if (!upgradeDatabaseUrl) {
      if (upgradeDatabaseRequired) {
        throw new Error("Required upgrade test database URL is unavailable");
      }
      return;
    }
    client = createMigrationUpgradeClient(upgradeDatabaseUrl);
    const perMigration = await Promise.all(
      priorMigrations.map((name) => readMigrationStatements(name))
    );
    priorStatements = perMigration.flat();
    searchVersionStatements = await readMigrationStatements(
      "0007_snapshot_search_version.sql"
    );
  });

  afterAll(async () => {
    await client?.end({ timeout: 5 });
  });

  it("applies on a database at 0006 and backfills existing snapshot rows", async () => {
    if (!client) {
      expect(upgradeDatabaseUrl).toBeUndefined();
      return;
    }

    await client.unsafe(`
      DROP SCHEMA IF EXISTS curated CASCADE;
      DROP SCHEMA IF EXISTS marts CASCADE;
      DROP SCHEMA IF EXISTS staging CASCADE;
      DROP SCHEMA IF EXISTS drizzle CASCADE;
      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public;
    `);
    await client.begin(async (transaction) => {
      for (const statement of priorStatements) {
        // oxlint-disable-next-line no-await-in-loop -- migration statements are order-dependent
        await transaction.unsafe(statement);
      }
    });

    const inserted = await client.unsafe(`
      INSERT INTO curated.query_snapshot
        (index_version, parser_version, query_text, result_ids, schema_version, user_id)
      VALUES
        (3, '1', 'Azure', '["00000000-0000-4000-8000-000000000001"]'::jsonb, 'slice-a-v1', 'recruiter-1'),
        (NULL, '1', 'DevOps', '[]'::jsonb, 'slice-a-v1', 'recruiter-1')
      RETURNING id;
    `);
    expect(inserted).toHaveLength(2);

    await client.begin(async (transaction) => {
      for (const statement of searchVersionStatements) {
        // oxlint-disable-next-line no-await-in-loop -- migration statements are order-dependent
        await transaction.unsafe(statement);
      }
    });

    const rows = await client.unsafe(`
      SELECT index_version, query_text, result_ids, search_applied_sequence, search_generation
      FROM curated.query_snapshot
      ORDER BY query_text ASC;
    `);
    expect(rows).toHaveLength(2);
    const [azure, devops] = rows;
    expect(azure?.search_generation).toBe(1);
    expect(String(azure?.search_applied_sequence)).toBe("3");
    // bigint since 0007 — postgres.js returns it as a string
    expect(String(azure?.index_version)).toBe("3");
    expect(azure?.result_ids).toEqual(["00000000-0000-4000-8000-000000000001"]);
    expect(devops?.search_generation).toBe(1);
    expect(String(devops?.search_applied_sequence)).toBe("0");

    const postMigration = await client.unsafe(`
      INSERT INTO curated.query_snapshot
        (index_version, parser_version, query_text, result_ids, schema_version, search_applied_sequence, search_generation, user_id)
      VALUES
        (9, '1', 'Kubernetes', '[]'::jsonb, 'slice-a-v1', 9, 1, 'recruiter-1')
      RETURNING search_applied_sequence, search_generation;
    `);
    expect(String(postMigration[0]?.search_applied_sequence)).toBe("9");
    expect(postMigration[0]?.search_generation).toBe(1);

    // index_version was integer before 0007; appliedSequence is a bigint
    // sequence, so the legacy mirror must accept values past 2^31.
    const beyondInt32 = await client.unsafe(`
      INSERT INTO curated.query_snapshot
        (index_version, parser_version, query_text, result_ids, schema_version, search_applied_sequence, search_generation, user_id)
      VALUES
        (3000000000, '1', 'Terraform', '[]'::jsonb, 'slice-a-v1', 3000000000, 1, 'recruiter-1')
      RETURNING index_version, search_applied_sequence;
    `);
    expect(String(beyondInt32[0]?.index_version)).toBe("3000000000");
    expect(String(beyondInt32[0]?.search_applied_sequence)).toBe("3000000000");
  });
});

describe.serial("0007 to 0008 bulk projector claims migration", () => {
  let client: ReturnType<typeof postgres> | undefined;
  let priorStatements: string[] = [];
  let claimStatements: string[] = [];
  const priorMigrations = [
    "0000_core.sql",
    "0001_u3_durable_ingestion.sql",
    "0002_u8_backfill_observability.sql",
    "0003_u9_snapshot_approval.sql",
    "0004_u10_export_idempotency.sql",
    "0005_u11_external_receipt.sql",
    "0006_search_projection_checkpoint.sql",
    "0007_snapshot_search_version.sql",
  ];

  beforeAll(async () => {
    if (!upgradeDatabaseUrl) {
      if (upgradeDatabaseRequired) {
        throw new Error("Required upgrade test database URL is unavailable");
      }
      return;
    }
    client = createMigrationUpgradeClient(upgradeDatabaseUrl);
    const perMigration = await Promise.all(
      priorMigrations.map((name) => readMigrationStatements(name))
    );
    priorStatements = perMigration.flat();
    claimStatements = await readMigrationStatements(
      "0008_bulk_projector_claims.sql"
    );
  });

  afterAll(async () => {
    await client?.end({ timeout: 5 });
  });

  it("applies on a database at 0007 with existing outbox rows and widens index_version", async () => {
    if (!client) {
      expect(upgradeDatabaseUrl).toBeUndefined();
      return;
    }

    await client.unsafe(`
      DROP SCHEMA IF EXISTS curated CASCADE;
      DROP SCHEMA IF EXISTS marts CASCADE;
      DROP SCHEMA IF EXISTS staging CASCADE;
      DROP SCHEMA IF EXISTS drizzle CASCADE;
      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public;
    `);
    await client.begin(async (transaction) => {
      for (const statement of priorStatements) {
        // oxlint-disable-next-line no-await-in-loop -- migration statements are order-dependent
        await transaction.unsafe(statement);
      }
    });

    const inserted = await client.unsafe(`
      INSERT INTO curated.outbox_event (aggregate_id, aggregate_type, event_type, payload, index_version, processed_at)
      VALUES
        ('00000000-0000-4000-8000-000000000001', 'aanvraag', 'aanvraag.nieuw', '{}'::jsonb, 5, now()),
        ('00000000-0000-4000-8000-000000000002', 'aanvraag', 'aanvraag.gewijzigd', '{}'::jsonb, NULL, NULL)
      RETURNING id;
    `);
    expect(inserted).toHaveLength(2);

    await client.begin(async (transaction) => {
      for (const statement of claimStatements) {
        // oxlint-disable-next-line no-await-in-loop -- migration statements are order-dependent
        await transaction.unsafe(statement);
      }
    });

    const rows = await client.unsafe(`
      SELECT aggregate_id, index_version, retry_count, claimed_until, last_error, dead_lettered_at, processed_at
      FROM curated.outbox_event
      ORDER BY sequence_number ASC;
    `);
    expect(rows).toHaveLength(2);
    const [done, pending] = rows;
    // bigint since 0008 — postgres.js returns it as a string
    expect(String(done?.index_version)).toBe("5");
    expect(done?.retry_count).toBe(0);
    expect(done?.claimed_until).toBeNull();
    expect(done?.dead_lettered_at).toBeNull();
    expect(pending?.index_version).toBeNull();
    expect(pending?.retry_count).toBe(0);
    expect(pending?.last_error).toBeNull();

    // The claim query the drain runs, verbatim in SQL: only the pending row.
    const claimed = await client.unsafe(`
      UPDATE curated.outbox_event SET claimed_until = now() + make_interval(secs => 120), claim_token = gen_random_uuid()
      WHERE id IN (
        SELECT id FROM curated.outbox_event o
        WHERE processed_at IS NULL AND dead_lettered_at IS NULL
          AND (claimed_until IS NULL OR claimed_until < now())
          AND NOT EXISTS (
            SELECT 1 FROM curated.outbox_event s
            WHERE s.aggregate_id = o.aggregate_id AND s.processed_at IS NULL
              AND s.claimed_until > now() AND s.id <> o.id)
        ORDER BY sequence_number LIMIT 100 FOR UPDATE SKIP LOCKED)
      RETURNING aggregate_id, claim_token;
    `);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.aggregate_id).toBe(
      "00000000-0000-4000-8000-000000000002"
    );
    expect(claimed[0]?.claim_token).toMatch(/^[0-9a-f-]{36}$/u);

    // index_version was integer before 0008; it mirrors a bigint sequence.
    const beyondInt32 = await client.unsafe(`
      INSERT INTO curated.outbox_event (aggregate_id, aggregate_type, event_type, payload, index_version)
      VALUES ('00000000-0000-4000-8000-000000000003', 'aanvraag', 'aanvraag.nieuw', '{}'::jsonb, 3000000000)
      RETURNING index_version;
    `);
    expect(String(beyondInt32[0]?.index_version)).toBe("3000000000");

    const state = await client.unsafe(`
      INSERT INTO curated.search_projection_state (aggregate_id, applied_sequence, generation, projection_hash)
      VALUES ('00000000-0000-4000-8000-000000000002', 3000000000, 1, 'abc.def')
      RETURNING applied_sequence, generation;
    `);
    expect(String(state[0]?.applied_sequence)).toBe("3000000000");
    expect(state[0]?.generation).toBe(1);
  });
});

describe.serial("0008 to 0009 source_record missed polls migration", () => {
  let client: ReturnType<typeof postgres> | undefined;
  let priorStatements: string[] = [];
  let missedPollsStatements: string[] = [];
  const priorMigrations = [
    "0000_core.sql",
    "0001_u3_durable_ingestion.sql",
    "0002_u8_backfill_observability.sql",
    "0003_u9_snapshot_approval.sql",
    "0004_u10_export_idempotency.sql",
    "0005_u11_external_receipt.sql",
    "0006_search_projection_checkpoint.sql",
    "0007_snapshot_search_version.sql",
    "0008_bulk_projector_claims.sql",
  ];

  beforeAll(async () => {
    if (!upgradeDatabaseUrl) {
      if (upgradeDatabaseRequired) {
        throw new Error("Required upgrade test database URL is unavailable");
      }
      return;
    }
    client = createMigrationUpgradeClient(upgradeDatabaseUrl);
    const perMigration = await Promise.all(
      priorMigrations.map((name) => readMigrationStatements(name))
    );
    priorStatements = perMigration.flat();
    missedPollsStatements = await readMigrationStatements(
      "0009_source_record_missed_polls.sql"
    );
  });

  afterAll(async () => {
    await client?.end({ timeout: 5 });
  });

  it("applies on a database at 0008 with existing source records, defaulting them to zero misses", async () => {
    if (!client) {
      expect(upgradeDatabaseUrl).toBeUndefined();
      return;
    }

    await client.unsafe(`
      DROP SCHEMA IF EXISTS curated CASCADE;
      DROP SCHEMA IF EXISTS marts CASCADE;
      DROP SCHEMA IF EXISTS staging CASCADE;
      DROP SCHEMA IF EXISTS drizzle CASCADE;
      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public;
    `);
    await client.begin(async (transaction) => {
      for (const statement of priorStatements) {
        // oxlint-disable-next-line no-await-in-loop -- migration statements are order-dependent
        await transaction.unsafe(statement);
      }
    });

    await client.unsafe(`
      INSERT INTO curated.bron (id, categorie, naam)
      VALUES ('10000000-0000-0000-0000-000000000009', 'msp_broker', 'Hero');
      INSERT INTO curated.scrape_run (id, bron_id)
      VALUES
        ('20000000-0000-0000-0000-000000000091', '10000000-0000-0000-0000-000000000009'),
        ('20000000-0000-0000-0000-000000000092', '10000000-0000-0000-0000-000000000009');
      INSERT INTO staging.source_record (bron_id, bron_referentie, content_hash, raw_payload_ref, scrape_run_id)
      VALUES
        ('10000000-0000-0000-0000-000000000009', 'A', 'hash-a', 'raw/hero/a.html', '20000000-0000-0000-0000-000000000091'),
        ('10000000-0000-0000-0000-000000000009', 'B', 'hash-b', 'raw/hero/b.html', '20000000-0000-0000-0000-000000000091');
    `);

    await client.begin(async (transaction) => {
      for (const statement of missedPollsStatements) {
        // oxlint-disable-next-line no-await-in-loop -- migration statements are order-dependent
        await transaction.unsafe(statement);
      }
    });

    const rows = await client.unsafe(`
      SELECT bron_referentie, missed_polls, last_seen_scrape_run_id, last_seen_at, last_missed_scrape_run_id
      FROM staging.source_record
      ORDER BY bron_referentie;
    `);
    expect(rows).toHaveLength(2);
    expect(rows).toMatchObject([
      {
        bron_referentie: "A",
        last_missed_scrape_run_id: null,
        last_seen_at: null,
        last_seen_scrape_run_id: null,
        missed_polls: 0,
      },
      {
        bron_referentie: "B",
        last_missed_scrape_run_id: null,
        last_seen_at: null,
        last_seen_scrape_run_id: null,
        missed_polls: 0,
      },
    ]);

    // The reconcile step's two statements, verbatim in SQL against upgraded rows.
    const reset = await client.unsafe(`
      UPDATE staging.source_record
      SET missed_polls = 0, last_seen_scrape_run_id = '20000000-0000-0000-0000-000000000092', last_seen_at = now()
      WHERE bron_id = '10000000-0000-0000-0000-000000000009' AND bron_referentie IN ('A')
      RETURNING bron_referentie;
    `);
    expect(reset).toHaveLength(1);
    const bumpSql = `
      UPDATE staging.source_record
      SET missed_polls = missed_polls + 1, last_missed_scrape_run_id = '20000000-0000-0000-0000-000000000092'
      WHERE bron_id = '10000000-0000-0000-0000-000000000009'
        AND missed_polls <= 3
        AND last_missed_scrape_run_id IS DISTINCT FROM '20000000-0000-0000-0000-000000000092'
        AND bron_referentie NOT IN ('A')
      RETURNING bron_referentie, missed_polls;
    `;
    const bumped = await client.unsafe(bumpSql);
    expect(bumped).toHaveLength(1);
    expect(bumped).toMatchObject([{ bron_referentie: "B", missed_polls: 1 }]);
    // Replaying the same run is a no-op.
    const replayed = await client.unsafe(bumpSql);
    expect(replayed).toHaveLength(0);

    // postgres.js queries are lazy thenables; `expect(...).rejects` never
    // settles on them, so catch explicitly.
    let constraintError: unknown;
    try {
      await client.unsafe(`
        UPDATE staging.source_record SET missed_polls = -1 WHERE bron_referentie = 'B';
      `);
    } catch (error) {
      constraintError = error;
    }
    expect(constraintError).toMatchObject({ code: "23514" });

    // Deleting the run a record was last seen in must not delete the record.
    await client.unsafe(`
      DELETE FROM curated.scrape_run WHERE id = '20000000-0000-0000-0000-000000000092';
    `);
    const afterRunDelete = await client.unsafe(`
      SELECT bron_referentie, last_seen_scrape_run_id
      FROM staging.source_record WHERE bron_referentie = 'A';
    `);
    expect(afterRunDelete).toHaveLength(1);
    expect(afterRunDelete).toMatchObject([
      { bron_referentie: "A", last_seen_scrape_run_id: null },
    ]);
  });
});

describe.serial("0009 to 0010 query_snapshot search scope migration", () => {
  let client: ReturnType<typeof postgres> | undefined;
  let priorStatements: string[] = [];
  let scopeStatements: string[] = [];
  const priorMigrations = [
    "0000_core.sql",
    "0001_u3_durable_ingestion.sql",
    "0002_u8_backfill_observability.sql",
    "0003_u9_snapshot_approval.sql",
    "0004_u10_export_idempotency.sql",
    "0005_u11_external_receipt.sql",
    "0006_search_projection_checkpoint.sql",
    "0007_snapshot_search_version.sql",
    "0008_bulk_projector_claims.sql",
    "0009_source_record_missed_polls.sql",
  ];

  beforeAll(async () => {
    if (!upgradeDatabaseUrl) {
      if (upgradeDatabaseRequired) {
        throw new Error("Required upgrade test database URL is unavailable");
      }
      return;
    }
    client = createMigrationUpgradeClient(upgradeDatabaseUrl);
    const perMigration = await Promise.all(
      priorMigrations.map((name) => readMigrationStatements(name))
    );
    priorStatements = perMigration.flat();
    scopeStatements = await readMigrationStatements(
      "0010_query_snapshot_search_scope.sql"
    );
  });

  afterAll(async () => {
    await client?.end({ timeout: 5 });
  });

  it("applies on a database at 0009: existing snapshots become scope 'all', new rows default to 'active'", async () => {
    if (!client) {
      expect(upgradeDatabaseUrl).toBeUndefined();
      return;
    }

    await client.unsafe(`
      DROP SCHEMA IF EXISTS curated CASCADE;
      DROP SCHEMA IF EXISTS marts CASCADE;
      DROP SCHEMA IF EXISTS staging CASCADE;
      DROP SCHEMA IF EXISTS drizzle CASCADE;
      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public;
    `);
    await client.begin(async (transaction) => {
      for (const statement of priorStatements) {
        // oxlint-disable-next-line no-await-in-loop -- migration statements are order-dependent
        await transaction.unsafe(statement);
      }
    });

    const inserted = await client.unsafe(`
      INSERT INTO curated.query_snapshot
        (index_version, parser_version, query_text, result_ids, schema_version, search_applied_sequence, search_generation, user_id)
      VALUES
        (3, '1', 'Azure', '["00000000-0000-4000-8000-000000000001"]'::jsonb, 'slice-a-v1', 3, 1, 'recruiter-1')
      RETURNING id;
    `);
    expect(inserted).toHaveLength(1);

    await client.begin(async (transaction) => {
      for (const statement of scopeStatements) {
        // oxlint-disable-next-line no-await-in-loop -- migration statements are order-dependent
        await transaction.unsafe(statement);
      }
    });

    // Pre-split snapshots were made against the single table that held the
    // whole stock, so they are backfilled as 'all'; the column default then
    // flips to 'active' for rows written after the split.
    const rows = await client.unsafe(`
      SELECT query_text, search_scope FROM curated.query_snapshot;
    `);
    expect(rows).toMatchObject([{ query_text: "Azure", search_scope: "all" }]);

    const defaulted = await client.unsafe(`
      INSERT INTO curated.query_snapshot
        (index_version, parser_version, query_text, result_ids, schema_version, search_applied_sequence, search_generation, user_id)
      VALUES
        (4, '1', 'DevOps', '[]'::jsonb, 'slice-a-v1', 4, 1, 'recruiter-1')
      RETURNING search_scope;
    `);
    expect(defaulted[0]?.search_scope).toBe("active");

    // postgres.js queries are lazy thenables; `expect(...).rejects` never
    // settles on them, so catch explicitly.
    let constraintError: unknown;
    try {
      await client.unsafe(`
        UPDATE curated.query_snapshot SET search_scope = 'archive' WHERE query_text = 'DevOps';
      `);
    } catch (error) {
      constraintError = error;
    }
    expect(constraintError).toMatchObject({ code: "23514" });
  });
});

describe.serial(
  "0010 to 0011 aanvraag locatie_tekst/sluitingsdatum migration",
  () => {
    let client: ReturnType<typeof postgres> | undefined;
    let priorStatements: string[] = [];
    let columnStatements: string[] = [];
    const priorMigrations = [
      "0000_core.sql",
      "0001_u3_durable_ingestion.sql",
      "0002_u8_backfill_observability.sql",
      "0003_u9_snapshot_approval.sql",
      "0004_u10_export_idempotency.sql",
      "0005_u11_external_receipt.sql",
      "0006_search_projection_checkpoint.sql",
      "0007_snapshot_search_version.sql",
      "0008_bulk_projector_claims.sql",
      "0009_source_record_missed_polls.sql",
      "0010_query_snapshot_search_scope.sql",
    ];

    beforeAll(async () => {
      if (!upgradeDatabaseUrl) {
        if (upgradeDatabaseRequired) {
          throw new Error("Required upgrade test database URL is unavailable");
        }
        return;
      }
      client = createMigrationUpgradeClient(upgradeDatabaseUrl);
      const perMigration = await Promise.all(
        priorMigrations.map((name) => readMigrationStatements(name))
      );
      priorStatements = perMigration.flat();
      columnStatements = await readMigrationStatements(
        "0011_aanvraag_locatie_sluitingsdatum.sql"
      );
    });

    afterAll(async () => {
      await client?.end({ timeout: 5 });
    });

    it("adds nullable columns: existing rows read NULL, new rows can set both", async () => {
      if (!client) {
        expect(upgradeDatabaseUrl).toBeUndefined();
        return;
      }

      await client.unsafe(`
      DROP SCHEMA IF EXISTS curated CASCADE;
      DROP SCHEMA IF EXISTS marts CASCADE;
      DROP SCHEMA IF EXISTS staging CASCADE;
      DROP SCHEMA IF EXISTS drizzle CASCADE;
      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public;
    `);
      await client.begin(async (transaction) => {
        for (const statement of priorStatements) {
          // oxlint-disable-next-line no-await-in-loop -- migration statements are order-dependent
          await transaction.unsafe(statement);
        }
      });

      const [bron] = await client.unsafe(`
      INSERT INTO curated.bron (categorie, naam) VALUES ('msp_broker', 'Existing Bron')
      RETURNING id;
    `);
      const [scrapeRun] = await client.unsafe(`
      INSERT INTO curated.scrape_run (bron_id) VALUES ('${bron?.id}')
      RETURNING id;
    `);
      await client.unsafe(`
      INSERT INTO curated.aanvraag
        (beschrijving, bron_id, bron_referentie, content_hash, eerste_gezien_op, extractie_methode, laatst_gezien_op, raw_payload_ref, scrape_run_id, titel)
      VALUES
        ('pre-migration row', '${bron?.id}', 'ref-existing', 'hash-existing', now(), 'html_parser', now(), 'raw/existing.html', '${scrapeRun?.id}', 'Existing aanvraag');
    `);

      await client.begin(async (transaction) => {
        for (const statement of columnStatements) {
          // oxlint-disable-next-line no-await-in-loop -- migration statements are order-dependent
          await transaction.unsafe(statement);
        }
      });

      // Existing rows have no way to backfill a value the source never
      // carried at ingest time -- they read NULL until the next poll re-curates
      // them (see RJC-394 loader comment).
      const existing = await client.unsafe(`
      SELECT locatie_tekst, sluitingsdatum FROM curated.aanvraag WHERE bron_referentie = 'ref-existing';
    `);
      expect(existing).toMatchObject([
        { locatie_tekst: null, sluitingsdatum: null },
      ]);

      await client.unsafe(`
      INSERT INTO curated.aanvraag
        (beschrijving, bron_id, bron_referentie, content_hash, eerste_gezien_op, extractie_methode, laatst_gezien_op, locatie_tekst, raw_payload_ref, scrape_run_id, sluitingsdatum, titel)
      VALUES
        ('post-migration row', '${bron?.id}', 'ref-new', 'hash-new', now(), 'html_parser', now(), 'Amsterdam', 'raw/new.html', '${scrapeRun?.id}', '2026-09-07T11:00:00.000Z', 'New aanvraag');
    `);
      const created = await client.unsafe(`
      SELECT locatie_tekst, sluitingsdatum FROM curated.aanvraag WHERE bron_referentie = 'ref-new';
    `);
      expect(created).toHaveLength(1);
      expect(created[0]?.locatie_tekst).toBe("Amsterdam");
      expect(new Date(created[0]?.sluitingsdatum).toISOString()).toBe(
        "2026-09-07T11:00:00.000Z"
      );
    });
  }
);

describe.serial("0011 to 0012 source_record listing_hash migration", () => {
  let client: ReturnType<typeof postgres> | undefined;
  let priorStatements: string[] = [];
  let listingHashStatements: string[] = [];
  const priorMigrations = [
    "0000_core.sql",
    "0001_u3_durable_ingestion.sql",
    "0002_u8_backfill_observability.sql",
    "0003_u9_snapshot_approval.sql",
    "0004_u10_export_idempotency.sql",
    "0005_u11_external_receipt.sql",
    "0006_search_projection_checkpoint.sql",
    "0007_snapshot_search_version.sql",
    "0008_bulk_projector_claims.sql",
    "0009_source_record_missed_polls.sql",
    "0010_query_snapshot_search_scope.sql",
    "0011_aanvraag_locatie_sluitingsdatum.sql",
  ];

  beforeAll(async () => {
    if (!upgradeDatabaseUrl) {
      if (upgradeDatabaseRequired) {
        throw new Error("Required upgrade test database URL is unavailable");
      }
      return;
    }
    client = createMigrationUpgradeClient(upgradeDatabaseUrl);
    const perMigration = await Promise.all(
      priorMigrations.map((name) => readMigrationStatements(name))
    );
    priorStatements = perMigration.flat();
    listingHashStatements = await readMigrationStatements(
      "0012_source_record_listing_hash.sql"
    );
  });

  afterAll(async () => {
    await client?.end({ timeout: 5 });
  });

  it("adds a nullable listing_hash: existing rows read NULL (never skip), new observations can set it", async () => {
    if (!client) {
      expect(upgradeDatabaseUrl).toBeUndefined();
      return;
    }

    await client.unsafe(`
      DROP SCHEMA IF EXISTS curated CASCADE;
      DROP SCHEMA IF EXISTS marts CASCADE;
      DROP SCHEMA IF EXISTS staging CASCADE;
      DROP SCHEMA IF EXISTS drizzle CASCADE;
      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public;
    `);
    await client.begin(async (transaction) => {
      for (const statement of priorStatements) {
        // oxlint-disable-next-line no-await-in-loop -- migration statements are order-dependent
        await transaction.unsafe(statement);
      }
    });

    const [bron] = await client.unsafe(`
      INSERT INTO curated.bron (categorie, naam) VALUES ('msp_broker', 'Existing Bron')
      RETURNING id;
    `);
    const [scrapeRun] = await client.unsafe(`
      INSERT INTO curated.scrape_run (bron_id) VALUES ('${bron?.id}')
      RETURNING id;
    `);
    await client.unsafe(`
      INSERT INTO staging.source_record
        (bron_id, bron_referentie, content_hash, raw_payload_ref, scrape_run_id)
      VALUES
        ('${bron?.id}', 'ref-existing', 'payload-hash-existing', 'raw/existing.json', '${scrapeRun?.id}');
    `);

    await client.begin(async (transaction) => {
      for (const statement of listingHashStatements) {
        // oxlint-disable-next-line no-await-in-loop -- migration statements are order-dependent
        await transaction.unsafe(statement);
      }
    });

    // A pre-0012 row has never recorded a listing hash: it must read NULL,
    // which the known-hash short-circuit treats as "never skip".
    const existing = await client.unsafe(`
      SELECT content_hash, listing_hash FROM staging.source_record WHERE bron_referentie = 'ref-existing';
    `);
    expect(existing).toMatchObject([
      { content_hash: "payload-hash-existing", listing_hash: null },
    ]);

    await client.unsafe(`
      UPDATE staging.source_record SET listing_hash = 'listing-hash-1' WHERE bron_referentie = 'ref-existing';
    `);
    const updated = await client.unsafe(`
      SELECT listing_hash FROM staging.source_record WHERE bron_referentie = 'ref-existing';
    `);
    expect(updated).toMatchObject([{ listing_hash: "listing-hash-1" }]);
  });
});

describe.serial("0014 to 0015 dedup_groep dedup_key migration", () => {
  let client: ReturnType<typeof postgres> | undefined;
  let priorStatements: string[] = [];
  let dedupKeyStatements: string[] = [];
  const priorMigrations = [
    "0000_core.sql",
    "0001_u3_durable_ingestion.sql",
    "0002_u8_backfill_observability.sql",
    "0003_u9_snapshot_approval.sql",
    "0004_u10_export_idempotency.sql",
    "0005_u11_external_receipt.sql",
    "0006_search_projection_checkpoint.sql",
    "0007_snapshot_search_version.sql",
    "0008_bulk_projector_claims.sql",
    "0009_source_record_missed_polls.sql",
    "0010_query_snapshot_search_scope.sql",
    "0011_aanvraag_locatie_sluitingsdatum.sql",
    "0012_source_record_listing_hash.sql",
    "0013_durable_user_writes.sql",
    "0014_auth_user_role.sql",
  ];
  // Pre-0015 rows stored the key in "methode": fields joined by U+001F.
  const SEP = "";
  const KEY_DUPLICATED = `senior java developer${SEP}gemeente amsterdam${SEP}2026-09-01`;
  const KEY_SINGLE = `data engineer${SEP}provincie utrecht${SEP}2026-10-01`;
  const UNIQUE_VIOLATION = "23505";

  beforeAll(async () => {
    if (!upgradeDatabaseUrl) {
      if (upgradeDatabaseRequired) {
        throw new Error("Required upgrade test database URL is unavailable");
      }
      return;
    }
    client = createMigrationUpgradeClient(upgradeDatabaseUrl);
    const perMigration = await Promise.all(
      priorMigrations.map((name) => readMigrationStatements(name))
    );
    priorStatements = perMigration.flat();
    dedupKeyStatements = await readMigrationStatements(
      "0015_dedup_groep_dedup_key.sql"
    );
  });

  afterAll(async () => {
    await client?.end({ timeout: 5 });
  });

  it("merges duplicate groups deterministically, backfills dedup_key, and enforces uniqueness", async () => {
    if (!client) {
      expect(upgradeDatabaseUrl).toBeUndefined();
      return;
    }

    await client.unsafe(`
      DROP SCHEMA IF EXISTS curated CASCADE;
      DROP SCHEMA IF EXISTS marts CASCADE;
      DROP SCHEMA IF EXISTS staging CASCADE;
      DROP SCHEMA IF EXISTS drizzle CASCADE;
      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public;
    `);
    await client.begin(async (transaction) => {
      for (const statement of priorStatements) {
        // oxlint-disable-next-line no-await-in-loop -- migration statements are order-dependent
        await transaction.unsafe(statement);
      }
    });

    // Three groups for one key (the race this migration closes): the oldest,
    // a newer one a reviewer confirmed, and a newest unconfirmed one. One
    // group for another key, and one legacy row whose "methode" is not a key.
    await client.unsafe(
      `
      INSERT INTO curated.dedup_groep (id, methode, handmatig_bevestigd, created_at) VALUES
        ('30000000-0000-0000-0000-000000000001', $1, false, '2026-09-01T08:00:00Z'),
        ('30000000-0000-0000-0000-000000000002', $1, true,  '2026-09-01T09:00:00Z'),
        ('30000000-0000-0000-0000-000000000003', $1, false, '2026-09-01T10:00:00Z'),
        ('30000000-0000-0000-0000-000000000004', $2, false, '2026-09-01T08:00:00Z'),
        ('30000000-0000-0000-0000-000000000005', 'html', false, '2026-09-01T08:00:00Z');
    `,
      [KEY_DUPLICATED, KEY_SINGLE]
    );
    const [bron] = await client.unsafe(`
      INSERT INTO curated.bron (categorie, naam) VALUES ('msp_broker', 'Existing Bron')
      RETURNING id;
    `);
    const [scrapeRun] = await client.unsafe(`
      INSERT INTO curated.scrape_run (bron_id) VALUES ('${bron?.id}')
      RETURNING id;
    `);
    const aanvraagValues = (ref: string, groep: string | null) =>
      `('${bron?.id}', '${ref}', 'beschrijving', 'hash-${ref}', now(), 'html_parser', now(), 'raw/${ref}.html', '${scrapeRun?.id}', 'titel', ${groep ? `'${groep}'` : "NULL"})`;
    await client.unsafe(`
      INSERT INTO curated.aanvraag
        (bron_id, bron_referentie, beschrijving, content_hash, eerste_gezien_op, extractie_methode, laatst_gezien_op, raw_payload_ref, scrape_run_id, titel, dedup_groep_id)
      VALUES
        ${aanvraagValues("on-old", "30000000-0000-0000-0000-000000000001")},
        ${aanvraagValues("on-confirmed", "30000000-0000-0000-0000-000000000002")},
        ${aanvraagValues("on-new", "30000000-0000-0000-0000-000000000003")},
        ${aanvraagValues("on-single", "30000000-0000-0000-0000-000000000004")},
        ${aanvraagValues("on-legacy", "30000000-0000-0000-0000-000000000005")},
        ${aanvraagValues("ungrouped", null)};
    `);

    await client.begin(async (transaction) => {
      for (const statement of dedupKeyStatements) {
        // oxlint-disable-next-line no-await-in-loop -- migration statements are order-dependent
        await transaction.unsafe(statement);
      }
    });

    // Survivor for the duplicated key is the confirmed group, even though it
    // is not the oldest; both losers are gone.
    const groups = await client.unsafe(`
      SELECT id, methode, dedup_key, handmatig_bevestigd
      FROM curated.dedup_groep ORDER BY id;
    `);
    expect(groups).toMatchObject([
      {
        dedup_key: KEY_DUPLICATED,
        handmatig_bevestigd: true,
        id: "30000000-0000-0000-0000-000000000002",
        methode: KEY_DUPLICATED,
      },
      {
        dedup_key: KEY_SINGLE,
        handmatig_bevestigd: false,
        id: "30000000-0000-0000-0000-000000000004",
        methode: KEY_SINGLE,
      },
      // A non-key "methode" is preserved as-is and gets no dedup_key.
      {
        dedup_key: null,
        handmatig_bevestigd: false,
        id: "30000000-0000-0000-0000-000000000005",
        methode: "html",
      },
    ]);

    // Every aanvraag on a losing group now points at the survivor; the rest
    // are untouched (no ON DELETE SET NULL fallout).
    const links = await client.unsafe(`
      SELECT bron_referentie, dedup_groep_id FROM curated.aanvraag ORDER BY bron_referentie;
    `);
    expect(links).toMatchObject([
      {
        bron_referentie: "on-confirmed",
        dedup_groep_id: "30000000-0000-0000-0000-000000000002",
      },
      {
        bron_referentie: "on-legacy",
        dedup_groep_id: "30000000-0000-0000-0000-000000000005",
      },
      {
        bron_referentie: "on-new",
        dedup_groep_id: "30000000-0000-0000-0000-000000000002",
      },
      {
        bron_referentie: "on-old",
        dedup_groep_id: "30000000-0000-0000-0000-000000000002",
      },
      {
        bron_referentie: "on-single",
        dedup_groep_id: "30000000-0000-0000-0000-000000000004",
      },
      { bron_referentie: "ungrouped", dedup_groep_id: null },
    ]);

    // The index is what makes the curate store's insert-on-conflict safe.
    const [index] = await client.unsafe(`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'curated' AND indexname = 'dedup_groep_dedup_key_uidx';
    `);
    expect(index?.indexdef).toContain("UNIQUE INDEX");
    expect(index?.indexdef).toContain("WHERE (dedup_key IS NOT NULL)");
    // postgres.js queries are lazy thenables, not Promises: wrap in an async
    // call so `.rejects` actually executes the insert.
    const activeClient = client;
    const insertDuplicate = async (): Promise<void> => {
      await activeClient.unsafe(
        "INSERT INTO curated.dedup_groep (dedup_key) VALUES ($1);",
        [KEY_SINGLE]
      );
    };
    await expect(insertDuplicate()).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
    });
    // NULL keys stay outside the index, so legacy-style rows still insert.
    await client.unsafe(
      "INSERT INTO curated.dedup_groep (methode) VALUES ('html'), ('html');"
    );
  });
});

describe.serial("0015 to 0016 bron_health and alert migration", () => {
  let client: ReturnType<typeof postgres> | undefined;
  let priorStatements: string[] = [];
  let bronHealthAlertStatements: string[] = [];
  const priorMigrations = [
    "0000_core.sql",
    "0001_u3_durable_ingestion.sql",
    "0002_u8_backfill_observability.sql",
    "0003_u9_snapshot_approval.sql",
    "0004_u10_export_idempotency.sql",
    "0005_u11_external_receipt.sql",
    "0006_search_projection_checkpoint.sql",
    "0007_snapshot_search_version.sql",
    "0008_bulk_projector_claims.sql",
    "0009_source_record_missed_polls.sql",
    "0010_query_snapshot_search_scope.sql",
    "0011_aanvraag_locatie_sluitingsdatum.sql",
    "0012_source_record_listing_hash.sql",
    "0013_durable_user_writes.sql",
    "0014_auth_user_role.sql",
    "0015_dedup_groep_dedup_key.sql",
  ];

  beforeAll(async () => {
    if (!upgradeDatabaseUrl) {
      if (upgradeDatabaseRequired) {
        throw new Error("Required upgrade test database URL is unavailable");
      }
      return;
    }
    client = createMigrationUpgradeClient(upgradeDatabaseUrl);
    const perMigration = await Promise.all(
      priorMigrations.map((name) => readMigrationStatements(name))
    );
    priorStatements = perMigration.flat();
    bronHealthAlertStatements = await readMigrationStatements(
      "0016_bron_health_and_alerts.sql"
    );
  });

  afterAll(async () => {
    await client?.end({ timeout: 5 });
  });

  it("creates curated.bron_health and curated.alert tables with constraints", async () => {
    if (!client) {
      expect(upgradeDatabaseUrl).toBeUndefined();
      return;
    }

    await client.unsafe(`
      DROP SCHEMA IF EXISTS curated CASCADE;
      DROP SCHEMA IF EXISTS marts CASCADE;
      DROP SCHEMA IF EXISTS staging CASCADE;
      DROP SCHEMA IF EXISTS drizzle CASCADE;
      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public;
    `);

    await client.begin(async (transaction) => {
      for (const statement of priorStatements) {
        // oxlint-disable-next-line no-await-in-loop -- migration statements are order-dependent
        await transaction.unsafe(statement);
      }
    });

    const testBronId = "10000000-0000-4000-8000-000000000016";
    await client.unsafe(`
      INSERT INTO curated.bron (id, naam, categorie, status, voorwaarden_status)
      VALUES ('${testBronId}', 'Test Bron 16', 'overheidsportaal', 'ready', 'toegestaan');
    `);

    await client.begin(async (transaction) => {
      for (const statement of bronHealthAlertStatements) {
        // oxlint-disable-next-line no-await-in-loop -- migration statements are order-dependent
        await transaction.unsafe(statement);
      }
    });

    await client.unsafe(`
      INSERT INTO curated.bron_health (bron_id, circuit_status, last_run_status, silence_alert_open)
      VALUES ('${testBronId}', 'closed', 'succeeded', false);
    `);

    const healthRows = await client.unsafe(`
      SELECT bron_id, circuit_status, silence_alert_open FROM curated.bron_health WHERE bron_id = '${testBronId}';
    `);
    expect(healthRows).toMatchObject([
      {
        bron_id: testBronId,
        circuit_status: "closed",
        silence_alert_open: false,
      },
    ]);

    const testAlertId = "20000000-0000-4000-8000-000000000016";
    await client.unsafe(`
      INSERT INTO curated.alert (id, bron_id, dedupe_key, kind, message, evidence)
      VALUES ('${testAlertId}', '${testBronId}', 'silence:${testBronId}', 'bron.stil', 'Alert message', '{"key": "val"}'::jsonb);
    `);

    const alertRows = await client.unsafe(`
      SELECT id, bron_id, dedupe_key, acked_at FROM curated.alert WHERE id = '${testAlertId}';
    `);
    expect(alertRows).toMatchObject([
      {
        acked_at: null,
        bron_id: testBronId,
        dedupe_key: `silence:${testBronId}`,
        id: testAlertId,
      },
    ]);

    const activeClient = client;
    const updateInconsistentAck = async (): Promise<void> => {
      await activeClient.unsafe(`
        UPDATE curated.alert SET acked_at = now() WHERE id = '${testAlertId}';
      `);
    };
    await expect(updateInconsistentAck()).rejects.toMatchObject({
      code: "23514",
    });

    await client.unsafe(`
      UPDATE curated.alert SET acked_at = now(), acked_by = 'operator-1' WHERE id = '${testAlertId}';
    `);

    await client.unsafe(`
      DELETE FROM curated.bron WHERE id = '${testBronId}';
    `);
    const remainingHealth = await client.unsafe(
      `SELECT * FROM curated.bron_health WHERE bron_id = '${testBronId}';`
    );
    const remainingAlert = await client.unsafe(
      `SELECT * FROM curated.alert WHERE id = '${testAlertId}';`
    );
    expect(remainingHealth).toHaveLength(0);
    expect(remainingAlert).toHaveLength(0);
  });
});

describe.serial("0027 to 0028 poller health telemetry migration", () => {
  let client: ReturnType<typeof postgres> | undefined;
  let priorStatements: string[] = [];
  let telemetryStatements: string[] = [];

  const priorMigrations = [
    "0000_core.sql",
    "0001_u3_durable_ingestion.sql",
    "0002_u8_backfill_observability.sql",
    "0003_u9_snapshot_approval.sql",
    "0004_u10_export_idempotency.sql",
    "0005_u11_external_receipt.sql",
    "0006_search_projection_checkpoint.sql",
    "0007_snapshot_search_version.sql",
    "0008_bulk_projector_claims.sql",
    "0009_source_record_missed_polls.sql",
    "0010_query_snapshot_search_scope.sql",
    "0011_aanvraag_locatie_sluitingsdatum.sql",
    "0012_source_record_listing_hash.sql",
    "0013_durable_user_writes.sql",
    "0014_auth_user_role.sql",
    "0015_dedup_groep_dedup_key.sql",
    "0016_bron_health_and_alerts.sql",
    "0017_export_effect_reservation.sql",
    "0018_saved_search_soft_delete.sql",
    "0019_markering_clear_tombstone.sql",
    "0020_aanvraag_enrichment.sql",
    "0021_merge_duplicate_bron_namen.sql",
    "0022_aanvraag_commercial_columns.sql",
    "0023_search_projector_runtime.sql",
    "0024_enrichment_publicatiedatum_field.sql",
    "0025_enrichment_beschrijving_field.sql",
    "0026_aanvraag_contactpersonen.sql",
    "0027_enrichment_detail_fields.sql",
  ];

  beforeAll(async () => {
    if (!upgradeDatabaseUrl) {
      if (upgradeDatabaseRequired) {
        throw new Error("Required upgrade test database URL is unavailable");
      }
      return;
    }
    client = createMigrationUpgradeClient(upgradeDatabaseUrl);
    const perMigration = await Promise.all(
      priorMigrations.map((name) => readMigrationStatements(name))
    );
    priorStatements = perMigration.flat();
    telemetryStatements = await readMigrationStatements(
      "0028_poller_health_telemetry.sql"
    );
  });

  afterAll(async () => {
    await client?.end({ timeout: 5 });
  });

  it("preserves legacy bron health while adding nullable telemetry state", async () => {
    if (!client) {
      expect(upgradeDatabaseUrl).toBeUndefined();
      return;
    }

    await client.unsafe(`
      DROP SCHEMA IF EXISTS curated CASCADE;
      DROP SCHEMA IF EXISTS marts CASCADE;
      DROP SCHEMA IF EXISTS staging CASCADE;
      DROP SCHEMA IF EXISTS drizzle CASCADE;
      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public;
    `);

    await client.begin(async (transaction) => {
      for (const statement of priorStatements) {
        // oxlint-disable-next-line no-await-in-loop -- migration statements are order-dependent
        await transaction.unsafe(statement);
      }
    });

    const bronId = "10000000-0000-0000-0000-000000000028";
    await client.unsafe(`
      INSERT INTO curated.bron (id, naam, categorie, status, voorwaarden_status)
      VALUES ('${bronId}', 'Legacy telemetry source', 'test', 'ready', 'toegestaan');
      INSERT INTO curated.bron_health (
        bron_id,
        circuit_status,
        last_run_at,
        last_run_status,
        silence_alert_open,
        updated_at
      ) VALUES (
        '${bronId}',
        'open',
        '2026-09-19T10:00:00.000Z',
        'failed',
        true,
        '2026-09-19T10:01:00.000Z'
      );
    `);

    await client.begin(async (transaction) => {
      for (const statement of telemetryStatements) {
        // oxlint-disable-next-line no-await-in-loop -- migration statements are order-dependent
        await transaction.unsafe(statement);
      }
    });

    const [health] = await client<
      {
        bronId: string;
        circuitStatus: string;
        lastRunAt: string;
        lastRunStatus: string;
        silenceAlertOpen: boolean;
        updatedAt: string;
        activeRunId: string | null;
        lastCompletionOutcome: string | null;
        lastFullySuccessfulAt: string | null;
        progressAt: string | null;
        progressPhase: string | null;
        phaseStartedAt: string | null;
      }[]
    >`
      SELECT
        bron_id::text AS "bronId",
        circuit_status AS "circuitStatus",
        to_char(last_run_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastRunAt",
        last_run_status AS "lastRunStatus",
        silence_alert_open AS "silenceAlertOpen",
        to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
        active_run_id::text AS "activeRunId",
        last_completion_outcome AS "lastCompletionOutcome",
        last_fully_successful_at::text AS "lastFullySuccessfulAt",
        progress_at::text AS "progressAt",
        progress_phase AS "progressPhase",
        phase_started_at::text AS "phaseStartedAt"
      FROM curated.bron_health
      WHERE bron_id = ${bronId}
    `;
    expect(health).toEqual({
      activeRunId: null,
      bronId,
      circuitStatus: "open",
      lastCompletionOutcome: null,
      lastFullySuccessfulAt: null,
      lastRunAt: "2026-09-19T10:00:00.000Z",
      lastRunStatus: "failed",
      phaseStartedAt: null,
      progressAt: null,
      progressPhase: null,
      silenceAlertOpen: true,
      updatedAt: "2026-09-19T10:01:00.000Z",
    });

    const [runtimeCount] = await client<{ count: string }[]>`
      SELECT count(*)::text AS count FROM curated.poller_runtime
    `;
    expect(runtimeCount?.count).toBe("0");

    const constraints = await client<{ name: string; validated: boolean }[]>`
      SELECT conname AS name, convalidated AS validated
      FROM pg_constraint
      WHERE conrelid = 'curated.bron_health'::regclass
        AND conname IN (
        'bron_health_active_run_fk',
        'bron_health_progress_phase_check',
        'bron_health_completion_outcome_check'
      )
      ORDER BY conname
    `;
    expect([...constraints]).toEqual([
      { name: "bron_health_active_run_fk", validated: true },
      { name: "bron_health_completion_outcome_check", validated: true },
      { name: "bron_health_progress_phase_check", validated: true },
    ]);
  });
});
