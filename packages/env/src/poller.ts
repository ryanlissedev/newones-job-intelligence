import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";

import { directDatabaseUrlEffectSchema } from "./projector-database-url";
import {
  Effect,
  HttpUrlString,
  NonEmptyString,
  onEnvValidationError,
  Schema,
  skipEnvValidation,
  toEnvSchema,
  TrimmedNonEmptyString,
  UrlString,
} from "./schema-helpers";

const RELEASE_SHA_MESSAGE =
  "Release SHA must be a 40-character lowercase Git SHA (read from APP_RELEASE_SHA, or from Coolify's SOURCE_COMMIT when APP_RELEASE_SHA is unset).";

const positiveIntegerWithDefault = (
  fallback: number,
  variableName: string,
  unit: string
) =>
  Schema.String.check(
    Schema.isPattern(/^[1-9][0-9]*$/u, {
      message: `${variableName} must be a positive whole number of ${unit}`,
    })
  ).pipe(Schema.withDecodingDefault(Effect.succeed(String(fallback))));

const millisecondsWithDefault = (fallbackMs: number, variableName: string) =>
  positiveIntegerWithDefault(fallbackMs, variableName, "milliseconds");

/** Six hours: longer than any healthy poll plus its full curate budget. */
export const ABANDON_RUN_AFTER_MS_DEFAULT = 6 * 60 * 60 * 1000;

/**
 * One hour: the slowest healthy poll measured on-box (Opdrachtoverheid, ~940 s
 * of crawl delay for a 300-item listing) fits with margin, so a run that
 * reaches it is stalled, not slow.
 */
export const RUN_BUDGET_MS_DEFAULT = 60 * 60 * 1000;

/** Sources in flight at once (was 2 fixed slots). */
export const POLLER_CONCURRENCY_DEFAULT = 8;
/** Process-wide request starts per second across all sources. */
export const POLLER_FETCHES_PER_SECOND_DEFAULT = 8;
/** Concurrent curation drains: the old slot count, so DB pressure is unchanged. */
export const POLLER_CURATE_CONCURRENCY_DEFAULT = 2;

export const resolvePollRunStaleAfterMs = (
  value: string | undefined = process.env.POLLER_ABANDON_RUN_AFTER_MS
): number => {
  const configured =
    value === undefined || value === ""
      ? String(ABANDON_RUN_AFTER_MS_DEFAULT)
      : value;
  if (!/^[1-9][0-9]*$/u.test(configured)) {
    throw new Error(
      "POLLER_ABANDON_RUN_AFTER_MS must be a positive whole number of milliseconds"
    );
  }
  return Number(configured);
};

/**
 * Dedicated env contract for the long-running on-box poller
 * (runbook: docs/runbooks/onbox-poller.md). Mirrors `projector.ts`: runtime
 * data queries may use a pooled DATABASE_URL, while the session advisory lock
 * must use the direct POLLER_DATABASE_URL endpoint.
 *
 * The RAW_S3_* group is read from `process.env` by `createPollBronRuntime`
 * (`apps/worker/src/poll-bron-run.ts`); declared here so the poller's contract
 * is one document, and so a blank value fails validation rather than silently
 * selecting the filesystem backend.
 */
export const pollerEnvEffectSchemas = {
  APP_RELEASE_SHA: Schema.optional(
    Schema.String.check(
      Schema.isPattern(/^[a-f0-9]{40}$/u, { message: RELEASE_SHA_MESSAGE })
    )
  ),
  DATABASE_URL: TrimmedNonEmptyString,
  /**
   * Which sources route through EGRESS_PROXY_URL: "*" or a comma-separated
   * list of source slugs (the `SOURCES` registry keys). Setting sources
   * without the URL fails closed at startup — see `describeEgressConfig` in
   * `@ji/connectors` (runbook: docs/runbooks/nl-egress.md).
   */
  EGRESS_PROXY_SOURCES: Schema.optional(
    Schema.String.check(
      Schema.isPattern(/^\s*(?:\*|[a-z0-9-]+(?:\s*,\s*[a-z0-9-]+)*)\s*$/u, {
        message:
          'EGRESS_PROXY_SOURCES must be "*" or a comma-separated list of source slugs',
      })
    )
  ),
  /**
   * CTP-602: optional http(s) forward-proxy endpoint for sources that block
   * non-Dutch egress IPs. Unset means every source fetches directly (today's
   * behaviour). Never logged — it may carry proxy credentials.
   */
  EGRESS_PROXY_URL: Schema.optional(HttpUrlString),
  /** Unused while SEARCH_PROJECTOR is onbox; the projector owns every drain. */
  MANTICORE_URL: Schema.optional(UrlString),
  /**
   * A `running` scrape run older than this is failed at the top of a cycle.
   * Sized so only a process that died mid-run can qualify: no healthy poll
   * plus its curate budget comes close to six hours.
   */
  POLLER_ABANDON_RUN_AFTER_MS: millisecondsWithDefault(
    ABANDON_RUN_AFTER_MS_DEFAULT,
    "POLLER_ABANDON_RUN_AFTER_MS"
  ),
  /**
   * How many sources may be in flight at once. Politeness per host is
   * unaffected: each bron's HostGate still paces its own requests, and
   * POLLER_FETCHES_PER_SECOND caps the process total. Long sources leave one
   * slot free for short ones (`maxLongInFlight`).
   */
  POLLER_CONCURRENCY: positiveIntegerWithDefault(
    POLLER_CONCURRENCY_DEFAULT,
    "POLLER_CONCURRENCY",
    "concurrent sources"
  ),
  POLLER_CURATE_BUDGET_MS: millisecondsWithDefault(
    120_000,
    "POLLER_CURATE_BUDGET_MS"
  ),
  /**
   * Curation drains that may run against Postgres at once. Kept at the old
   * slot count so going to more sources in flight does not multiply database
   * pressure; a source waiting for a curation slot holds its own run slot.
   */
  POLLER_CURATE_CONCURRENCY: positiveIntegerWithDefault(
    POLLER_CURATE_CONCURRENCY_DEFAULT,
    "POLLER_CURATE_CONCURRENCY",
    "concurrent curation drains"
  ),
  POLLER_DATABASE_URL: directDatabaseUrlEffectSchema("POLLER_DATABASE_URL"),
  /**
   * CTP-622: comma-separated source slugs dispatched through
   * `curated.durable_job` (the PersistedQueue path) instead of the inline
   * poll run. Unset/empty = everything inline (rollback). The worker
   * validates slugs against the source registry and fails closed on a typo.
   */
  POLLER_DURABLE_BRONNEN: Schema.optional(
    Schema.String.check(
      Schema.isPattern(/^\s*[a-z0-9-]+(?:\s*,\s*[a-z0-9-]+)*\s*$/u, {
        message:
          "POLLER_DURABLE_BRONNEN must be a comma-separated list of source slugs",
      })
    )
  ),
  /**
   * Process-wide ceiling on request starts per second across every source.
   * Each bron's own crawl delay still applies first.
   */
  POLLER_FETCHES_PER_SECOND: positiveIntegerWithDefault(
    POLLER_FETCHES_PER_SECOND_DEFAULT,
    "POLLER_FETCHES_PER_SECOND",
    "requests per second"
  ),
  /**
   * Rows deleted per cycle at most, so a prune never holds the outbox write
   * lock long enough to stall the drain's own inserts (CTP-404).
   */
  POLLER_OUTBOX_PRUNE_BATCH: positiveIntegerWithDefault(
    25_000,
    "POLLER_OUTBOX_PRUNE_BATCH",
    "outbox rows per prune pass"
  ),
  /**
   * Processed outbox events older than this are deleted once per cycle.
   * Unprocessed and dead-lettered rows are never pruned here (CTP-404).
   */
  POLLER_OUTBOX_RETENTION_DAYS: positiveIntegerWithDefault(
    30,
    "POLLER_OUTBOX_RETENTION_DAYS",
    "days processed outbox events are kept"
  ),
  /**
   * CTP-490: wall-clock budget for one source's connector run. When it
   * elapses the run stops at the next item, keeps what it observed and closes
   * the row as incomplete (`aborted`) instead of staying `running` until
   * the process dies and `POLLER_ABANDON_RUN_AFTER_MS` repairs it.
   */
  POLLER_RUN_BUDGET_MS: millisecondsWithDefault(
    RUN_BUDGET_MS_DEFAULT,
    "POLLER_RUN_BUDGET_MS"
  ),
  POLLER_TICK_MS: millisecondsWithDefault(60_000, "POLLER_TICK_MS"),
  RAW_OBJECT_STORE_PATH: Schema.optional(NonEmptyString),
  RAW_S3_ACCESS_KEY_ID: Schema.optional(NonEmptyString),
  RAW_S3_BUCKET: Schema.optional(NonEmptyString),
  RAW_S3_ENDPOINT: Schema.optional(NonEmptyString),
  RAW_S3_REGION: Schema.optional(NonEmptyString),
  RAW_S3_SECRET_ACCESS_KEY: Schema.optional(NonEmptyString),
  /**
   * Pinned: this process polls and curates, the on-box projector drains. A
   * poller in "worker" mode would drain the outbox behind the projector's
   * back and need a Manticore route it is not deployed next to.
   */
  SEARCH_PROJECTOR: Schema.Literals(["onbox"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("onbox" as const))
  ),
} as const;

const createPollerEnv = () =>
  createEnv({
    emptyStringAsUndefined: true,
    onValidationError: onEnvValidationError,
    runtimeEnv: {
      ...process.env,
      APP_RELEASE_SHA: process.env.APP_RELEASE_SHA || process.env.SOURCE_COMMIT,
    },
    server: {
      APP_RELEASE_SHA: toEnvSchema(pollerEnvEffectSchemas.APP_RELEASE_SHA),
      DATABASE_URL: toEnvSchema(pollerEnvEffectSchemas.DATABASE_URL),
      EGRESS_PROXY_SOURCES: toEnvSchema(
        pollerEnvEffectSchemas.EGRESS_PROXY_SOURCES
      ),
      EGRESS_PROXY_URL: toEnvSchema(pollerEnvEffectSchemas.EGRESS_PROXY_URL),
      MANTICORE_URL: toEnvSchema(pollerEnvEffectSchemas.MANTICORE_URL),
      POLLER_ABANDON_RUN_AFTER_MS: toEnvSchema(
        pollerEnvEffectSchemas.POLLER_ABANDON_RUN_AFTER_MS
      ),
      POLLER_CONCURRENCY: toEnvSchema(
        pollerEnvEffectSchemas.POLLER_CONCURRENCY
      ),
      POLLER_CURATE_BUDGET_MS: toEnvSchema(
        pollerEnvEffectSchemas.POLLER_CURATE_BUDGET_MS
      ),
      POLLER_CURATE_CONCURRENCY: toEnvSchema(
        pollerEnvEffectSchemas.POLLER_CURATE_CONCURRENCY
      ),
      POLLER_DATABASE_URL: toEnvSchema(
        pollerEnvEffectSchemas.POLLER_DATABASE_URL
      ),
      POLLER_DURABLE_BRONNEN: toEnvSchema(
        pollerEnvEffectSchemas.POLLER_DURABLE_BRONNEN
      ),
      POLLER_FETCHES_PER_SECOND: toEnvSchema(
        pollerEnvEffectSchemas.POLLER_FETCHES_PER_SECOND
      ),
      POLLER_OUTBOX_PRUNE_BATCH: toEnvSchema(
        pollerEnvEffectSchemas.POLLER_OUTBOX_PRUNE_BATCH
      ),
      POLLER_OUTBOX_RETENTION_DAYS: toEnvSchema(
        pollerEnvEffectSchemas.POLLER_OUTBOX_RETENTION_DAYS
      ),
      POLLER_RUN_BUDGET_MS: toEnvSchema(
        pollerEnvEffectSchemas.POLLER_RUN_BUDGET_MS
      ),
      POLLER_TICK_MS: toEnvSchema(pollerEnvEffectSchemas.POLLER_TICK_MS),
      RAW_OBJECT_STORE_PATH: toEnvSchema(
        pollerEnvEffectSchemas.RAW_OBJECT_STORE_PATH
      ),
      RAW_S3_ACCESS_KEY_ID: toEnvSchema(
        pollerEnvEffectSchemas.RAW_S3_ACCESS_KEY_ID
      ),
      RAW_S3_BUCKET: toEnvSchema(pollerEnvEffectSchemas.RAW_S3_BUCKET),
      RAW_S3_ENDPOINT: toEnvSchema(pollerEnvEffectSchemas.RAW_S3_ENDPOINT),
      RAW_S3_REGION: toEnvSchema(pollerEnvEffectSchemas.RAW_S3_REGION),
      RAW_S3_SECRET_ACCESS_KEY: toEnvSchema(
        pollerEnvEffectSchemas.RAW_S3_SECRET_ACCESS_KEY
      ),
      SEARCH_PROJECTOR: toEnvSchema(pollerEnvEffectSchemas.SEARCH_PROJECTOR),
    },
    skipValidation: skipEnvValidation(),
  });

type PollerEnv = ReturnType<typeof createPollerEnv>;
let resolvedEnv: PollerEnv | undefined;
/** Validates the full poller contract on first use, then reuses the result. */
export const getPollerEnv = (): PollerEnv => {
  resolvedEnv ??= createPollerEnv();
  return resolvedEnv;
};
