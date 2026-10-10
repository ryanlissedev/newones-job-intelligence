import postgres from "postgres";

import { requireMigrationDatabaseUrl } from "./migration-database-url";
import { redactConnectionUrls } from "./redact-connection-urls";

/**
 * Schemas the migrator owns. Every relation in them must be owned by the
 * migration role (or a role it is a member of): ALTER TABLE, CREATE INDEX and
 * DROP all require ownership, so a table created by an admin role makes the
 * next migration that touches it fail halfway through Drizzle's transaction
 * (production incident 2026-10-09, migration 0031: tables owned by `postgres`).
 */
export const MIGRATOR_OWNED_SCHEMAS = [
  "public",
  "staging",
  "curated",
  "marts",
  "drizzle",
] as const;

export interface ForeignOwnedRelation {
  readonly schema: string;
  readonly name: string;
  readonly kind: string;
  readonly owner: string;
}

export interface OwnershipPreflightResult {
  readonly migrationRole: string;
  readonly foreignOwned: readonly ForeignOwnedRelation[];
}

const RELKIND_LABELS = {
  S: "sequence",
  f: "foreign table",
  m: "materialized view",
  p: "partitioned table",
  r: "table",
  v: "view",
} as const satisfies Record<string, string>;

const relkindLabel = (relkind: string): string => {
  if (!Object.hasOwn(RELKIND_LABELS, relkind)) {
    return relkind;
  }
  // SAFETY: Object.hasOwn just proved relkind is one of the label keys.
  return RELKIND_LABELS[relkind as keyof typeof RELKIND_LABELS];
};

type Sql = ReturnType<typeof postgres>;

/**
 * Lists relations in the migrator-owned schemas whose owner the current role
 * cannot act as. Extension members (e.g. objects created by CREATE EXTENSION)
 * are excluded: they are owned by the extension, not by migrations. Read-only.
 */
export const findForeignOwnedRelations = async (
  sql: Sql,
  schemas: readonly string[] = MIGRATOR_OWNED_SCHEMAS
): Promise<OwnershipPreflightResult> => {
  const [roleRow] = await sql<
    { migration_role: string }[]
  >`SELECT current_user::text AS migration_role`;
  const migrationRole = roleRow?.migration_role ?? "unknown";

  const rows = await sql<
    { schema: string; name: string; relkind: string; owner: string }[]
  >`
    SELECT n.nspname::text AS schema,
           c.relname::text AS name,
           c.relkind::text AS relkind,
           pg_get_userbyid(c.relowner)::text AS owner
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ANY(${[...schemas]}::text[])
       AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
       AND NOT pg_has_role(current_user, c.relowner, 'MEMBER')
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend d
          WHERE d.classid = 'pg_class'::regclass
            AND d.objid = c.oid
            AND d.deptype = 'e'
       )
     ORDER BY n.nspname, c.relname
  `;

  return {
    foreignOwned: rows.map((row) => ({
      kind: relkindLabel(row.relkind),
      name: row.name,
      owner: row.owner,
      schema: row.schema,
    })),
    migrationRole,
  };
};

const MAX_LISTED = 25;

export const formatOwnershipFailure = (
  result: OwnershipPreflightResult
): string => {
  const listed = result.foreignOwned
    .slice(0, MAX_LISTED)
    .map(
      (relation) =>
        `  - ${relation.schema}.${relation.name} (${relation.kind}, owner ${relation.owner})`
    );
  const more =
    result.foreignOwned.length > MAX_LISTED
      ? [`  ... and ${result.foreignOwned.length - MAX_LISTED} more`]
      : [];
  const owners = [
    ...new Set(result.foreignOwned.map((relation) => relation.owner)),
  ].join(", ");
  return [
    `migration preflight failed: ${result.foreignOwned.length} relation(s) in the app schemas are not owned by the migration role "${result.migrationRole}" (found owners: ${owners}).`,
    "Migrations that ALTER, index or drop these objects would fail with 'must be owner of table' and roll back.",
    ...listed,
    ...more,
    "Fix (as an admin/superuser, once per object, no data change):",
    `  ALTER TABLE <schema>.<name> OWNER TO ${result.migrationRole};   -- ALTER SEQUENCE / ALTER VIEW / ALTER MATERIALIZED VIEW for other kinds`,
    `or, for everything owned by one role: REASSIGN OWNED BY <owner> TO ${result.migrationRole}; (only for a non-superuser <owner> that owns nothing else in this database; never for postgres).`,
    "No migration was applied.",
  ].join("\n");
};

/** Server NOTICEs (none expected from catalog reads) must not reach migrator logs. */
const ignoreNotice = (): void => undefined;

export const runOwnershipPreflight = async (
  databaseUrl: string
): Promise<OwnershipPreflightResult> => {
  const sql = postgres(databaseUrl, {
    connect_timeout: 10,
    max: 1,
    onnotice: ignoreNotice,
  });
  try {
    await sql`SET statement_timeout = '15s'`;
    return await findForeignOwnedRelations(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
};

if (import.meta.main) {
  const { default: dotenv } = await import("dotenv");
  dotenv.config({ path: "../../apps/server/.env", quiet: true });
  try {
    const result = await runOwnershipPreflight(requireMigrationDatabaseUrl());
    if (result.foreignOwned.length > 0) {
      console.error(formatOwnershipFailure(result));
      process.exit(1);
    }
    console.log(
      `migration preflight ok: all app-schema relations are owned by "${result.migrationRole}"`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `migration preflight could not run: ${redactConnectionUrls(message)}`
    );
    process.exit(1);
  }
}
