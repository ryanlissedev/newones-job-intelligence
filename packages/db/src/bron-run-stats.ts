import type {
  BronRunFailureCount,
  BronRunKindFilter,
  BronRunStatsQuery,
  BronRunStatsReader,
  BronRunStatsResult,
  BronRunStatsRow,
  BronRunTimeseriesBucket,
  BronRunTimeseriesPoint,
  BronRunTimeseriesQuery,
} from "@ji/application/registry";
import {
  BRON_RUN_STATS_TIME_ZONE,
  computeBronSuccessRate,
  resolveBronRunStatsSince,
} from "@ji/application/registry";
import { PARTIAL_RUN_COMPLETIONS } from "@ji/connectors";
import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type * as schema from "./schema";

export type BronRunStatsDatabase = PostgresJsDatabase<typeof schema>;

const TOP_FAILURES_LIMIT = 5;

/** `'budget_exhausted', 'aborted', 'truncated'`: module constants, never caller input. */
const PARTIAL_COMPLETIONS_SQL = sql.raw(
  PARTIAL_RUN_COMPLETIONS.map((completion) => `'${completion}'`).join(", ")
);

const DEFAULT_RUN_KIND: BronRunKindFilter = "poll";

/** Grand-total marker emitted by `GROUPING()` for the rolled-up row. */
const TOTAAL_GROUPING = 1;

/**
 * `curated.scrape_run` aggregated per source, as Postgres returns it over a raw
 * `execute`: counts and sums are cast to `integer`, timestamps arrive as text.
 *
 * The row types below extend `Record<string, unknown>` because that is the
 * constraint on Drizzle's `execute<TRow>`; declaring it is what lets the query
 * results be typed at the call site instead of cast afterwards.
 */
interface BronRunStatsAggregate extends Record<string, unknown> {
  readonly aantal_gevonden: number;
  readonly actief: boolean | null;
  readonly avg_duration_ms: number | null;
  readonly bron_id: string | null;
  readonly cancelled: number;
  readonly failed: number;
  readonly fouten: number;
  readonly gesloten: number;
  readonly gewijzigd: number;
  readonly interval: string | null;
  readonly is_totaal: number;
  readonly last_completion: string | null;
  readonly last_failure_class: string | null;
  readonly last_failure_code: string | null;
  readonly last_failure_kind: string | null;
  readonly last_failure_message: string | null;
  readonly last_failure_phase: string | null;
  readonly last_run_at: string | null;
  readonly last_run_status: string | null;
  readonly naam: string | null;
  readonly nieuw: number;
  readonly ongewijzigd: number;
  readonly onvolledig: number;
  readonly overgeslagen: number;
  readonly p95_duration_ms: number | null;
  readonly rejected: number;
  readonly runs: number;
  readonly running: number;
  readonly succeeded: number;
}

/** One `failure_code` and how often it occurred, per source and overall. */
interface BronRunFailureTally extends Record<string, unknown> {
  readonly bron_id: string | null;
  readonly code: string;
  readonly count: number;
  readonly is_totaal: number;
}

/** One time bucket of run activity for one source. */
interface BronRunTimeseriesBucketRow extends Record<string, unknown> {
  readonly aantal_gevonden: number;
  readonly avg_duration_ms: number | null;
  readonly bron_id: string;
  readonly bucket: string;
  readonly failed: number;
  readonly fouten: number;
  readonly gewijzigd: number;
  readonly nieuw: number;
  readonly ongewijzigd: number;
  readonly rejected: number;
  readonly runs: number;
  readonly succeeded: number;
}

/**
 * `run_kind = 'all'` is the absence of a predicate, not a value to compare
 * against. Legacy Motian imports are `backfill` runs; leaving them in the
 * default `poll` view would inflate every volume on the dashboard with a
 * one-off migration.
 */
const buildRunKindPredicate = (runKind: BronRunKindFilter): SQL =>
  runKind === "all" ? sql`` : sql` AND r.run_kind = ${runKind}`;

const buildBronPredicate = (
  column: SQL,
  bronIds: readonly string[] | undefined
): SQL => {
  if (bronIds === undefined || bronIds.length === 0) {
    return sql``;
  }
  const ids = sql.join(
    bronIds.map((id) => sql`${id}::uuid`),
    sql`, `
  );
  return sql` AND ${column} IN (${ids})`;
};

/**
 * Runs inside the window, with duration precomputed.
 *
 * `geindigd` is NULL for exactly the `running` runs (enforced by
 * `scrape_run_completion_check`), so `duur_ms` is NULL for them and `avg` and
 * `percentile_cont` skip them without needing a filter.
 *
 * `since` is bound as an ISO string with an explicit cast: a raw `execute`
 * hands parameters to postgres-js without Drizzle's column type information,
 * and a bare `Date` fails to serialise at Bind time.
 */
const buildWindowedRunsCte = (since: Date, runKind: BronRunKindFilter): SQL =>
  sql`
    windowed_runs AS (
      SELECT
        r.id,
        r.bron_id,
        r.status,
        r.gestart,
        r.aantal_gevonden,
        r.nieuw,
        r.gewijzigd,
        r.rejected,
        r.gesloten,
        r.fouten,
        r.failure_class,
        r.failure_code,
        r.failure_kind,
        r.completion,
        r.failure_message,
        r.outcome_counts,
        r.failure_phase,
        EXTRACT(EPOCH FROM (r.geindigd - r.gestart)) * 1000 AS duur_ms
      FROM curated.scrape_run r
      WHERE r.gestart >= ${since.toISOString()}::timestamptz${buildRunKindPredicate(runKind)}
    )
  `;

/**
 * `unchanged` per run.
 *
 * The counter lives in `staging.aanvraag_observation`, not on `scrape_run`, so
 * it is aggregated per run first and then joined. Aggregating before the join
 * keeps the run's own volume columns from being multiplied by its observation
 * count. Runs with no observations simply do not join, and `coalesce` turns
 * that into 0.
 */
const OBSERVATION_TOTALS_CTE = sql`
  observation_totals AS (
    SELECT
      o.scrape_run_id,
      count(*) FILTER (WHERE o.outcome = 'unchanged') AS ongewijzigd
    FROM staging.aanvraag_observation o
    WHERE o.scrape_run_id IN (SELECT id FROM windowed_runs)
    GROUP BY o.scrape_run_id
  )
`;

/** Latest value of a run column within the group, newest `gestart` first. */
const latestRunValue = (column: SQL): SQL =>
  sql`(array_agg(${column} ORDER BY r.gestart DESC) FILTER (WHERE r.id IS NOT NULL))[1]`;

/**
 * Most recent *failure*, which is not the same as the failure fields of the
 * most recent run. A source that failed three runs ago and has been running
 * since still needs to show why it failed; reading the newest run's envelope
 * would blank the reason the moment the next run starts.
 */
const latestFailureValue = (column: SQL): SQL =>
  sql`(array_agg(${column} ORDER BY r.gestart DESC) FILTER (WHERE r.failure_code IS NOT NULL))[1]`;

/**
 * Bucket expression, inlined rather than parameterised.
 *
 * Postgres treats every `$n` placeholder as its own expression, so a
 * parameterised `date_trunc` in the SELECT list does not match the textually
 * identical call in GROUP BY and the planner rejects the query. The unit is
 * narrowed to a two-value union first and the time zone is a module constant,
 * so nothing caller-controlled reaches the raw fragment.
 */
const buildBucketExpression = (bucket: BronRunTimeseriesBucket): SQL => {
  const unit: "day" | "hour" = bucket === "hour" ? "hour" : "day";
  return sql.raw(
    `(date_trunc('${unit}', r.gestart AT TIME ZONE '${BRON_RUN_STATS_TIME_ZONE}') AT TIME ZONE '${BRON_RUN_STATS_TIME_ZONE}')`
  );
};

/**
 * A raw `execute` bypasses Drizzle's column mapping, so `timestamptz` arrives
 * as a string rather than a `Date`. Convert at the boundary so callers get the
 * `Date` the read model's types promise.
 */
const toDate = (value: string | null): Date | null =>
  value === null ? null : new Date(value);

const isTotaalRow = (row: { readonly is_totaal: number }): boolean =>
  row.is_totaal === TOTAAL_GROUPING;

const toFailureKey = (bronId: string | null): string => bronId ?? "__totaal__";

const toStatsRow = (
  row: BronRunStatsAggregate,
  topFailures: readonly BronRunFailureCount[]
): BronRunStatsRow => {
  const totaal = isTotaalRow(row);
  return {
    aantalGevonden: row.aantal_gevonden,
    actief: totaal ? null : row.actief,
    avgDurationMs: row.avg_duration_ms,
    bronId: totaal ? null : row.bron_id,
    cancelled: row.cancelled,
    failed: row.failed,
    fouten: row.fouten,
    gesloten: row.gesloten,
    gewijzigd: row.gewijzigd,
    interval: totaal ? null : row.interval,
    lastCompletion: row.last_completion,
    lastFailureClass: row.last_failure_class,
    lastFailureCode: row.last_failure_code,
    lastFailureKind: row.last_failure_kind,
    lastFailureMessage: row.last_failure_message,
    lastFailurePhase: row.last_failure_phase,
    lastRunAt: toDate(row.last_run_at),
    lastRunStatus: row.last_run_status,
    naam: totaal ? null : row.naam,
    nieuw: row.nieuw,
    ongewijzigd: row.ongewijzigd,
    onvolledig: row.onvolledig,
    overgeslagen: row.overgeslagen,
    p95DurationMs: row.p95_duration_ms,
    rejected: row.rejected,
    running: row.running,
    runs: row.runs,
    succeeded: row.succeeded,
    successRate: computeBronSuccessRate({
      running: row.running,
      runs: row.runs,
      succeeded: row.succeeded,
    }),
    topFailures,
  };
};

const groupFailuresByBron = (
  rows: readonly BronRunFailureTally[]
): Map<string, BronRunFailureCount[]> => {
  const grouped = new Map<string, BronRunFailureCount[]>();
  for (const row of rows) {
    const key = toFailureKey(isTotaalRow(row) ? null : row.bron_id);
    const tallies = grouped.get(key) ?? [];
    if (tallies.length < TOP_FAILURES_LIMIT) {
      tallies.push({ code: row.code, count: row.count });
    }
    grouped.set(key, tallies);
  }
  return grouped;
};

export class PostgresBronRunStatsReader implements BronRunStatsReader {
  private readonly database: BronRunStatsDatabase;

  constructor(database: BronRunStatsDatabase) {
    this.database = database;
  }

  async bronRunStats(query: BronRunStatsQuery): Promise<BronRunStatsResult> {
    const runKind = query.runKind ?? DEFAULT_RUN_KIND;
    const since = resolveBronRunStatsSince(
      query.window,
      query.now ?? new Date()
    );

    // Sequential, not Promise.all: both statements share one pooled connection
    // and the aggregate is the expensive one, so overlapping them buys nothing.
    const aggregates = await this.selectAggregates(
      since,
      runKind,
      query.bronIds
    );
    const failures = await this.selectFailureTallies(
      since,
      runKind,
      query.bronIds
    );

    const failuresByBron = groupFailuresByBron(failures);
    const rows = aggregates.map((row) =>
      toStatsRow(
        row,
        failuresByBron.get(
          toFailureKey(isTotaalRow(row) ? null : row.bron_id)
        ) ?? []
      )
    );

    const totaal = rows.find((row) => row.bronId === null);
    if (totaal === undefined) {
      throw new Error(
        "bron_run_stats returned no totaal row; GROUPING SETS must always emit one"
      );
    }

    return {
      bronnen: rows.filter((row) => row.bronId !== null),
      runKind,
      since,
      totaal,
      window: query.window,
    };
  }

  async bronRunTimeseries(
    query: BronRunTimeseriesQuery
  ): Promise<readonly BronRunTimeseriesPoint[]> {
    const runKind = query.runKind ?? DEFAULT_RUN_KIND;
    const bucket: BronRunTimeseriesBucket = query.bucket ?? "day";
    const since = resolveBronRunStatsSince(
      query.window,
      query.now ?? new Date()
    );
    const truncated = buildBucketExpression(bucket);

    const rows = await this.database.execute<BronRunTimeseriesBucketRow>(sql`
      WITH ${buildWindowedRunsCte(since, runKind)},
      ${OBSERVATION_TOTALS_CTE}
      SELECT
        r.bron_id,
        ${truncated} AS bucket,
        CAST(count(r.id) AS integer) AS runs,
        CAST(count(r.id) FILTER (WHERE r.status = 'succeeded') AS integer) AS succeeded,
        CAST(count(r.id) FILTER (WHERE r.status = 'failed') AS integer) AS failed,
        CAST(coalesce(sum(r.aantal_gevonden), 0) AS integer) AS aantal_gevonden,
        CAST(coalesce(sum(r.nieuw), 0) AS integer) AS nieuw,
        CAST(coalesce(sum(r.gewijzigd), 0) AS integer) AS gewijzigd,
        CAST(coalesce(sum(r.rejected), 0) AS integer) AS rejected,
        CAST(coalesce(sum(r.fouten), 0) AS integer) AS fouten,
        CAST(coalesce(sum(o.ongewijzigd), 0) AS integer) AS ongewijzigd,
        CAST(avg(r.duur_ms) AS double precision) AS avg_duration_ms
      FROM windowed_runs r
      LEFT JOIN observation_totals o ON o.scrape_run_id = r.id
      WHERE true${buildBronPredicate(sql`r.bron_id`, query.bronIds)}
      GROUP BY r.bron_id, ${truncated}
      ORDER BY ${truncated}, r.bron_id
    `);

    return rows.map((row) => ({
      aantalGevonden: row.aantal_gevonden,
      avgDurationMs: row.avg_duration_ms,
      bronId: row.bron_id,
      bucket: new Date(row.bucket),
      failed: row.failed,
      fouten: row.fouten,
      gewijzigd: row.gewijzigd,
      nieuw: row.nieuw,
      ongewijzigd: row.ongewijzigd,
      rejected: row.rejected,
      runs: row.runs,
      succeeded: row.succeeded,
    }));
  }

  /**
   * Per-source rows plus the `totaal` row in one pass.
   *
   * GROUPING SETS rather than summing the per-source rows in TypeScript,
   * because `p95_duration_ms` is not additive: the 95th percentile over every
   * source is not any function of the per-source percentiles.
   *
   * The join starts at `curated.bron` so a source with no runs in the window
   * still gets a row of zeroes, which is what the dashboard's "nog geen runs"
   * empty state renders.
   */
  private selectAggregates(
    since: Date,
    runKind: BronRunKindFilter,
    bronIds: readonly string[] | undefined
  ): Promise<BronRunStatsAggregate[]> {
    return this.database.execute<BronRunStatsAggregate>(sql`
      WITH ${buildWindowedRunsCte(since, runKind)},
      ${OBSERVATION_TOTALS_CTE}
      SELECT
        CAST(GROUPING(b.id) AS integer) AS is_totaal,
        b.id AS bron_id,
        b.naam,
        b.actief,
        b.interval,
        CAST(count(r.id) AS integer) AS runs,
        CAST(count(r.id) FILTER (WHERE r.status = 'succeeded') AS integer) AS succeeded,
        CAST(count(r.id) FILTER (WHERE r.status = 'failed') AS integer) AS failed,
        CAST(count(r.id) FILTER (WHERE r.status = 'cancelled') AS integer) AS cancelled,
        CAST(count(r.id) FILTER (WHERE r.status = 'running') AS integer) AS running,
        CAST(count(r.id) FILTER (WHERE r.status = 'succeeded' AND r.completion IN (${PARTIAL_COMPLETIONS_SQL})) AS integer) AS onvolledig,
        CAST(coalesce(sum(r.aantal_gevonden), 0) AS integer) AS aantal_gevonden,
        CAST(coalesce(sum(r.nieuw), 0) AS integer) AS nieuw,
        CAST(coalesce(sum(r.gewijzigd), 0) AS integer) AS gewijzigd,
        CAST(coalesce(sum(r.rejected), 0) AS integer) AS rejected,
        CAST(coalesce(sum(r.gesloten), 0) AS integer) AS gesloten,
        CAST(coalesce(sum(r.fouten), 0) AS integer) AS fouten,
        CAST(coalesce(sum(o.ongewijzigd), 0) AS integer) AS ongewijzigd,
        CAST(coalesce(sum((r.outcome_counts ->> 'skipped_known')::integer), 0) AS integer) AS overgeslagen,
        CAST(avg(r.duur_ms) AS double precision) AS avg_duration_ms,
        CAST(percentile_cont(0.95) WITHIN GROUP (ORDER BY r.duur_ms) AS double precision) AS p95_duration_ms,
        max(r.gestart) AS last_run_at,
        ${latestRunValue(sql`r.status`)} AS last_run_status,
        ${latestRunValue(sql`r.completion`)} AS last_completion,
        ${latestFailureValue(sql`r.failure_class`)} AS last_failure_class,
        ${latestFailureValue(sql`r.failure_code`)} AS last_failure_code,
        ${latestFailureValue(sql`r.failure_kind`)} AS last_failure_kind,
        ${latestFailureValue(sql`r.failure_message`)} AS last_failure_message,
        ${latestFailureValue(sql`r.failure_phase`)} AS last_failure_phase
      FROM curated.bron b
      LEFT JOIN windowed_runs r ON r.bron_id = b.id
      LEFT JOIN observation_totals o ON o.scrape_run_id = r.id
      WHERE true${buildBronPredicate(sql`b.id`, bronIds)}
      GROUP BY GROUPING SETS ((b.id, b.naam, b.actief, b.interval), ())
      ORDER BY GROUPING(b.id), b.naam, b.id
    `);
  }

  /**
   * Failure codes by frequency, per source and overall.
   *
   * Grouped on `failure_code` from the run's failure envelope rather than on a
   * free-text message. Motian stored failures as `string[]`, which could only
   * ever be read one row at a time in a tooltip; a closed set of codes can be
   * counted, ranked and alerted on.
   */
  private selectFailureTallies(
    since: Date,
    runKind: BronRunKindFilter,
    bronIds: readonly string[] | undefined
  ): Promise<BronRunFailureTally[]> {
    return this.database.execute<BronRunFailureTally>(sql`
      WITH ${buildWindowedRunsCte(since, runKind)}
      SELECT
        CAST(GROUPING(r.bron_id) AS integer) AS is_totaal,
        r.bron_id,
        r.failure_code AS code,
        CAST(count(*) AS integer) AS count
      FROM windowed_runs r
      WHERE r.failure_code IS NOT NULL${buildBronPredicate(sql`r.bron_id`, bronIds)}
      GROUP BY GROUPING SETS ((r.bron_id, r.failure_code), (r.failure_code))
      ORDER BY count DESC, code ASC
    `);
  }
}
