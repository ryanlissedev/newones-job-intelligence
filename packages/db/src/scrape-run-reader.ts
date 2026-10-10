import type {
  ScrapeRunCheckpoint,
  ScrapeRunListQuery,
  ScrapeRunObservationDistribution,
  ScrapeRunReader,
  ScrapeRunView,
} from "@ji/application/registry";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

import type * as schema from "./schema";

export type ScrapeRunDatabase = PostgresJsDatabase<typeof schema>;

type ScrapeRunCheckpointInput = Readonly<
  Record<string, string | number | boolean | null>
>;

interface ScrapeRunRow extends Record<string, unknown> {
  readonly aantal_gevonden: number;
  readonly bron_id: string;
  readonly checkpoint: ScrapeRunCheckpointInput | null;
  readonly circuit_status: string;
  readonly created_at: string;
  readonly failure_class: string | null;
  readonly failure_code: string | null;
  readonly failure_message: string | null;
  readonly failure_phase: string | null;
  readonly fouten: number;
  readonly geindigd: string | null;
  readonly gesloten: number;
  readonly gestart: string;
  readonly gewijzigd: number;
  readonly id: string;
  readonly nieuw: number;
  readonly rejected: number;
  readonly run_kind: "backfill" | "poll" | "test";
  readonly status: string;
  readonly versie_adapter: string | null;
}

const EMPTY_LIFECYCLE = {
  incremented: 0,
  reopened: 0,
  reset: 0,
  staled: 0,
} as const;

const EMPTY_OBSERVATIONS: ScrapeRunObservationDistribution = {
  created: 0,
  rejected: 0,
  unchanged: 0,
  updated: 0,
};

const checkpointSchema = z
  .object({
    cursor: z.union([z.string(), z.number()]).optional(),
    hasMore: z.boolean().optional(),
    offset: z.number().optional(),
    page: z.number().optional(),
  })
  .strip();

const mapRow = (row: ScrapeRunRow): ScrapeRunView => {
  const parsedCheckpoint = checkpointSchema.safeParse(row.checkpoint);
  const checkpoint: ScrapeRunCheckpoint | null = parsedCheckpoint.success
    ? parsedCheckpoint.data
    : null;
  return {
    aantalGevonden: row.aantal_gevonden,
    bronId: row.bron_id,
    checkpoint,
    circuitStatus: row.circuit_status,
    createdAt: new Date(row.created_at),
    failureClass: row.failure_class,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    failurePhase: row.failure_phase,
    fouten: row.fouten,
    geindigd: row.geindigd ? new Date(row.geindigd) : null,
    gesloten: row.gesloten,
    gestart: new Date(row.gestart),
    gewijzigd: row.gewijzigd,
    id: row.id,
    lifecycleSummary: EMPTY_LIFECYCLE,
    nieuw: row.nieuw,
    observationDistribution: EMPTY_OBSERVATIONS,
    rejected: row.rejected,
    runKind: row.run_kind,
    status: row.status,
    versieAdapter: row.versie_adapter,
  };
};

const encodeCursor = (gestart: Date, id: string): string =>
  `${gestart.toISOString()}|${id}`;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const decodeCursor = (
  cursor: string | undefined
): { gestart: Date; id: string } | null => {
  if (!cursor) {
    return null;
  }
  const separator = cursor.indexOf("|");
  if (separator <= 0) {
    return null;
  }
  const gestartRaw = cursor.slice(0, separator);
  const id = cursor.slice(separator + 1);
  const gestart = new Date(gestartRaw);
  if (Number.isNaN(gestart.getTime()) || !UUID_RE.test(id)) {
    return null;
  }
  return { gestart, id };
};

interface ObservationAggRow extends Record<string, unknown> {
  readonly created: number | string;
  readonly rejected: number | string;
  readonly scrape_run_id: string;
  readonly unchanged: number | string;
  readonly updated: number | string;
}

const toCount = (value: number | string): number =>
  Number.isFinite(Number(value)) ? Number(value) : 0;

const loadObservationDistributions = async (
  database: ScrapeRunDatabase,
  runIds: readonly string[]
): Promise<Map<string, ScrapeRunObservationDistribution>> => {
  const result = new Map<string, ScrapeRunObservationDistribution>();
  if (runIds.length === 0) {
    return result;
  }
  const rows = await database.execute<ObservationAggRow>(sql`
    SELECT
      o.scrape_run_id,
      count(*) FILTER (WHERE o.outcome = 'new') AS created,
      count(*) FILTER (WHERE o.outcome = 'changed') AS updated,
      count(*) FILTER (WHERE o.outcome = 'unchanged') AS unchanged,
      0::int AS rejected
    FROM staging.aanvraag_observation o
    WHERE o.scrape_run_id IN (${sql.join(
      runIds.map((id) => sql`${id}::uuid`),
      sql`, `
    )})
    GROUP BY o.scrape_run_id
  `);
  for (const row of rows) {
    result.set(row.scrape_run_id, {
      created: toCount(row.created),
      rejected: toCount(row.rejected),
      unchanged: toCount(row.unchanged),
      updated: toCount(row.updated),
    });
  }
  return result;
};

const withObservations = (
  run: ScrapeRunView,
  distributions: Map<string, ScrapeRunObservationDistribution>
): ScrapeRunView => ({
  ...run,
  observationDistribution: distributions.get(run.id) ?? EMPTY_OBSERVATIONS,
});

export class PostgresScrapeRunReader implements ScrapeRunReader {
  private readonly database: ScrapeRunDatabase;

  constructor(database: ScrapeRunDatabase) {
    this.database = database;
  }

  async getById(id: string): Promise<ScrapeRunView | null> {
    const rows = await this.database.execute<ScrapeRunRow>(sql`
      SELECT
        id,
        bron_id,
        status,
        run_kind,
        gestart,
        geindigd,
        created_at,
        aantal_gevonden,
        nieuw,
        gewijzigd,
        rejected,
        gesloten,
        fouten,
        failure_phase,
        failure_class,
        failure_code,
        failure_message,
        circuit_status,
        checkpoint,
        versie_adapter
      FROM curated.scrape_run
      WHERE id = ${id}::uuid
      LIMIT 1
    `);
    const [row] = rows;
    if (!row) {
      return null;
    }
    const distributions = await loadObservationDistributions(this.database, [
      row.id,
    ]);
    return withObservations(mapRow(row), distributions);
  }

  async list(query: ScrapeRunListQuery): Promise<{
    readonly items: readonly ScrapeRunView[];
    readonly nextCursor: string | null;
  }> {
    const limit = query.limit ?? 50;
    const predicates: SQL[] = [];
    if (query.bronId) {
      predicates.push(sql`bron_id = ${query.bronId}::uuid`);
    }
    if (query.status) {
      predicates.push(sql`status = ${query.status}`);
    }
    if (query.failureCode) {
      predicates.push(sql`failure_code = ${query.failureCode}`);
    }
    if (query.runKind && query.runKind !== "all") {
      predicates.push(sql`run_kind = ${query.runKind}`);
    }
    if (query.since) {
      predicates.push(
        sql`gestart >= ${query.since.toISOString()}::timestamptz`
      );
    }
    const cursor = decodeCursor(query.cursor);
    if (cursor) {
      predicates.push(
        sql`(gestart, id) < (${cursor.gestart.toISOString()}::timestamptz, ${cursor.id}::uuid)`
      );
    }
    const whereClause =
      predicates.length === 0
        ? sql``
        : sql`WHERE ${sql.join(predicates, sql` AND `)}`;
    const rows = await this.database.execute<ScrapeRunRow>(sql`
      SELECT
        id,
        bron_id,
        status,
        run_kind,
        gestart,
        geindigd,
        created_at,
        aantal_gevonden,
        nieuw,
        gewijzigd,
        rejected,
        gesloten,
        fouten,
        failure_phase,
        failure_class,
        failure_code,
        failure_message,
        circuit_status,
        checkpoint,
        versie_adapter
      FROM curated.scrape_run
      ${whereClause}
      ORDER BY gestart DESC, id DESC
      LIMIT ${limit + 1}
    `);
    const mapped = rows.map(mapRow);
    const page = mapped.slice(0, limit);
    const distributions = await loadObservationDistributions(
      this.database,
      page.map((run) => run.id)
    );
    const items = page.map((run) => withObservations(run, distributions));
    const last = items.at(-1);
    const nextCursor =
      mapped.length > items.length && last
        ? encodeCursor(last.gestart, last.id)
        : null;
    return { items, nextCursor };
  }
}
