#!/usr/bin/env bun
/**
 * RJC-369: one-off cleanup of the residue that accumulated in the shared
 * `ji_test` database before test isolation (tools/postgres/test-isolation.ts)
 * shipped — 2,633 curated.search_projection_checkpoint rows (799
 * `test-index-*`, 1,383 `drain-*` as re-measured 2026-09-01; the ticket's
 * original count was 1,461) and 1,239 staging.source_record rows belonging
 * to `runtime-test` bron fixtures.
 *
 * This is deliberately separate from the isolation fix itself: isolation
 * stops FUTURE residue; this tool removes the residue that already exists,
 * so the two changes can be reviewed independently, per RJC-369's request.
 *
 * Dry-run by default — prints what WOULD be deleted and exits 0 without
 * touching the database. Pass --apply to actually delete.
 *
 * Usage:
 *   bun tools/postgres/clean-test-residue.ts             # dry run (default)
 *   bun tools/postgres/clean-test-residue.ts --apply     # actually delete
 */
import postgres from "postgres";

const apply = process.argv.includes("--apply");

const adminUser = process.env.POSTGRES_ADMIN_USER ?? "ji_admin";
const adminPassword = process.env.POSTGRES_ADMIN_PASSWORD ?? "ji_admin_local";
const hostPort = Number(process.env.POSTGRES_HOST_PORT ?? "5432");
const databaseName = process.env.POSTGRES_DB ?? "ji_test";

const client = postgres({
  connect_timeout: 3,
  database: databaseName,
  host: "127.0.0.1",
  max: 1,
  password: adminPassword,
  port: hostPort,
  username: adminUser,
});

// Table existence, not table content: to_regclass returns NULL for a
// relation that doesn't exist and never throws. An unmigrated database
// (e.g. a fresh CI runner's ji_test, now that isolation runs migrations
// against the per-process database instead) has nothing to clean.
const tableExists = async (qualifiedName: string): Promise<boolean> => {
  const [row] = await client`SELECT to_regclass(${qualifiedName}) AS relation`;
  return row?.relation !== null;
};

try {
  const [checkpointTable, sourceRecordTable, bronTable] = await Promise.all([
    tableExists("curated.search_projection_checkpoint"),
    tableExists("staging.source_record"),
    tableExists("curated.bron"),
  ]);

  if (!(checkpointTable && sourceRecordTable && bronTable)) {
    console.log(
      `clean-test-residue: database '${databaseName}' is not migrated (residue tables absent) -- nothing to clean.`
    );
    await client.end({ timeout: 3 });
    process.exit(0);
  }

  const [checkpointCount] = await client`
    SELECT count(*)::int AS n
    FROM curated.search_projection_checkpoint
    WHERE index_name LIKE 'test-index-%' OR index_name LIKE 'drain-%'
  `;
  const [sourceRecordCount] = await client`
    SELECT count(*)::int AS n
    FROM staging.source_record AS source_record
    JOIN curated.bron AS bron ON bron.id = source_record.bron_id
    WHERE bron.categorie = 'runtime-test'
  `;
  const [bronCount] = await client`
    SELECT count(*)::int AS n FROM curated.bron WHERE categorie = 'runtime-test'
  `;

  console.log(
    `clean-test-residue: found ${checkpointCount?.n ?? 0} search_projection_checkpoint row(s) ` +
      `(test-index-*/drain-*), ${sourceRecordCount?.n ?? 0} source_record row(s), and ` +
      `${bronCount?.n ?? 0} bron row(s) (categorie='runtime-test') in database '${databaseName}'`
  );

  if (apply) {
    await client.begin(async (transaction) => {
      // curated.bron -> curated.aanvraag is ON DELETE RESTRICT (a bron with
      // real aanvraag rows must not be deleted by a fixture-cleanup tool),
      // so this fails loudly instead of cascading past it. Everything else
      // hanging off bron (scrape_run, source_record, aanvraag_bron_link,
      // aanvraag_observation) is ON DELETE CASCADE.
      const deletedCheckpoints = await transaction`
        DELETE FROM curated.search_projection_checkpoint
        WHERE index_name LIKE 'test-index-%' OR index_name LIKE 'drain-%'
      `;
      const deletedBron = await transaction`
        DELETE FROM curated.bron WHERE categorie = 'runtime-test'
      `;
      console.log(
        `clean-test-residue: deleted ${deletedCheckpoints.count} search_projection_checkpoint row(s) ` +
          `and ${deletedBron.count} bron row(s) (cascading to their source_record/scrape_run/aanvraag_bron_link/aanvraag_observation rows).`
      );
    });
  } else {
    console.log(
      "clean-test-residue: dry run — pass --apply to delete. No changes made."
    );
  }
} finally {
  await client.end({ timeout: 3 });
}
