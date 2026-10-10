import postgres from "postgres";
import { z } from "zod";

import type { JsonValue } from "../normalise";
import {
  liftEducationLevelFromRoot,
  liftNestedRateBoundsFromRoot,
} from "./motian-commercial-fields";
import {
  MOTIAN_V1_SOURCE_PLATFORMS,
  normalizeMotianPlatform,
  sourcePlatformsForMotianV1,
} from "./motian-v1-bindings";
import { resolveMotianDatabaseUrl, sourceFieldsSchema } from "./neon-v1";
import type {
  BackfillScope,
  NeonV1JobRow,
  NeonV1Source,
} from "./neon-v1-types";

const DEFAULT_BATCH_SIZE = 1000;

interface MotianReadOnlyPrivileges {
  can_delete_jobs: boolean | null;
  can_insert_jobs: boolean | null;
  can_insert_jobs_columns: boolean | null;
  can_select_jobs: boolean | null;
  can_truncate_jobs: boolean | null;
  can_update_jobs: boolean | null;
  can_update_jobs_columns: boolean | null;
}

interface MotianTransactionState {
  transaction_read_only: string | null;
}

interface MotianSnapshotClock {
  snapshot_completed_at?: Date | string;
  snapshot_started_at?: Date | string;
}

export interface MotianNeonV1SourceOptions {
  readonly batchSize?: number;
  readonly databaseUrl?: string;
  /** @deprecated Use `scope: "full"` for the production migration contract. */
  readonly includeClosed?: boolean;
  readonly platforms?: readonly string[];
  readonly scope?: BackfillScope;
}

/**
 * Test seam for the Motian adapter. Production always uses the default
 * postgres.js client; callers must not use this to substitute another source.
 */
export interface MotianNeonV1SourceDependencies {
  readonly createSqlClient?: (databaseUrl: string) => postgres.Sql;
}

interface MotianJobRow {
  application_deadline: string | null;
  archived_at: string | null;
  allows_subcontracting?: boolean | null;
  company: string | null;
  contract_type: string | null;
  competences?: JsonValue | null;
  deleted_at: string | null;
  description: string | null;
  end_client: string | null;
  external_id: string;
  end_date?: string | null;
  external_url: string | null;
  id: string;
  extension_possible?: boolean | null;
  education_level?: string | null;
  hours_per_week?: number | null;
  location: string | null;
  platform: string;
  min_hours_per_week?: number | null;
  province: string | null;
  positions_available?: number | null;
  rate_max: number | string | null;
  rate_min: number | string | null;
  posted_at: string | null;
  scraped_at: string | null;
  requirements?: JsonValue | null;
  source_row: Record<string, JsonValue>;
  start_date: string | null;
  status: string | null;
  title: string;
  wishes?: JsonValue | null;
  work_arrangement?: string | null;
  work_experience_years?: number | null;
}

/** Motian stores legacy timestamps without a timezone. The historical data and
 * checked fixtures use UTC wall-clock values, so SQL returns text and this
 * adapter applies UTC explicitly instead of letting the process timezone move
 * dates while postgres.js parses OID 1114. */
const toNumberOrNull = (
  value: number | string | null | undefined
): number | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const toIsoString = (value: string | null): string | null => {
  if (value === null) {
    return null;
  }
  const isoValue = value.includes("T") ? value : value.replace(" ", "T");
  const zonedValue = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/u.test(isoValue)
    ? isoValue
    : `${isoValue}Z`;
  return new Date(zonedValue).toISOString();
};

const toIsoStringOrNull = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  try {
    return toIsoString(value);
  } catch {
    return null;
  }
};

const mapMotianRow = (row: MotianJobRow): NeonV1JobRow => {
  const endDate = toIsoStringOrNull(row.end_date);
  return {
    allows_subcontracting: row.allows_subcontracting,
    application_deadline: toIsoString(row.application_deadline),
    archived_at: toIsoString(row.archived_at),
    company: row.company,
    competences: row.competences,
    contract_type: row.contract_type,
    deleted_at: toIsoString(row.deleted_at),
    description: row.description,
    education_level: row.education_level,
    end_client: row.end_client,
    end_date: endDate,
    extension_possible: row.extension_possible,
    external_id: row.external_id,
    external_url: row.external_url,
    hours_per_week: row.hours_per_week,
    id: row.id,
    location: row.location,
    min_hours_per_week: row.min_hours_per_week,
    platform: normalizeMotianPlatform(row.platform),
    positions_available: row.positions_available,
    posted_at: toIsoString(row.posted_at),
    province: row.province,
    rate_max: toNumberOrNull(row.rate_max),
    rate_min: toNumberOrNull(row.rate_min),
    requirements: row.requirements,
    scraped_at: toIsoString(row.scraped_at),
    sourceRow: row.source_row,
    start_date: toIsoString(row.start_date),
    status: row.status,
    title: row.title,
    wishes: row.wishes,
    work_arrangement: row.work_arrangement,
    work_experience_years: row.work_experience_years,
  };
};

const nullableString = z.string().nullable();
const rawMotianV1RootSchema = z.record(z.string(), z.unknown());
const rawJsonValue = z.json();
/* oxlint-disable promise/prefer-await-to-then -- Zod catches synchronously preserve malformed optional source fields. */
const rawMotianV1JobSchema = z.object({
  allows_subcontracting: z.boolean().nullable().optional().catch(null),
  application_deadline: nullableString,
  archived_at: nullableString,
  company: nullableString,
  competences: rawJsonValue.nullable().optional().catch(null),
  contract_type: nullableString,
  deleted_at: nullableString,
  description: nullableString,
  education_level: nullableString.optional().catch(null),
  end_client: nullableString,
  end_date: nullableString.optional().catch(null),
  extension_possible: z.boolean().nullable().optional().catch(null),
  external_id: z.string().min(1),
  external_url: nullableString,
  hours_per_week: z.number().nullable().optional().catch(null),
  id: z.string().min(1),
  location: nullableString,
  min_hours_per_week: z.number().nullable().optional().catch(null),
  platform: z.string().min(1),
  positions_available: z.number().nullable().optional().catch(null),
  posted_at: nullableString,
  province: nullableString,
  rate_max: z.union([z.number(), z.string()]).nullable(),
  rate_min: z.union([z.number(), z.string()]).nullable(),
  requirements: rawJsonValue.nullable().optional().catch(null),
  scraped_at: nullableString,
  start_date: nullableString,
  status: nullableString,
  title: z.string().min(1),
  wishes: rawJsonValue.nullable().optional().catch(null),
  work_arrangement: nullableString.optional().catch(null),
  work_experience_years: z.number().nullable().optional().catch(null),
});
/* oxlint-enable promise/prefer-await-to-then */

/**
 * Decodes the exact JSON object written by the Motian v1 backfill. The raw
 * object is an immutable `to_jsonb(jobs)` row, rather than the projection
 * returned by the source query, so this reconstructs that projection without
 * requiring another Motian connection. It requires every column selected by
 * the original adapter and rejects native `{ job: ... }` roots. Unknown
 * columns remain permitted because `to_jsonb(jobs)` preserves the complete
 * Motian row, including columns outside the adapter projection. Keep the UTC
 * coercion aligned with {@link mapMotianRow}: historical timestamp columns
 * are timezone-less.
 */
export const decodeMotianV1RawRow = (body: Uint8Array): NeonV1JobRow => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new TypeError("Motian raw object is not valid JSON");
  }
  const root = rawMotianV1RootSchema.safeParse(parsed);
  if (!root.success || Object.hasOwn(root.data, "job")) {
    throw new TypeError("Motian raw object has an invalid root schema");
  }
  const row = rawMotianV1JobSchema.parse(root.data);
  const sourceRow = sourceFieldsSchema.parse(root.data);
  const rateMin = toNumberOrNull(row.rate_min);
  const rateMax = toNumberOrNull(row.rate_max);
  const liftedRates = liftNestedRateBoundsFromRoot(root.data, rateMin, rateMax);
  const educationLevel = liftEducationLevelFromRoot(
    root.data,
    row.education_level ?? null
  );
  return mapMotianRow({
    ...row,
    education_level: educationLevel,
    rate_max: liftedRates.max,
    rate_min: liftedRates.min,
    source_row: sourceRow,
  });
};

/**
 * Checks the effective role on the transaction which will perform the source
 * query. This deliberately does not infer authority from the connection URL:
 * URL names are not a database authorization boundary.
 */
export const assertReadOnlyMotianAccess = async (
  sql: postgres.TransactionSql
): Promise<void> => {
  const [privileges] = await sql<MotianReadOnlyPrivileges[]>`
    SELECT
      has_table_privilege(current_user, 'jobs', 'SELECT') AS can_select_jobs,
      has_table_privilege(current_user, 'jobs', 'INSERT') AS can_insert_jobs,
      has_any_column_privilege(current_user, 'jobs', 'INSERT') AS can_insert_jobs_columns,
      has_table_privilege(current_user, 'jobs', 'UPDATE') AS can_update_jobs,
      has_any_column_privilege(current_user, 'jobs', 'UPDATE') AS can_update_jobs_columns,
      has_table_privilege(current_user, 'jobs', 'DELETE') AS can_delete_jobs,
      has_table_privilege(current_user, 'jobs', 'TRUNCATE') AS can_truncate_jobs
  `;

  if (privileges?.can_select_jobs !== true) {
    throw new Error("Motian source role must have SELECT privilege on jobs");
  }

  const writePrivileges = [
    ["INSERT", privileges.can_insert_jobs],
    ["column INSERT", privileges.can_insert_jobs_columns],
    ["UPDATE", privileges.can_update_jobs],
    ["column UPDATE", privileges.can_update_jobs_columns],
    ["DELETE", privileges.can_delete_jobs],
    ["TRUNCATE", privileges.can_truncate_jobs],
  ] as const;
  const [privilege] =
    writePrivileges.find(([, granted]) => granted !== false) ?? [];
  if (privilege) {
    throw new Error(
      `Motian source role must not have ${privilege} privilege on jobs`
    );
  }
};

const assertReadOnlyMotianTransaction = async (
  sql: postgres.TransactionSql
): Promise<void> => {
  const [state] = await sql<MotianTransactionState[]>`
    SHOW transaction_read_only
  `;
  if (state?.transaction_read_only !== "on") {
    throw new Error("Motian source transaction must be read-only");
  }
  await assertReadOnlyMotianAccess(sql);
};

const createMotianSqlClient = (databaseUrl: string): postgres.Sql =>
  postgres(databaseUrl, {
    connect_timeout: 10,
    // The destination write/readback for one source batch can take longer
    // than a normal query idle window while the source snapshot stays open.
    idle_timeout: 0,
    max: 1,
    max_lifetime: null,
  });

export const createMotianNeonV1Source = (
  options: MotianNeonV1SourceOptions = {},
  dependencies: MotianNeonV1SourceDependencies = {}
): NeonV1Source => {
  const databaseUrl = options.databaseUrl ?? resolveMotianDatabaseUrl();
  if (!databaseUrl) {
    throw new Error(
      "MOTIAN_DATABASE_URL is required for the Motian Neon v1 source"
    );
  }

  const platforms = options.platforms
    ? sourcePlatformsForMotianV1(options.platforms)
    : [...MOTIAN_V1_SOURCE_PLATFORMS];
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const scope = options.scope ?? "active";
  const includeClosed = options.includeClosed ?? false;
  const sql = (dependencies.createSqlClient ?? createMotianSqlClient)(
    databaseUrl
  );

  const loadRows = async (
    readOnlySql: postgres.TransactionSql,
    afterId: string | null,
    size: number
  ): Promise<MotianJobRow[]> => {
    if (scope === "full") {
      const rows = await readOnlySql<MotianJobRow[]>`
          SELECT
            to_jsonb(jobs) AS source_row,
            id::text AS id,
            platform,
            external_id,
            external_url,
            title,
            description,
            education_level,
            company,
            end_client,
            location,
            province,
            contract_type,
            rate_min,
            rate_max,
            status,
            archived_at::text AS archived_at,
            deleted_at::text AS deleted_at,
            application_deadline::text AS application_deadline,
            start_date::text AS start_date,
            posted_at::text AS posted_at,
            scraped_at::text AS scraped_at,
            work_arrangement,
            hours_per_week,
            min_hours_per_week,
            requirements,
            wishes,
            competences,
            positions_available,
            work_experience_years,
            allows_subcontracting,
            extension_possible,
            end_date::text AS end_date
          FROM jobs
          WHERE platform = ANY(${platforms})
            ${afterId === null ? sql`` : sql`AND id > ${afterId}`}
          ORDER BY id ASC
          LIMIT ${size}
        `;
      return rows;
    }

    if (includeClosed) {
      const rows = await readOnlySql<MotianJobRow[]>`
          SELECT
            to_jsonb(jobs) AS source_row,
            id::text AS id,
            platform,
            external_id,
            external_url,
            title,
            description,
            education_level,
            company,
            end_client,
            location,
            province,
            contract_type,
            rate_min,
            rate_max,
            status,
            archived_at::text AS archived_at,
            deleted_at::text AS deleted_at,
            application_deadline::text AS application_deadline,
            start_date::text AS start_date,
            posted_at::text AS posted_at,
            scraped_at::text AS scraped_at,
            work_arrangement,
            hours_per_week,
            min_hours_per_week,
            requirements,
            wishes,
            competences,
            positions_available,
            work_experience_years,
            allows_subcontracting,
            extension_possible,
            end_date::text AS end_date
          FROM jobs
          WHERE platform = ANY(${platforms})
            AND deleted_at IS NULL
            AND archived_at IS NULL
            ${afterId === null ? sql`` : sql`AND id > ${afterId}`}
          ORDER BY id ASC
          LIMIT ${size}
        `;
      return rows;
    }

    const rows = await readOnlySql<MotianJobRow[]>`
          SELECT
            to_jsonb(jobs) AS source_row,
            id::text AS id,
            platform,
            external_id,
            external_url,
            title,
            description,
            education_level,
            company,
            end_client,
            location,
            province,
            contract_type,
            rate_min,
            rate_max,
            status,
            archived_at::text AS archived_at,
            deleted_at::text AS deleted_at,
            application_deadline::text AS application_deadline,
            start_date::text AS start_date,
            posted_at::text AS posted_at,
            scraped_at::text AS scraped_at,
            work_arrangement,
            hours_per_week,
            min_hours_per_week,
            requirements,
            wishes,
            competences,
            positions_available,
            work_experience_years,
            allows_subcontracting,
            extension_possible,
            end_date::text AS end_date
          FROM jobs
          WHERE platform = ANY(${platforms})
            AND deleted_at IS NULL
            AND archived_at IS NULL
            AND status = 'open'
            ${afterId === null ? sql`` : sql`AND id > ${afterId}`}
          ORDER BY id ASC
          LIMIT ${size}
        `;
    return rows;
  };

  const consumeSnapshot = async (
    size: number,
    consume: (batch: readonly NeonV1JobRow[]) => Promise<void>
  ) => {
    try {
      // One transaction spans the complete keyset walk. REPEATABLE READ
      // prevents inserts/deletes during a long migration from changing the
      // selected source ID-set between batches while memory stays bounded.
      return await sql.begin(
        "isolation level repeatable read read only",
        async (readOnlySql) => {
          await assertReadOnlyMotianTransaction(readOnlySql);
          const [startClock] = await readOnlySql<MotianSnapshotClock[]>`
            SELECT transaction_timestamp() AS snapshot_started_at
          `;
          if (!startClock?.snapshot_started_at) {
            throw new Error("Motian source snapshot start heartbeat failed");
          }
          let afterId: string | null = null;
          for (;;) {
            /* oxlint-disable no-await-in-loop -- keyset pagination and the consumer are deliberately sequential inside one snapshot */
            const rows = await loadRows(readOnlySql, afterId, size);
            const batch = rows.map(mapMotianRow);
            if (batch.length === 0) {
              break;
            }
            await consume(batch);
            /* oxlint-enable no-await-in-loop */
            const lastId = batch.at(-1)?.id;
            if (!lastId || batch.length < size) {
              break;
            }
            afterId = lastId;
          }
          const [endClock] = await readOnlySql<MotianSnapshotClock[]>`
            SELECT clock_timestamp() AS snapshot_completed_at
          `;
          if (!endClock?.snapshot_completed_at) {
            throw new Error("Motian source snapshot end heartbeat failed");
          }
          return {
            completedAt: new Date(endClock.snapshot_completed_at).toISOString(),
            startedAt: new Date(startClock.snapshot_started_at).toISOString(),
          };
        }
      );
    } finally {
      await sql.end({ timeout: 5 });
    }
  };

  return {
    consumeSnapshot,
    label: "motian-neon",
    loadJobs: async () => {
      const jobs: NeonV1JobRow[] = [];
      await consumeSnapshot(batchSize, (batch) => {
        jobs.push(...batch);
        return Promise.resolve();
      });
      return jobs;
    },
  };
};
