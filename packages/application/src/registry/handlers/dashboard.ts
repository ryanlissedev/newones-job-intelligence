import { Effect, Schema, SchemaTransformation } from "effect";

import type { SchemaType } from "../schema-helpers";
import {
  FiniteNumber,
  IsoDateTimeString,
  NonEmptyString,
  optionalField,
  PositiveInteger,
  toCapabilitySchema,
  UuidString,
} from "../schema-helpers";
import type {
  SliceADomainFailure,
  SliceADomainFailureDetails,
} from "../schemas";
import {
  serializeSourceHealthSignals,
  sourceHealthSignalsViewSchema,
} from "../source-health";
import type {
  BronRunStatsRow,
  BronRunTimeseriesPoint,
  ScrapeRunView,
} from "../stores/types";
import type { SliceAHandlerDeps } from "./deps";

const domainFailure = (
  code: SliceADomainFailure["code"],
  message: string,
  details?: SliceADomainFailureDetails
) => ({ error: { code, details, message }, ok: false as const });

const dashboardWindowValues = Schema.Literals(["24u", "7d", "30d"]);

/**
 * `"24h"` stays accepted on the wire and normalises to `"24u"`; the key may be
 * absent and then defaults to `"7d"` (prior Zod `.default().transform()`).
 */
export const dashboardWindow = Schema.Literals(["24u", "24h", "7d", "30d"])
  .pipe(
    Schema.decodeTo(
      dashboardWindowValues,
      SchemaTransformation.transform({
        decode: (value) => (value === "24h" ? ("24u" as const) : value),
        encode: (value) => value,
      })
    )
  )
  .pipe(Schema.withDecodingDefaultKey(Effect.succeed("7d" as const)));

export const dashboardWindowSchema = toCapabilitySchema(dashboardWindow);

const failureCount = Schema.Struct({
  code: Schema.String,
  count: FiniteNumber,
});

const statsView = Schema.Struct({
  aantalGevonden: FiniteNumber,
  actief: Schema.NullOr(Schema.Boolean),
  avgDurationMs: Schema.NullOr(FiniteNumber),
  bronId: Schema.NullOr(Schema.String),
  cancelled: FiniteNumber,
  failed: FiniteNumber,
  fouten: FiniteNumber,
  gesloten: FiniteNumber,
  gewijzigd: FiniteNumber,
  interval: Schema.NullOr(Schema.String),
  lastFailureClass: Schema.NullOr(Schema.String),
  lastFailureCode: Schema.NullOr(Schema.String),
  lastFailureKind: Schema.NullOr(Schema.String),
  lastFailureMessage: Schema.NullOr(Schema.String),
  lastFailurePhase: Schema.NullOr(Schema.String),
  lastRunAt: Schema.NullOr(Schema.String),
  lastRunStatus: Schema.NullOr(Schema.String),
  naam: Schema.NullOr(Schema.String),
  nieuw: FiniteNumber,
  ongewijzigd: FiniteNumber,
  overgeslagen: FiniteNumber,
  p95DurationMs: Schema.NullOr(FiniteNumber),
  rejected: FiniteNumber,
  running: FiniteNumber,
  runs: FiniteNumber,
  succeeded: FiniteNumber,
  successRate: Schema.NullOr(FiniteNumber),
  topFailures: Schema.Array(failureCount),
});

const pointView = Schema.Struct({
  aantalGevonden: FiniteNumber,
  avgDurationMs: Schema.NullOr(FiniteNumber),
  bronId: Schema.String,
  bucket: Schema.String,
  failed: FiniteNumber,
  fouten: FiniteNumber,
  gewijzigd: FiniteNumber,
  nieuw: FiniteNumber,
  ongewijzigd: FiniteNumber,
  rejected: FiniteNumber,
  runs: FiniteNumber,
  succeeded: FiniteNumber,
});

const healthView = Schema.Struct({
  bronId: Schema.String,
  circuitStatus: Schema.String,
  lastRunAt: Schema.NullOr(Schema.String),
  lastRunStatus: Schema.NullOr(Schema.String),
  silenceAlertOpen: Schema.Boolean,
});

const dashboardHealthView = Schema.Struct({
  bronId: Schema.String,
  circuitStatus: Schema.NullOr(Schema.String),
  healthSignals: Schema.NullOr(sourceHealthSignalsViewSchema),
  lastRunAt: Schema.NullOr(Schema.String),
  lastRunStatus: Schema.NullOr(Schema.String),
  silenceAlertOpen: Schema.NullOr(Schema.Boolean),
});

const alertView = Schema.Struct({
  ackedAt: Schema.NullOr(Schema.String),
  bronId: Schema.String,
  createdAt: Schema.String,
  id: Schema.String,
  kind: Schema.String,
  message: Schema.String,
});

const serializeStatsRow = (row: BronRunStatsRow) => ({
  aantalGevonden: row.aantalGevonden,
  actief: row.actief,
  avgDurationMs: row.avgDurationMs,
  bronId: row.bronId,
  cancelled: row.cancelled,
  failed: row.failed,
  fouten: row.fouten,
  gesloten: row.gesloten,
  gewijzigd: row.gewijzigd,
  interval: row.interval,
  lastFailureClass: row.lastFailureClass,
  lastFailureCode: row.lastFailureCode,
  lastFailureKind: row.lastFailureKind,
  lastFailureMessage: row.lastFailureMessage,
  lastFailurePhase: row.lastFailurePhase,
  lastRunAt: row.lastRunAt?.toISOString() ?? null,
  lastRunStatus: row.lastRunStatus,
  naam: row.naam,
  nieuw: row.nieuw,
  ongewijzigd: row.ongewijzigd,
  overgeslagen: row.overgeslagen,
  p95DurationMs: row.p95DurationMs,
  rejected: row.rejected,
  running: row.running,
  runs: row.runs,
  succeeded: row.succeeded,
  successRate: row.successRate,
  topFailures: [...row.topFailures],
});

const serializeTimeseriesPoint = (point: BronRunTimeseriesPoint) => ({
  aantalGevonden: point.aantalGevonden,
  avgDurationMs: point.avgDurationMs,
  bronId: point.bronId,
  bucket: point.bucket.toISOString(),
  failed: point.failed,
  fouten: point.fouten,
  gewijzigd: point.gewijzigd,
  nieuw: point.nieuw,
  ongewijzigd: point.ongewijzigd,
  rejected: point.rejected,
  runs: point.runs,
  succeeded: point.succeeded,
});

const loadHealth = async (deps: SliceAHandlerDeps, bronId: string) => {
  const health = await deps.stores.bronHealth.getByBronId(bronId);
  if (!health) {
    return null;
  }
  return {
    bronId: health.bronId,
    circuitStatus: health.circuitStatus,
    lastRunAt: health.lastRunAt?.toISOString() ?? null,
    lastRunStatus: health.lastRunStatus,
    silenceAlertOpen: health.silenceAlertOpen,
  };
};

export const getDashboardOverviewInputSchema = toCapabilitySchema(
  Schema.Struct({
    window: dashboardWindow,
  })
);

export const getDashboardOverviewOutputSchema = toCapabilitySchema(
  Schema.Struct({
    alerts: Schema.Array(alertView),
    bronnen: Schema.Array(
      Schema.Struct({
        health: Schema.NullOr(dashboardHealthView),
        stats: statsView,
      })
    ),
    health: Schema.Array(dashboardHealthView),
    timeseries: Schema.Array(pointView),
    total: statsView,
    window: dashboardWindowValues,
  })
);

export const createGetDashboardOverviewHandler =
  (
    deps: Pick<
      SliceAHandlerDeps,
      "bronRunStatsReader" | "sourceHealthReader"
    > & {
      readonly stores: Pick<
        SliceAHandlerDeps["stores"],
        "bronHealth" | "alerts"
      >;
    }
  ) =>
  async (input: SchemaType<typeof getDashboardOverviewInputSchema>) => {
    if (!deps.bronRunStatsReader) {
      throw new Error("BronRunStatsReader unavailable");
    }
    const stats = await deps.bronRunStatsReader.bronRunStats({
      window: input.window,
    });
    const timeseries = await deps.bronRunStatsReader.bronRunTimeseries({
      window: input.window,
    });
    const sourceRows = stats.bronnen.filter(
      (row): row is typeof row & { bronId: string } => row.bronId !== null
    );
    // Load legacy health in one batch. Runtime signals below also use one
    // batch, so adding sources does not add per-source database calls.
    const healthRecords = await deps.stores.bronHealth.list();
    const healthByBronId = new Map(
      healthRecords.map((record) => [record.bronId, record] as const)
    );
    const sourceHealthRecords = deps.sourceHealthReader
      ? await deps.sourceHealthReader.listByBronIds(
          sourceRows.map((row) => row.bronId)
        )
      : [];
    const sourceHealthByBronId = new Map(
      sourceHealthRecords.map((record) => [record.bronId, record] as const)
    );
    const bronnen = sourceRows.map((row) => {
      const record = healthByBronId.get(row.bronId) ?? null;
      const sourceHealth = sourceHealthByBronId.get(row.bronId) ?? null;
      return {
        health:
          record || sourceHealth
            ? {
                bronId: record?.bronId ?? row.bronId,
                circuitStatus: record?.circuitStatus ?? null,
                healthSignals: sourceHealth
                  ? serializeSourceHealthSignals(sourceHealth.signals)
                  : null,
                lastRunAt: record?.lastRunAt?.toISOString() ?? null,
                lastRunStatus: record?.lastRunStatus ?? null,
                silenceAlertOpen: record?.silenceAlertOpen ?? null,
              }
            : null,
        stats: serializeStatsRow(row),
      };
    });
    const healthRows = bronnen.flatMap(({ health }) =>
      health ? [health] : []
    );
    const openAlerts = await deps.stores.alerts.listOpen();
    return {
      ok: true as const,
      value: {
        alerts: openAlerts.map((alert) => ({
          ackedAt: alert.ackedAt?.toISOString() ?? null,
          bronId: alert.bronId,
          createdAt: alert.createdAt.toISOString(),
          id: alert.id,
          kind: alert.kind,
          message: alert.message,
        })),
        bronnen,
        health: healthRows,
        timeseries: timeseries.map(serializeTimeseriesPoint),
        total: serializeStatsRow(stats.totaal),
        window: input.window,
      },
    };
  };

export const getBronStatsInputSchema = toCapabilitySchema(
  Schema.Struct({
    bronId: UuidString,
    window: dashboardWindow,
  })
);

export const getBronStatsOutputSchema = toCapabilitySchema(
  Schema.Struct({
    health: Schema.NullOr(healthView),
    stats: statsView,
    timeseries: Schema.Array(pointView),
    topFailures: Schema.Array(failureCount),
    window: dashboardWindowValues,
  })
);

export const createGetBronStatsHandler =
  (deps: SliceAHandlerDeps) =>
  async (input: SchemaType<typeof getBronStatsInputSchema>) => {
    if (!deps.bronRunStatsReader) {
      throw new Error("BronRunStatsReader unavailable");
    }
    const stats = await deps.bronRunStatsReader.bronRunStats({
      bronIds: [input.bronId],
      window: input.window,
    });
    const [source] = stats.bronnen;
    if (!source) {
      return domainFailure("NOT_FOUND", "Bron not found", {
        bronId: input.bronId,
      });
    }
    const timeseries = await deps.bronRunStatsReader.bronRunTimeseries({
      bronIds: [input.bronId],
      window: input.window,
    });
    const health = await loadHealth(deps, input.bronId);
    return {
      ok: true as const,
      value: {
        health,
        stats: serializeStatsRow(source),
        timeseries: timeseries.map(serializeTimeseriesPoint),
        topFailures: [...source.topFailures],
        window: input.window,
      },
    };
  };

const runView = Schema.Struct({
  aantalGevonden: FiniteNumber,
  bronId: Schema.String,
  checkpoint: Schema.NullOr(
    Schema.Struct({
      cursor: optionalField(Schema.Union([Schema.String, FiniteNumber])),
      hasMore: optionalField(Schema.Boolean),
      offset: optionalField(FiniteNumber),
      page: optionalField(FiniteNumber),
    })
  ),
  circuitStatus: Schema.String,
  createdAt: Schema.String,
  failureClass: Schema.NullOr(Schema.String),
  failureCode: Schema.NullOr(Schema.String),
  failureMessage: Schema.NullOr(Schema.String),
  failurePhase: Schema.NullOr(Schema.String),
  fouten: FiniteNumber,
  geindigd: Schema.NullOr(Schema.String),
  gesloten: FiniteNumber,
  gestart: Schema.String,
  gewijzigd: FiniteNumber,
  id: Schema.String,
  lifecycleSummary: Schema.Struct({
    incremented: FiniteNumber,
    reopened: FiniteNumber,
    reset: FiniteNumber,
    staled: FiniteNumber,
  }),
  nieuw: FiniteNumber,
  observationDistribution: Schema.Struct({
    created: FiniteNumber,
    rejected: FiniteNumber,
    unchanged: FiniteNumber,
    updated: FiniteNumber,
  }),
  rejected: FiniteNumber,
  runKind: Schema.String,
  status: Schema.String,
  versionAdapter: Schema.NullOr(Schema.String),
});

const serializeRunView = (run: ScrapeRunView) => ({
  aantalGevonden: run.aantalGevonden,
  bronId: run.bronId,
  checkpoint: run.checkpoint,
  circuitStatus: run.circuitStatus,
  createdAt: run.createdAt.toISOString(),
  failureClass: run.failureClass,
  failureCode: run.failureCode,
  failureMessage: run.failureMessage,
  failurePhase: run.failurePhase,
  fouten: run.fouten,
  geindigd: run.geindigd?.toISOString() ?? null,
  gesloten: run.gesloten,
  gestart: run.gestart.toISOString(),
  gewijzigd: run.gewijzigd,
  id: run.id,
  lifecycleSummary: run.lifecycleSummary,
  nieuw: run.nieuw,
  observationDistribution: run.observationDistribution,
  rejected: run.rejected,
  runKind: run.runKind,
  status: run.status,
  versionAdapter: run.versieAdapter,
});

const SCRAPE_RUNS_MAX_LIMIT = 100;
const SCRAPE_RUNS_DEFAULT_LIMIT = 50;

export const listScrapeRunsInputSchema = toCapabilitySchema(
  Schema.Struct({
    bronId: optionalField(UuidString),
    cursor: optionalField(Schema.String),
    failureCode: optionalField(NonEmptyString),
    limit: PositiveInteger.check(
      Schema.isLessThanOrEqualTo(SCRAPE_RUNS_MAX_LIMIT)
    ).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed(SCRAPE_RUNS_DEFAULT_LIMIT))
    ),
    runKind: optionalField(
      Schema.Literals(["all", "poll", "backfill", "test"])
    ),
    since: optionalField(IsoDateTimeString),
    status: optionalField(
      Schema.Literals(["running", "succeeded", "failed", "cancelled"])
    ),
  })
);

export const listScrapeRunsOutputSchema = toCapabilitySchema(
  Schema.Struct({
    items: Schema.Array(runView),
    nextCursor: Schema.NullOr(Schema.String),
  })
);

export const createListScrapeRunsHandler =
  (deps: SliceAHandlerDeps) =>
  async (input: SchemaType<typeof listScrapeRunsInputSchema>) => {
    if (!deps.scrapeRunReader) {
      throw new Error("ScrapeRunReader unavailable");
    }
    const listed = await deps.scrapeRunReader.list({
      bronId: input.bronId,
      cursor: input.cursor,
      failureCode: input.failureCode,
      limit: input.limit,
      runKind: input.runKind,
      since: input.since ? new Date(input.since) : undefined,
      status: input.status,
    });
    return {
      ok: true as const,
      value: {
        items: listed.items.map(serializeRunView),
        nextCursor: listed.nextCursor,
      },
    };
  };

export const getScrapeRunInputSchema = toCapabilitySchema(
  Schema.Struct({
    id: UuidString,
  })
);

export const getScrapeRunOutputSchema = toCapabilitySchema(runView);

export const createGetScrapeRunHandler =
  (deps: SliceAHandlerDeps) =>
  async (input: SchemaType<typeof getScrapeRunInputSchema>) => {
    if (!deps.scrapeRunReader) {
      throw new Error("ScrapeRunReader unavailable");
    }
    const run = await deps.scrapeRunReader.getById(input.id);
    if (!run) {
      return domainFailure("NOT_FOUND", "Scrape run not found", {
        id: input.id,
      });
    }
    return {
      ok: true as const,
      value: serializeRunView(run),
    };
  };
