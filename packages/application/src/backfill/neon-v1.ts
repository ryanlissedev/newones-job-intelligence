import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  buildContentAddressedRawObjectPath,
  hashContent,
  parseContentAddressedRawObjectPath,
} from "@ji/connectors";
import type { ObjectStore } from "@ji/connectors";
import { UNKNOWN } from "@ji/domain";
import { z } from "zod";

import { curateObservation } from "../identity/curate";
import type { CurateStore } from "../identity/curate";
import { field } from "../normalise";
import type { NormalisedAanvraagDraft } from "../normalise";
import { titleFallbackDescription } from "../title-fallback-description";
import { isMotianJobClosed, resolveMotianBronUrl } from "./motian-bron-url";
import type { StarappleLiveIndex } from "./motian-bron-url";
import {
  educationLevelForMotianJob,
  motianTariefEenheid,
  provincieForMotianJob,
  rateBoundsForMotianJob,
  skillsForMotianJob,
  weeklyHoursForMotianJob,
} from "./motian-commercial-fields";
import { resolveMotianV1Binding } from "./motian-v1-bindings";
import type {
  BackfillBronBinding,
  BackfillExecution,
  BackfillFailureEvidence,
  BackfillPlatformMetrics,
  BackfillProvenanceRecord,
  BackfillRunEvidence,
  BackfillRunResult,
  BackfillScopeManifest,
  BackfillSnapshotWindow,
  BackfillTargetProvenanceRecord,
  BackfillTargetReconciliation,
  NeonV1Fixture,
  NeonV1JobRow,
  NeonV1SourceFacts,
  NeonV1Source,
  RunNeonV1BackfillInput,
} from "./neon-v1-types";
import {
  NEON_V1_BACKFILL_CONTRACT_VERSION,
  NEON_V1_DEFAULT_CONCURRENCY,
  NEON_V1_MAX_CONCURRENCY,
  NEON_V1_PARSER_VERSION,
  BACKFILL_SCOPE_MANIFEST_VERSION,
  BACKFILL_TARGET_RECONCILIATION_VERSION,
  backfillFailureEvidenceSchema,
} from "./neon-v1-types";

export {
  NEON_V1_BACKFILL_CONTRACT_VERSION,
  NEON_V1_DEFAULT_CONCURRENCY,
  NEON_V1_FORBIDDEN_TABLES,
  NEON_V1_MAX_CONCURRENCY,
  NEON_V1_PARSER_VERSION,
  type BackfillBronBinding,
  type BackfillExecution,
  type BackfillExecutionMode,
  type BackfillFailureEvidence,
  type BackfillPlatformMetrics,
  type BackfillProvenanceRecord,
  type BackfillProvenanceStore,
  type BackfillRunEvidence,
  type BackfillRunMetrics,
  type BackfillRunResult,
  type BackfillRunStore,
  type BackfillScopeManifest,
  type BackfillScope,
  type BackfillSnapshotWindow,
  type BackfillTargetProvenanceRecord,
  type BackfillTargetReconciliation,
  type NeonV1Fixture,
  type NeonV1ForbiddenTable,
  type NeonV1JobRow,
  type NeonV1SourceFacts,
  type NeonV1Source,
  type RunNeonV1BackfillInput,
  BACKFILL_FAILURE_CODES,
  BACKFILL_FAILURE_PHASES,
  BACKFILL_SCOPE_MANIFEST_VERSION,
  BACKFILL_TARGET_RECONCILIATION_VERSION,
  backfillFailureEvidenceSchema,
} from "./neon-v1-types";
export { InMemoryBackfillProvenanceStore } from "./in-memory-backfill-provenance-store";
export { InMemoryBackfillRunStore } from "./in-memory-backfill-run-store";
export { UnreachableNeonV1Source } from "./unreachable-neon-v1-source";

const fixtureRoot = path.join(process.cwd(), "fixtures", "backfill");

export const fixturePath = (...segments: string[]): string =>
  path.join(fixtureRoot, ...segments);

export const loadNeonV1Fixture = async (
  relativePath: string
): Promise<NeonV1Fixture> => {
  const raw = await readFile(fixturePath(relativePath), "utf-8");
  // SAFETY: Fixture files are repo-owned envelopes validated against contractVersion.
  const parsed = JSON.parse(raw) as NeonV1Fixture;
  if (parsed.contractVersion !== NEON_V1_BACKFILL_CONTRACT_VERSION) {
    throw new Error(
      `Unsupported Neon v1 fixture at ${relativePath}: expected contract ${NEON_V1_BACKFILL_CONTRACT_VERSION}`
    );
  }
  return parsed;
};

const compareCodeUnits = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

export const createFixtureNeonV1Source = (
  fixture: NeonV1Fixture
): NeonV1Source => {
  const orderedJobs = fixture.jobs.toSorted((left, right) =>
    compareCodeUnits(left.id, right.id)
  );
  return {
    consumeSnapshot: async (_batchSize, consume) => {
      await consume(orderedJobs);
      return {
        completedAt: fixture.capturedAt,
        startedAt: fixture.capturedAt,
      };
    },
    label: "fixture",
    loadJobs: () => Promise.resolve([...orderedJobs]),
  };
};

export const resolveMotianDatabaseUrl = (): string | undefined =>
  process.env.MOTIAN_DATABASE_URL?.trim() || undefined;

const serialiseRawSource = (job: NeonV1JobRow): string => {
  const serialised = JSON.stringify(job.sourceRow ?? job);
  if (serialised === undefined) {
    throw new Error("Motian v1 source row is not JSON serialisable");
  }
  return serialised;
};

const rawBodyForJob = (job: NeonV1JobRow): Uint8Array =>
  new TextEncoder().encode(serialiseRawSource(job));

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  return left.every((byte, index) => byte === right[index]);
};

// Base backoff budget ~31.75s (plus up to ~25% jitter) so Cloudflare/R2
// same-object rate limits and short network blips can recover mid-backfill
// without failing the Motian→on-box run. Seven delays ⇒ eight put attempts.
export const RAW_WRITE_RETRY_DELAYS_MS = [
  250, 500, 1000, 2000, 4000, 8000, 16_000,
] as const;
const R2_SAME_OBJECT_RATE_MESSAGE =
  "Reduce your concurrent request rate for the same object.";
const PERMANENT_OBJECT_STORE_HTTP_STATUSES = new Set<number | string>([
  400,
  401,
  403,
  404,
  "400",
  "401",
  "403",
  "404",
]);
const TRANSIENT_OBJECT_STORE_HTTP_STATUSES = new Set<number | string>([
  429,
  500,
  502,
  503,
  504,
  "429",
  "500",
  "502",
  "503",
  "504",
]);
const TRANSIENT_OBJECT_STORE_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ETIMEDOUT",
  "NetworkingError",
  "RequestTimeout",
  "ServiceUnavailable",
  "SlowDown",
  "Throttling",
  "ThrottlingException",
  "Timeout",
  "TimeoutError",
  "TooManyRequests",
  "TooManyRequestsException",
]);
const TRANSIENT_OBJECT_STORE_MESSAGE_RE =
  /SlowDown|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|socket hang up|TooManyRequests|throttl|timed?\s*out|TimeoutError|network|Rate exceeded|Service Unavailable/iu;

interface ObjectStoreErrorDetails extends Error {
  readonly $metadata?: { readonly httpStatusCode?: number };
  readonly code?: number | string;
  readonly httpStatusCode?: number;
  readonly status?: number;
  readonly statusCode?: number;
}

type RawWriteSleep = (ms: number) => Promise<void>;
let rawWriteSleep: RawWriteSleep = sleep;

/** Test-only seam so retry budgets do not burn wall-clock in CI. */
export const setRawWriteRetrySleepForTests = (
  fn: RawWriteSleep | undefined
): void => {
  rawWriteSleep = fn ?? sleep;
};

const isTransientObjectStoreError = (error?: Error): boolean => {
  if (!error) {
    return false;
  }
  // SAFETY: object-store adapters add these optional HTTP diagnostic fields
  // to Error instances; absent fields simply do not classify as transient.
  const details = error as ObjectStoreErrorDetails;
  const status =
    details.status ??
    details.statusCode ??
    details.httpStatusCode ??
    details.$metadata?.httpStatusCode;
  if (
    status !== undefined &&
    PERMANENT_OBJECT_STORE_HTTP_STATUSES.has(status)
  ) {
    return false;
  }
  if (
    status !== undefined &&
    TRANSIENT_OBJECT_STORE_HTTP_STATUSES.has(status)
  ) {
    return true;
  }
  const { code } = details;
  if (code !== undefined && TRANSIENT_OBJECT_STORE_ERROR_CODES.has(`${code}`)) {
    return true;
  }
  if (TRANSIENT_OBJECT_STORE_ERROR_CODES.has(error.name)) {
    return true;
  }
  return (
    error.message.includes(R2_SAME_OBJECT_RATE_MESSAGE) ||
    TRANSIENT_OBJECT_STORE_MESSAGE_RE.test(error.message)
  );
};

const putRawWithRetry = async (
  objectStore: ObjectStore,
  object: Parameters<ObjectStore["put"]>[0]
): Promise<void> => {
  let originalCause: unknown;
  for (let attempt = 0; ; attempt += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- retries must be sequential
      await objectStore.put(object);
      return;
    } catch (error) {
      originalCause ??= error;
      const delayMs = RAW_WRITE_RETRY_DELAYS_MS[attempt];
      if (
        delayMs === undefined ||
        !isTransientObjectStoreError(error instanceof Error ? error : undefined)
      ) {
        throw originalCause;
      }
      const jitteredDelayMs =
        delayMs + Math.floor(Math.random() * delayMs * 0.25);
      // oxlint-disable-next-line no-await-in-loop -- backoff separates sequential retry attempts
      await rawWriteSleep(jitteredDelayMs);
    }
  }
};

const tariefValue = (
  value: number | null | undefined
): string | typeof UNKNOWN =>
  value === null || value === undefined ? UNKNOWN : String(value);

/**
 * The Motian `jobs` table has no tariff-period column. These are the only
 * historical fields that this mapper is allowed to read from its complete
 * source row; Zod strips nested payloads and camelCase or unrelated keys.
 * Invalid values fall back per field so one malformed column does not erase
 * valid facts from the same row.
 */
/* oxlint-disable promise/prefer-await-to-then -- Zod catch supplies a synchronous per-field parse fallback. */
const sourceDateStringSchema = z
  .string()
  .refine(
    (value) => Number.isFinite(Date.parse(value)),
    "expected a valid date string"
  );
const nullableSourceDateSchema = sourceDateStringSchema.nullable().catch(null);

export const sourceFieldsSchema = z.object({
  duration_months: z.number().int().nonnegative().nullable().catch(null),
  end_date: nullableSourceDateSchema,
  hours_per_week: z.number().int().nonnegative().nullable().catch(null),
  min_hours_per_week: z.number().int().nonnegative().nullable().catch(null),
  work_arrangement: z.string().nullable().catch(null),
});

/* oxlint-enable promise/prefer-await-to-then */

const sourceFieldsForJob = (job: NeonV1JobRow) => {
  const parsed = sourceFieldsSchema.safeParse(job.sourceRow);
  return parsed.success ? parsed.data : sourceFieldsSchema.parse({});
};

const sourceFactJsonSchema = z.json();

/* oxlint-disable promise/prefer-await-to-then -- per-field catches preserve valid sibling facts. */
export const sourceFactsSchema = z.object({
  allows_subcontracting: z.boolean().nullable().optional().catch(null),
  application_deadline: z.string().nullable().optional().catch(null),
  company: z.string().nullable().optional().catch(null),
  competences: sourceFactJsonSchema.nullable().optional().catch(null),
  end_client: z.string().nullable().optional().catch(null),
  end_date: nullableSourceDateSchema.optional().catch(null),
  extension_possible: z.boolean().nullable().optional().catch(null),
  external_url: z.string().nullable().optional().catch(null),
  hours_per_week: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .optional()
    .catch(null),
  min_hours_per_week: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .optional()
    .catch(null),
  positions_available: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .optional()
    .catch(null),
  posted_at: z.string().nullable().optional().catch(null),
  province: z.string().nullable().optional().catch(null),
  requirements: sourceFactJsonSchema.nullable().optional().catch(null),
  start_date: z.string().nullable().optional().catch(null),
  wishes: sourceFactJsonSchema.nullable().optional().catch(null),
  work_arrangement: z.string().nullable().optional().catch(null),
  work_experience_years: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .optional()
    .catch(null),
});

/* oxlint-enable promise/prefer-await-to-then */

export const SOURCE_FACT_KEYS = [
  "allows_subcontracting",
  "application_deadline",
  "company",
  "competences",
  "end_client",
  "end_date",
  "external_url",
  "extension_possible",
  "hours_per_week",
  "min_hours_per_week",
  "positions_available",
  "posted_at",
  "province",
  "requirements",
  "start_date",
  "wishes",
  "work_arrangement",
  "work_experience_years",
] as const satisfies readonly (keyof NeonV1SourceFacts)[];

export const sourceFactsForJob = (job: NeonV1JobRow): NeonV1SourceFacts => {
  const source = job.sourceRow;
  const root = { ...job };
  const raw = Object.fromEntries(
    SOURCE_FACT_KEYS.map((key) => [
      key,
      source && Object.hasOwn(source, key) ? source[key] : root[key],
    ])
  );
  const parsed = sourceFactsSchema.parse(raw);
  // SAFETY: sourceFactsSchema validates every named key before this typed projection.
  return Object.fromEntries(
    Object.entries(parsed).filter(([, value]) => value !== undefined)
  ) as NeonV1SourceFacts;
};

const sourceSpecificFieldsForJob = (job: NeonV1JobRow) => {
  const source = sourceFieldsForJob(job);
  const hours = weeklyHoursForMotianJob(job, {
    hours_per_week: source.hours_per_week ?? null,
    min_hours_per_week: source.min_hours_per_week ?? null,
  });
  const educationLevel = educationLevelForMotianJob(job);
  // These fields are copied only from exact persisted Motian keys (plus the
  // allowlisted nested rate/education lifts). No free-text invention.
  return {
    duration_months:
      source.duration_months === null || source.duration_months === undefined
        ? null
        : String(source.duration_months),
    // Keep the source timestamp exactly as persisted; do not normalize it.
    eind_datum: source.end_date ?? job.end_date ?? null,
    min_uren_per_week: hours.min_uren_per_week,
    opleidingsniveau: educationLevel,
    // Only from the Motian `province` column or a province named in the title.
    provincie: provincieForMotianJob(job),
    skills: skillsForMotianJob(job),
    uren_per_week: hours.uren_per_week,
    werkvorm: source.work_arrangement ?? job.work_arrangement ?? null,
  };
};

const sourceStatusForJob = (job: NeonV1JobRow): string | null =>
  job.status?.trim() || null;

const lifecycleForJob = (
  job: NeonV1JobRow,
  sourceStatus: string | null
): "active" | "closed" =>
  isMotianJobClosed(job, sourceStatus) ? "closed" : "active";

/**
 * Starapple Motian samples sometimes store recruiter chrome / CSS (font stacks,
 * selectors, brace blocks) in `description` instead of vacancy prose. Reject
 * that source-aware for starapple* only — never invent replacement copy beyond
 * the existing title fallback used when description is absent (CTP-492 AC6).
 */
const STARAPPLE_CSS_DESCRIPTION =
  /(?:@media|@keyframes|:root\b|font-family\s*:|\{[\s\S]*?\}|\.[a-zA-Z_-][\w-]*\s*\{)/u;

const isStarapplePlatform = (platform: string): boolean => {
  const normalized = platform.trim().toLowerCase();
  return normalized === "starapple" || normalized === "starapple-nl";
};

const descriptionLooksLikeCss = (description: string): boolean => {
  const sample = description.slice(0, 4000);
  if (!STARAPPLE_CSS_DESCRIPTION.test(sample)) {
    return false;
  }
  // Require brace density typical of stylesheets, not incidental "{amount}" prose.
  const braces = (sample.match(/[{}]/gu) ?? []).length;
  return braces >= 4;
};

const descriptionForJob = (job: NeonV1JobRow): string => {
  const trimmed = job.description?.trim() ?? "";
  if (trimmed.length === 0) {
    return titleFallbackDescription({
      externalId: job.external_id,
      platform: job.platform,
      title: job.title,
    });
  }
  if (isStarapplePlatform(job.platform) && descriptionLooksLikeCss(trimmed)) {
    return titleFallbackDescription({
      externalId: job.external_id,
      platform: job.platform,
      title: job.title,
    });
  }
  return trimmed;
};

/** The Motian closing instant, or null when the source publishes none/unparsable. */
const closingMoment = (value: string | null | undefined): Date | null => {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
};

/**
 * CTP-527 (F02): a broker board never publishes itself as the eindklant. On
 * Starapple rows a `company`/`end_client` carrying the platform's own brand
 * names the intermediary, not the opdrachtgever — the CTP-514 audit recorded
 * exactly that as WRONG ("Starapple" where the reachable page names politie
 * as eindklant). The eindklant a broker page states lives in vacancy prose,
 * which is GAP_ENRICH (CTP-482), not deterministic mapping, so the honest
 * value here is UNKNOWN. `bronSpecifiek` keeps the raw company/end_client
 * untouched.
 */
const STARAPPLE_BROKER_SELF_NAMES = new Set([
  "starapple",
  "starapplenl",
  "starapplebv",
]);

const collapseBrokerSelfName = (
  job: NeonV1JobRow,
  value: string | typeof UNKNOWN
): string | typeof UNKNOWN => {
  if (value === UNKNOWN || !isStarapplePlatform(job.platform)) {
    return value;
  }
  const normalized = value.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "");
  return STARAPPLE_BROKER_SELF_NAMES.has(normalized) ? UNKNOWN : value;
};

const opdrachtgeverForJob = (job: NeonV1JobRow): string | typeof UNKNOWN =>
  collapseBrokerSelfName(
    job,
    job.end_client?.trim() || job.company?.trim() || UNKNOWN
  );

/** Motian publishes no creation timestamp. `posted_at` is the only honest
 * source for the publication/first-seen instant. When it is absent, first seen
 * remains unknown; `scraped_at` is retained separately as scrape provenance. */
const firstSeenAtForJob = (job: NeonV1JobRow): string | null =>
  job.posted_at ?? null;

const v1SpecificFieldsForJob = (
  job: NeonV1JobRow,
  sourceStatus: string | null
) => ({
  ...sourceFactsForJob(job),
  ...sourceSpecificFieldsForJob(job),
  // Kept for compatibility with the original backfill preview fields;
  // the exact source spelling remains in the durable raw source row.
  contracttype: job.contract_type ?? null,
  platform: job.platform,
  publicatiedatum: job.posted_at ?? null,
  v1_archived_at: job.archived_at ?? null,
  v1_contract_type: job.contract_type ?? null,
  v1_deleted_at: job.deleted_at ?? null,
  v1_first_seen_at: firstSeenAtForJob(job),
  v1_location: job.location ?? null,
  v1_platform: job.platform,
  v1_posted_at: job.posted_at ?? null,
  v1_province: job.province ?? null,
  v1_scraped_at: job.scraped_at ?? null,
  v1_status: sourceStatus,
});

export const mapV1JobToDraft = (
  job: NeonV1JobRow,
  starappleLiveIndex?: StarappleLiveIndex
): NormalisedAanvraagDraft => {
  const parserVersion = NEON_V1_PARSER_VERSION;
  const sourceStatus = sourceStatusForJob(job);
  const lifecycle = lifecycleForJob(job, sourceStatus);
  const applicationDeadline = closingMoment(job.application_deadline);

  return {
    beschrijving: field(descriptionForJob(job), parserVersion, "description"),
    bronReferentie: field(job.external_id, parserVersion, "external_id"),
    bronSpecifiek: field(
      v1SpecificFieldsForJob(job, sourceStatus),
      parserVersion,
      "bron_specifiek"
    ),
    bronUrl: field(
      resolveMotianBronUrl(job, starappleLiveIndex),
      parserVersion,
      "motian_bron_url"
    ),
    contentHash: "",
    extractieMethode: "api",
    lifecycle,
    locatieLand: field("NL", parserVersion, "location"),
    locatieTekst: field(
      job.location?.trim() || UNKNOWN,
      parserVersion,
      "location"
    ),
    opdrachtgeverNaam: field(
      opdrachtgeverForJob(job),
      parserVersion,
      "company"
    ),
    parserVersion,
    sluitingsdatum: applicationDeadline ?? undefined,
    startDatum: field(
      job.start_date?.slice(0, 10) || UNKNOWN,
      parserVersion,
      "start_date"
    ),
    status: lifecycle,
    tarief: (() => {
      const bounds = rateBoundsForMotianJob(job);
      return {
        // Motian has no rate-unit column; vast monthly salaris ranges use maand.
        eenheid: motianTariefEenheid(job, bounds.min, bounds.max),
        max: tariefValue(bounds.max),
        min: tariefValue(bounds.min),
        valuta: "EUR",
      };
    })(),
    titel: field(job.title, parserVersion, "title"),
  };
};

const resolveBinding = (
  bindings: readonly BackfillBronBinding[],
  platform: string
): BackfillBronBinding | null => resolveMotianV1Binding(bindings, platform);

const DEFAULT_BACKFILL_EXECUTION: BackfillExecution = {
  mode: "fixture",
  scope: "active",
};

const SOURCE_FAILURE_PLATFORM = "__source__";
const RECONCILIATION_FAILURE_PLATFORM = "__reconcile__";
const UNKNOWN_SOURCE_JOB_ID = "unknown";

type BackfillMetricKey = keyof BackfillPlatformMetrics;

interface MutableBackfillPlatformMetrics {
  duplicates: number;
  errors: number;
  extra: number;
  found: number;
  imported: number;
  matched: number;
  missing: number;
  rejected: number;
  selected: number;
  skipped: number;
}

interface MutableBackfillRunMetrics extends MutableBackfillPlatformMetrics {
  platforms: Record<string, MutableBackfillPlatformMetrics>;
}

interface BackfillEvidenceArtifacts {
  scopeManifest?: BackfillScopeManifest;
  targetReconciliation?: BackfillTargetReconciliation;
}

interface OrderedMappingDigest {
  readonly hash: ReturnType<typeof createHash>;
  readonly platformCounts: Record<string, number>;
  lastId: string | null;
  records: number;
}

const createOrderedMappingDigest = (): OrderedMappingDigest => ({
  hash: createHash("sha256"),
  lastId: null,
  platformCounts: {},
  records: 0,
});

const appendOrderedMapping = (
  digest: OrderedMappingDigest,
  mapping: BackfillTargetProvenanceRecord,
  platform: string
): void => {
  digest.hash.update(
    `${JSON.stringify([
      mapping.v1Id,
      mapping.bronId,
      mapping.bronReferentie,
      mapping.contentHash,
      mapping.rawPayloadRef,
    ])}\n`,
    "utf-8"
  );
  digest.lastId = mapping.v1Id;
  digest.platformCounts[platform] = (digest.platformCounts[platform] ?? 0) + 1;
  digest.records += 1;
};

const orderedMappingHash = (digest: OrderedMappingDigest): string =>
  digest.hash.digest("hex");

const isValidSnapshotWindow = (snapshot: BackfillSnapshotWindow): boolean => {
  const snapshotStart = Date.parse(snapshot.startedAt);
  const snapshotEnd = Date.parse(snapshot.completedAt);
  return (
    Number.isFinite(snapshotStart) &&
    Number.isFinite(snapshotEnd) &&
    snapshotEnd >= snapshotStart
  );
};

const emptyPlatformMetrics = (): MutableBackfillPlatformMetrics => ({
  duplicates: 0,
  errors: 0,
  extra: 0,
  found: 0,
  imported: 0,
  matched: 0,
  missing: 0,
  rejected: 0,
  selected: 0,
  skipped: 0,
});

const emptyMetrics = (
  bindings: readonly BackfillBronBinding[]
): MutableBackfillRunMetrics => ({
  ...emptyPlatformMetrics(),
  platforms: Object.fromEntries(
    bindings.map((binding) => [binding.platform, emptyPlatformMetrics()])
  ),
});

const incrementMetric = (
  metrics: MutableBackfillRunMetrics,
  platform: string,
  key: BackfillMetricKey
): void => {
  metrics[key] += 1;
  const platformMetrics = metrics.platforms[platform] ?? emptyPlatformMetrics();
  metrics.platforms[platform] = platformMetrics;
  platformMetrics[key] += 1;
};

const mergeMetrics = (
  target: MutableBackfillRunMetrics,
  completed: MutableBackfillRunMetrics
): void => {
  for (const key of [
    "duplicates",
    "errors",
    "extra",
    "found",
    "imported",
    "matched",
    "missing",
    "rejected",
    "selected",
    "skipped",
  ] as const) {
    target[key] += completed[key];
  }
  for (const [platform, completedPlatform] of Object.entries(
    completed.platforms
  )) {
    const targetPlatform = target.platforms[platform] ?? emptyPlatformMetrics();
    target.platforms[platform] = targetPlatform;
    for (const key of [
      "duplicates",
      "errors",
      "extra",
      "found",
      "imported",
      "matched",
      "missing",
      "rejected",
      "selected",
      "skipped",
    ] as const) {
      targetPlatform[key] += completedPlatform[key];
    }
  }
};

const platformForJob = (
  bindings: readonly BackfillBronBinding[],
  job: NeonV1JobRow
): string =>
  resolveBinding(bindings, job.platform)?.platform ||
  job.platform ||
  "__unbound__";

const snapshotMetrics = (
  metrics: MutableBackfillRunMetrics
): BackfillRunEvidence["metrics"] => ({
  duplicates: metrics.duplicates,
  errors: metrics.errors,
  extra: metrics.extra,
  found: metrics.found,
  imported: metrics.imported,
  matched: metrics.matched,
  missing: metrics.missing,
  platforms: Object.fromEntries(
    Object.entries(metrics.platforms)
      .toSorted(([left], [right]) => compareCodeUnits(left, right))
      .map(([platform, platformMetrics]) => [platform, { ...platformMetrics }])
  ),
  rejected: metrics.rejected,
  selected: metrics.selected,
  skipped: metrics.skipped,
});

const backfillEvidence = (
  execution: BackfillExecution,
  metrics: MutableBackfillRunMetrics,
  artifacts: BackfillEvidenceArtifacts,
  failure?: BackfillFailureEvidence
): BackfillRunEvidence => {
  let evidence: BackfillRunEvidence = {
    execution: { ...execution },
    metrics: snapshotMetrics(metrics),
  };
  if (artifacts.scopeManifest) {
    evidence = {
      ...evidence,
      scopeManifest: structuredClone(artifacts.scopeManifest),
    };
  }
  if (artifacts.targetReconciliation) {
    evidence = {
      ...evidence,
      targetReconciliation: structuredClone(artifacts.targetReconciliation),
    };
  }
  return failure ? { ...evidence, failure: { ...failure } } : evidence;
};

const backfillResult = (
  execution: BackfillExecution,
  metrics: MutableBackfillRunMetrics,
  artifacts: BackfillEvidenceArtifacts,
  status: BackfillRunResult["status"],
  failure?: BackfillFailureEvidence
): BackfillRunResult => {
  const evidence = backfillEvidence(execution, metrics, artifacts, failure);
  return { evidence, metrics: evidence.metrics, status };
};

class BackfillFailureError extends Error {
  readonly failure: BackfillFailureEvidence;
  readonly metricRecorded: boolean;

  constructor(
    failure: BackfillFailureEvidence,
    metricRecorded = false,
    options: { cause?: unknown } = {}
  ) {
    const validated = backfillFailureEvidenceSchema.parse(failure);
    super(`Motian v1 backfill failed during ${validated.phase}`, {
      cause: options.cause,
    });
    this.name = "BackfillFailureError";
    this.failure = validated;
    this.metricRecorded = metricRecorded;
  }
}

const CANONICAL_LOWERCASE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * Canonical lowercase UUIDs contain only ASCII hex digits with hyphens at
 * fixed positions. Within that constrained shape, native database collation,
 * byte order, and JavaScript code-unit order agree, so the database can use
 * its ordinary primary-key index without forcing a different collation.
 */
const assertCanonicalOrderedId = (
  id: string,
  failure: BackfillFailureEvidence,
  origin: "source" | "target"
): void => {
  if (!CANONICAL_LOWERCASE_UUID_PATTERN.test(id)) {
    throw new BackfillFailureError(failure, false, {
      cause: new Error(
        `${origin} id has a non-canonical shape; expected lowercase UUID, received ${id}`
      ),
    });
  }
};

interface BackfillFailureLocation {
  readonly platform: string;
  readonly sourceJobId: string;
}

export interface BackfillFailureDiagnostic extends BackfillFailureLocation {
  /** In-process only. Callers must sanitize the cause before emitting it. */
  readonly error: Error;
}

const failureLocations = new WeakMap<
  BackfillFailureError,
  BackfillFailureLocation
>();
const failureDiagnostics = new WeakMap<
  BackfillRunResult,
  BackfillFailureDiagnostic
>();

const withFailureLocation = (
  error: BackfillFailureError,
  location: BackfillFailureLocation
): BackfillFailureError => {
  failureLocations.set(error, location);
  return error;
};

export const getBackfillFailureDiagnostic = (
  result: BackfillRunResult
): BackfillFailureDiagnostic | undefined => failureDiagnostics.get(result);

const isBackfillFailure = (cause: unknown): cause is BackfillFailureError =>
  cause instanceof BackfillFailureError;

const provenanceMatches = (
  actual: BackfillProvenanceRecord,
  expected: Omit<BackfillProvenanceRecord, "aanvraagId">,
  expectedRawPayloadRef?: string
): boolean => {
  const addressed = parseContentAddressedRawObjectPath(actual.rawPayloadRef);
  return (
    actual.v1Id === expected.v1Id &&
    actual.bronId === expected.bronId &&
    actual.bronReferentie === expected.bronReferentie &&
    actual.contentHash === expected.contentHash &&
    addressed?.contentHash === expected.contentHash &&
    (expectedRawPayloadRef === undefined ||
      actual.rawPayloadRef === expectedRawPayloadRef)
  );
};

const provenanceIdentityMatches = (
  actual: BackfillProvenanceRecord,
  expected: Omit<BackfillProvenanceRecord, "aanvraagId">
): boolean =>
  actual.v1Id === expected.v1Id &&
  actual.bronId === expected.bronId &&
  actual.bronReferentie === expected.bronReferentie;

const readProvenance = async (
  provenanceStore: RunNeonV1BackfillInput["provenanceStore"],
  v1Id: string
): Promise<BackfillProvenanceRecord | null> => {
  try {
    return await provenanceStore.findByV1Id(v1Id);
  } catch (error) {
    throw new BackfillFailureError(
      {
        code: "PROVENANCE_READ_FAILED",
        phase: "provenance",
      },
      false,
      { cause: error }
    );
  }
};

const requireRawReadback = async (input: {
  body: Uint8Array;
  contentHash: string;
  objectStore: ObjectStore;
  rawPayloadRef: string;
}): Promise<void> => {
  let stored;
  try {
    stored = await input.objectStore.get(input.rawPayloadRef);
  } catch (error) {
    throw new BackfillFailureError(
      {
        code: "RAW_READBACK_FAILED",
        phase: "raw-write",
      },
      false,
      { cause: error }
    );
  }
  if (!stored || stored.contentType !== "json") {
    throw new BackfillFailureError({
      code: "RAW_READBACK_FAILED",
      phase: "raw-write",
    });
  }

  let readbackHash: string;
  try {
    readbackHash = await hashContent(stored.body);
  } catch (error) {
    throw new BackfillFailureError(
      {
        code: "RAW_READBACK_FAILED",
        phase: "raw-write",
      },
      false,
      { cause: error }
    );
  }
  if (
    readbackHash !== input.contentHash ||
    !bytesEqual(stored.body, input.body)
  ) {
    throw new BackfillFailureError({
      code: "RAW_READBACK_FAILED",
      phase: "raw-write",
    });
  }
};

const existingRawMatches = async (input: {
  body: Uint8Array;
  contentHash: string;
  objectStore: ObjectStore;
  rawPayloadRef: string;
}): Promise<boolean> => {
  let stored;
  try {
    stored = await input.objectStore.get(input.rawPayloadRef);
  } catch (error) {
    throw new BackfillFailureError(
      {
        code: "RAW_READBACK_FAILED",
        phase: "raw-write",
      },
      false,
      { cause: error }
    );
  }
  if (!stored) {
    return false;
  }
  let readbackHash: string;
  try {
    readbackHash = await hashContent(stored.body);
  } catch (error) {
    throw new BackfillFailureError(
      {
        code: "RAW_READBACK_FAILED",
        phase: "raw-write",
      },
      false,
      { cause: error }
    );
  }
  if (
    stored.contentType !== "json" ||
    stored.body.byteLength !== input.body.byteLength ||
    readbackHash !== input.contentHash ||
    !bytesEqual(stored.body, input.body)
  ) {
    throw new BackfillFailureError({
      code: "RAW_READBACK_FAILED",
      phase: "raw-write",
    });
  }
  return true;
};

const persistAndVerifyRaw = async (input: {
  body: Uint8Array;
  contentHash: string;
  job: NeonV1JobRow;
  objectStore: ObjectStore;
  startedAt: Date;
}): Promise<string> => {
  const rawPayloadRef = buildContentAddressedRawObjectPath({
    bronSlug: input.job.platform,
    contentHash: input.contentHash,
    contentType: "json",
    startedAt: input.startedAt,
  });
  if (
    await existingRawMatches({
      body: input.body,
      contentHash: input.contentHash,
      objectStore: input.objectStore,
      rawPayloadRef,
    })
  ) {
    return rawPayloadRef;
  }
  try {
    await putRawWithRetry(input.objectStore, {
      body: input.body,
      contentType: "json",
      expiresAt: new Date(input.startedAt.getTime() + 90 * 86_400_000),
      path: rawPayloadRef,
    });
  } catch (error) {
    throw new BackfillFailureError(
      {
        code: "RAW_WRITE_FAILED",
        phase: "raw-write",
      },
      false,
      { cause: error }
    );
  }
  await requireRawReadback({
    body: input.body,
    contentHash: input.contentHash,
    objectStore: input.objectStore,
    rawPayloadRef,
  });
  return rawPayloadRef;
};

interface PreparedNeonV1Job {
  readonly contentHash: string;
  readonly job: NeonV1JobRow;
  readonly rawBody: Uint8Array;
}

/**
 * Refuses a v1 row that would curate onto an aanvraag already bound to a
 * different v1 id, BEFORE curation. curateObservation commits its own
 * transaction (aanvraag update, version, outbox event), so a provenance
 * failure after it would leave current data from this row under the first
 * row's v1_id with nothing rolling those writes back. Fixture and production
 * stores share this check; the Postgres UPDATE guard stays as the last line.
 */
const requireIdentityUnboundOrOwn = async (input: {
  bronId: string;
  curateStore: CurateStore;
  job: NeonV1JobRow;
  provenanceStore: RunNeonV1BackfillInput["provenanceStore"];
}): Promise<void> => {
  const identityMatch = await input.curateStore.findAanvraagByIdentity(
    input.bronId,
    input.job.external_id
  );
  if (!identityMatch) {
    return;
  }
  let bound: BackfillProvenanceRecord | null;
  try {
    bound = await input.provenanceStore.findByAanvraagId(
      identityMatch.aanvraagId
    );
  } catch (error) {
    throw new BackfillFailureError(
      {
        code: "PROVENANCE_READ_FAILED",
        phase: "provenance",
      },
      false,
      { cause: error }
    );
  }
  if (bound && bound.v1Id !== input.job.id) {
    throw new BackfillFailureError({
      code: "PROVENANCE_MISMATCH",
      phase: "provenance",
    });
  }
};

const importNeonV1Job = async (input: {
  curateStore: CurateStore;
  job: NeonV1JobRow;
  bindings: readonly BackfillBronBinding[];
  metrics: MutableBackfillRunMetrics;
  objectStore: ObjectStore;
  provenanceStore: RunNeonV1BackfillInput["provenanceStore"];
  scrapeRunId: string;
  starappleLiveIndex?: StarappleLiveIndex;
  startedAt: Date;
  prepared: PreparedNeonV1Job;
}): Promise<BackfillProvenanceRecord | null> => {
  const { contentHash, job, rawBody } = input.prepared;
  const platformBinding = resolveBinding(input.bindings, job.platform);
  const platform =
    platformBinding?.platform ?? platformForJob(input.bindings, job);
  incrementMetric(input.metrics, platform, "found");
  incrementMetric(input.metrics, platform, "selected");
  if (!platformBinding) {
    incrementMetric(input.metrics, platform, "rejected");
    return null;
  }

  try {
    const expectedProvenance = {
      bronId: platformBinding.bronId,
      bronReferentie: input.job.external_id,
      contentHash,
      rawPayloadRef: "",
      v1Id: input.job.id,
    };
    const existing = await readProvenance(input.provenanceStore, input.job.id);
    if (existing && !provenanceIdentityMatches(existing, expectedProvenance)) {
      throw new BackfillFailureError({
        code: "PROVENANCE_MISMATCH",
        phase: "provenance",
      });
    }

    if (existing && provenanceMatches(existing, expectedProvenance)) {
      await requireRawReadback({
        body: rawBody,
        contentHash,
        objectStore: input.objectStore,
        rawPayloadRef: existing.rawPayloadRef,
      });
      incrementMetric(input.metrics, platform, "matched");
      incrementMetric(input.metrics, platform, "skipped");
      return existing;
    }

    const isContentDrift = existing !== null;

    await requireIdentityUnboundOrOwn({
      bronId: platformBinding.bronId,
      curateStore: input.curateStore,
      job: input.job,
      provenanceStore: input.provenanceStore,
    });

    const draftBase = mapV1JobToDraft(input.job, input.starappleLiveIndex);
    const draft: NormalisedAanvraagDraft = {
      ...draftBase,
      contentHash,
    };
    const rawPayloadRef = await persistAndVerifyRaw({
      body: rawBody,
      contentHash,
      job: input.job,
      objectStore: input.objectStore,
      startedAt: input.startedAt,
    });

    let curated;
    try {
      curated = await curateObservation(input.curateStore, {
        bronId: platformBinding.bronId,
        draft,
        observedAt: input.startedAt,
        rawPayloadRef,
        scrapeRunId: input.scrapeRunId,
      });
    } catch (error) {
      throw new BackfillFailureError(
        {
          code: "CURATE_FAILED",
          phase: "curate",
        },
        false,
        { cause: error }
      );
    }

    if (curated.status === "quarantined" || !curated.aanvraagId) {
      throw new BackfillFailureError({
        code: "CURATE_REJECTED",
        phase: "curate",
      });
    }

    const provenance: BackfillProvenanceRecord = {
      ...expectedProvenance,
      aanvraagId: curated.aanvraagId,
      rawPayloadRef,
    };
    let registered: BackfillProvenanceRecord;
    try {
      registered = await input.provenanceStore.registerV1Id(provenance);
    } catch (error) {
      throw new BackfillFailureError(
        {
          code: "PROVENANCE_WRITE_FAILED",
          phase: "provenance",
        },
        false,
        { cause: error }
      );
    }
    if (
      registered.aanvraagId !== curated.aanvraagId ||
      !provenanceMatches(registered, expectedProvenance, rawPayloadRef)
    ) {
      throw new BackfillFailureError({
        code: "PROVENANCE_MISMATCH",
        phase: "provenance",
      });
    }
    incrementMetric(input.metrics, platform, "matched");
    if (curated.status === "curated" || isContentDrift) {
      incrementMetric(input.metrics, platform, "imported");
    } else {
      incrementMetric(input.metrics, platform, "skipped");
    }
    return registered;
  } catch (error) {
    incrementMetric(input.metrics, platform, "errors");
    if (isBackfillFailure(error)) {
      throw withFailureLocation(
        new BackfillFailureError(error.failure, true, { cause: error.cause }),
        { platform, sourceJobId: input.job.id }
      );
    }
    throw withFailureLocation(
      new BackfillFailureError(
        { code: "CURATE_FAILED", phase: "curate" },
        true,
        { cause: error }
      ),
      { platform, sourceJobId: input.job.id }
    );
  }
};

const importNeonV1Jobs = async (input: {
  bindings: readonly BackfillBronBinding[];
  concurrency: number;
  curateStore: RunNeonV1BackfillInput["curateStore"];
  jobs: readonly NeonV1JobRow[];
  metrics: MutableBackfillRunMetrics;
  objectStore: RunNeonV1BackfillInput["objectStore"];
  provenanceStore: RunNeonV1BackfillInput["provenanceStore"];
  scrapeRunId: string;
  starappleLiveIndex?: StarappleLiveIndex;
  startedAt: Date;
}): Promise<readonly BackfillProvenanceRecord[]> => {
  const preparedJobs = await Promise.all(
    input.jobs.map(async (job): Promise<PreparedNeonV1Job> => {
      try {
        const rawBody = rawBodyForJob(job);
        return { contentHash: await hashContent(rawBody), job, rawBody };
      } catch (error) {
        const platform = platformForJob(input.bindings, job);
        incrementMetric(input.metrics, platform, "found");
        incrementMetric(input.metrics, platform, "selected");
        incrementMetric(input.metrics, platform, "errors");
        throw withFailureLocation(
          new BackfillFailureError(
            { code: "RAW_WRITE_FAILED", phase: "raw-write" },
            true,
            { cause: error }
          ),
          {
            platform,
            sourceJobId: job.id,
          }
        );
      }
    })
  );
  const activeIdentityKeys = new Set<string>();
  const activeContentHashes = new Set<string>();
  const pendingIndexes = preparedJobs.map((_job, index) => index);
  const results: (BackfillProvenanceRecord | null | undefined)[] = Array.from({
    length: input.jobs.length,
  });
  let firstFailure: BackfillFailureError | undefined;

  const takeNext = ():
    | { identityKey: string; index: number; prepared: PreparedNeonV1Job }
    | undefined => {
    if (firstFailure) {
      return undefined;
    }
    const pendingPosition = pendingIndexes.findIndex((index) => {
      const prepared = preparedJobs[index];
      if (!prepared) {
        return false;
      }
      const { contentHash, job } = prepared;
      const platform = platformForJob(input.bindings, job);
      return (
        !activeIdentityKeys.has(`${platform}\u0000${job.external_id}`) &&
        !activeContentHashes.has(contentHash)
      );
    });
    if (pendingPosition === -1) {
      return undefined;
    }
    const [index] = pendingIndexes.splice(pendingPosition, 1);
    const prepared = index === undefined ? undefined : preparedJobs[index];
    if (!prepared || index === undefined) {
      return undefined;
    }
    const { contentHash, job } = prepared;
    const platform = platformForJob(input.bindings, job);
    const identityKey = `${platform}\u0000${job.external_id}`;
    activeIdentityKeys.add(identityKey);
    activeContentHashes.add(contentHash);
    return { identityKey, index, prepared };
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const next = takeNext();
      if (!next) {
        return;
      }
      const completedMetrics = emptyMetrics(input.bindings);
      try {
        // oxlint-disable-next-line no-await-in-loop -- each bounded worker processes one row at a time
        results[next.index] = await importNeonV1Job({
          bindings: input.bindings,
          curateStore: input.curateStore,
          job: next.prepared.job,
          metrics: completedMetrics,
          objectStore: input.objectStore,
          prepared: next.prepared,
          provenanceStore: input.provenanceStore,
          scrapeRunId: input.scrapeRunId,
          starappleLiveIndex: input.starappleLiveIndex,
          startedAt: input.startedAt,
        });
      } catch (error) {
        if (!firstFailure && isBackfillFailure(error)) {
          firstFailure = error;
        }
      } finally {
        mergeMetrics(input.metrics, completedMetrics);
        activeIdentityKeys.delete(next.identityKey);
        activeContentHashes.delete(next.prepared.contentHash);
      }
    }
  };

  const workerCount = Math.min(input.concurrency, input.jobs.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (firstFailure) {
    throw firstFailure;
  }
  return results.filter(
    (record): record is BackfillProvenanceRecord =>
      record !== null && record !== undefined
  );
};

const importFromSource = async (input: {
  batchSize: number;
  bindings: readonly BackfillBronBinding[];
  concurrency: number;
  curateStore: RunNeonV1BackfillInput["curateStore"];
  metrics: MutableBackfillRunMetrics;
  objectStore: RunNeonV1BackfillInput["objectStore"];
  provenanceStore: RunNeonV1BackfillInput["provenanceStore"];
  scrapeRunId: string;
  source: NeonV1Source;
  starappleLiveIndex?: StarappleLiveIndex;
  startedAt: Date;
}): Promise<BackfillScopeManifest> => {
  const mappingDigest = createOrderedMappingDigest();
  let lastSourceId: string | null = null;
  let selected = 0;
  const consume = async (jobs: readonly NeonV1JobRow[]): Promise<void> => {
    for (const job of jobs) {
      assertCanonicalOrderedId(
        job.id,
        { code: "SOURCE_READ_FAILED", phase: "source-read" },
        "source"
      );
      if (lastSourceId !== null && job.id <= lastSourceId) {
        throw withFailureLocation(
          new BackfillFailureError({
            code: "SOURCE_READ_FAILED",
            phase: "source-read",
          }),
          {
            platform: platformForJob(input.bindings, job),
            sourceJobId: job.id,
          }
        );
      }
      lastSourceId = job.id;
      selected += 1;
    }
    const provenanceRecords = await importNeonV1Jobs({
      bindings: input.bindings,
      concurrency: input.concurrency,
      curateStore: input.curateStore,
      jobs,
      metrics: input.metrics,
      objectStore: input.objectStore,
      provenanceStore: input.provenanceStore,
      scrapeRunId: input.scrapeRunId,
      starappleLiveIndex: input.starappleLiveIndex,
      startedAt: input.startedAt,
    });
    for (const provenance of provenanceRecords) {
      const platform = input.bindings.find(
        (binding) => binding.bronId === provenance.bronId
      )?.platform;
      if (!platform) {
        throw withFailureLocation(
          new BackfillFailureError({
            code: "SOURCE_READ_FAILED",
            phase: "source-read",
          }),
          {
            platform: SOURCE_FAILURE_PLATFORM,
            sourceJobId: provenance.v1Id,
          }
        );
      }
      appendOrderedMapping(mappingDigest, provenance, platform);
    }
  };

  try {
    let snapshot: BackfillSnapshotWindow;
    if (input.source.consumeSnapshot) {
      snapshot = await input.source.consumeSnapshot(input.batchSize, consume);
    } else if (input.source.streamBatches) {
      const startedAt = new Date().toISOString();
      for await (const batch of input.source.streamBatches(input.batchSize)) {
        await consume(batch);
      }
      snapshot = { completedAt: new Date().toISOString(), startedAt };
    } else {
      const startedAt = new Date().toISOString();
      const jobs = await input.source.loadJobs();
      await consume(jobs);
      snapshot = { completedAt: new Date().toISOString(), startedAt };
    }
    if (!isValidSnapshotWindow(snapshot)) {
      throw new BackfillFailureError({
        code: "SOURCE_READ_FAILED",
        phase: "source-read",
      });
    }
    return {
      contractVersion: BACKFILL_SCOPE_MANIFEST_VERSION,
      digestAlgorithm: "sha256",
      itemEncoding: "json-array-line/v1",
      order: "source-id-ascending",
      orderedDigest: orderedMappingHash(mappingDigest),
      platformCounts: { ...mappingDigest.platformCounts },
      selected,
      snapshot: { ...snapshot },
    };
  } catch (error) {
    if (isBackfillFailure(error)) {
      throw error;
    }
    throw withFailureLocation(
      new BackfillFailureError(
        {
          code: "SOURCE_READ_FAILED",
          phase: "source-read",
        },
        false,
        { cause: error }
      ),
      {
        platform: SOURCE_FAILURE_PLATFORM,
        sourceJobId: lastSourceId ?? UNKNOWN_SOURCE_JOB_ID,
      }
    );
  }
};

const syncAggregateReconciliation = (
  metrics: MutableBackfillRunMetrics
): void => {
  const platformMetrics = Object.values(metrics.platforms);
  for (const key of [
    "duplicates",
    "extra",
    "matched",
    "missing",
    "selected",
  ] as const) {
    metrics[key] = platformMetrics.reduce(
      (sum, platform) => sum + platform[key],
      0
    );
  }
};

const reconcileProvenance = async (input: {
  batchSize: number;
  bindings: readonly BackfillBronBinding[];
  metrics: MutableBackfillRunMetrics;
  provenanceStore: RunNeonV1BackfillInput["provenanceStore"];
  scopeManifest: BackfillScopeManifest;
}): Promise<BackfillTargetReconciliation> => {
  const bronIds = [...new Set(input.bindings.map((binding) => binding.bronId))];
  const platformByBronId = new Map(
    input.bindings.map((binding) => [binding.bronId, binding.platform])
  );
  const digest = createOrderedMappingDigest();
  const summaries: Record<string, { distinctV1Ids: number; records: number }> =
    {};
  const lastV1IdByBronId = new Map<string, string>();
  let snapshot: BackfillSnapshotWindow;
  try {
    snapshot = await input.provenanceStore.consumeReconciliationSnapshot(
      bronIds,
      input.batchSize,
      (batch) => {
        for (const record of batch) {
          const platform = platformByBronId.get(record.bronId);
          if (!platform) {
            throw new BackfillFailureError({
              code: "RECONCILIATION_READ_FAILED",
              phase: "reconcile",
            });
          }
          assertCanonicalOrderedId(
            record.v1Id,
            { code: "RECONCILIATION_READ_FAILED", phase: "reconcile" },
            "target"
          );
          if (digest.lastId !== null && record.v1Id < digest.lastId) {
            throw new BackfillFailureError({
              code: "RECONCILIATION_READ_FAILED",
              phase: "reconcile",
            });
          }
          appendOrderedMapping(digest, record, platform);
          const summary = summaries[record.bronId] ?? {
            distinctV1Ids: 0,
            records: 0,
          };
          summary.records += 1;
          if (lastV1IdByBronId.get(record.bronId) !== record.v1Id) {
            summary.distinctV1Ids += 1;
            lastV1IdByBronId.set(record.bronId, record.v1Id);
          }
          summaries[record.bronId] = summary;
        }
        return Promise.resolve();
      }
    );
  } catch (error) {
    if (isBackfillFailure(error)) {
      throw error;
    }
    throw new BackfillFailureError(
      {
        code: "RECONCILIATION_READ_FAILED",
        phase: "reconcile",
      },
      false,
      { cause: error }
    );
  }

  if (!isValidSnapshotWindow(snapshot)) {
    throw new BackfillFailureError({
      code: "RECONCILIATION_READ_FAILED",
      phase: "reconcile",
    });
  }

  const configuredPlatforms = new Set<string>();
  for (const binding of input.bindings) {
    configuredPlatforms.add(binding.platform);
    const platformMetrics =
      input.metrics.platforms[binding.platform] ?? emptyPlatformMetrics();
    input.metrics.platforms[binding.platform] = platformMetrics;
    const summary = summaries[binding.bronId] ?? {
      distinctV1Ids: 0,
      records: 0,
    };
    const sourceCount =
      input.scopeManifest.platformCounts[binding.platform] ?? 0;
    platformMetrics.matched = Math.min(
      platformMetrics.matched,
      summary.distinctV1Ids,
      sourceCount
    );
    platformMetrics.missing = Math.max(sourceCount - summary.distinctV1Ids, 0);
    platformMetrics.extra = Math.max(summary.distinctV1Ids - sourceCount, 0);
    platformMetrics.duplicates = Math.max(
      summary.records - summary.distinctV1Ids,
      0
    );
  }

  for (const [platform, platformMetrics] of Object.entries(
    input.metrics.platforms
  )) {
    if (!configuredPlatforms.has(platform)) {
      platformMetrics.missing = Math.max(
        platformMetrics.selected - platformMetrics.matched,
        0
      );
    }
  }
  syncAggregateReconciliation(input.metrics);
  const orderedDigest = orderedMappingHash(digest);
  return {
    contractVersion: BACKFILL_TARGET_RECONCILIATION_VERSION,
    digestAlgorithm: "sha256",
    distinctV1Ids: Object.values(summaries).reduce(
      (sum, summary) => sum + summary.distinctV1Ids,
      0
    ),
    itemEncoding: "json-array-line/v1",
    matchesScope:
      digest.records === input.scopeManifest.selected &&
      orderedDigest === input.scopeManifest.orderedDigest,
    order: "source-id-ascending",
    orderedDigest,
    platformCounts: { ...digest.platformCounts },
    records: digest.records,
    snapshot: { ...snapshot },
  };
};

const assertNoImportFailures = (
  metrics: MutableBackfillRunMetrics,
  targetReconciliation: BackfillTargetReconciliation
): void => {
  const hasDrift =
    metrics.missing > 0 ||
    metrics.extra > 0 ||
    metrics.duplicates > 0 ||
    !targetReconciliation.matchesScope;
  if (metrics.errors > 0 || metrics.rejected > 0 || hasDrift) {
    throw new BackfillFailureError(
      { code: "RECONCILIATION_DRIFT", phase: "reconcile" },
      true
    );
  }
};

const recordBackfillFailure = async (input: {
  artifacts: BackfillEvidenceArtifacts;
  cause: unknown;
  execution: BackfillExecution;
  metrics: MutableBackfillRunMetrics;
  runStore: RunNeonV1BackfillInput["runStore"];
  scrapeRunId: string;
}): Promise<BackfillRunResult> => {
  const failure = isBackfillFailure(input.cause)
    ? input.cause.failure
    : backfillFailureEvidenceSchema.parse({
        code: "RECONCILIATION_READ_FAILED",
        phase: "reconcile",
      });
  const failureError = isBackfillFailure(input.cause)
    ? input.cause
    : new BackfillFailureError(failure, false, { cause: input.cause });
  if (!isBackfillFailure(input.cause) || !input.cause.metricRecorded) {
    const failurePlatform =
      failure.phase === "source-read"
        ? SOURCE_FAILURE_PLATFORM
        : "__reconcile__";
    incrementMetric(input.metrics, failurePlatform, "errors");
  }
  const result = backfillResult(
    input.execution,
    input.metrics,
    input.artifacts,
    "failed",
    failure
  );
  const location = failureLocations.get(failureError) ?? {
    platform:
      failure.phase === "source-read"
        ? SOURCE_FAILURE_PLATFORM
        : RECONCILIATION_FAILURE_PLATFORM,
    sourceJobId: UNKNOWN_SOURCE_JOB_ID,
  };
  failureDiagnostics.set(result, { error: failureError, ...location });
  await input.runStore.failRun(input.scrapeRunId, failure, result.evidence);
  return result;
};

export const runNeonV1Backfill = async (
  input: RunNeonV1BackfillInput
): Promise<BackfillRunResult> => {
  const execution = input.execution ?? DEFAULT_BACKFILL_EXECUTION;
  const concurrency = input.concurrency ?? NEON_V1_DEFAULT_CONCURRENCY;
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > NEON_V1_MAX_CONCURRENCY
  ) {
    throw new Error(
      `Motian v1 backfill concurrency must be an integer between 1 and ${NEON_V1_MAX_CONCURRENCY}`
    );
  }
  if (execution.mode === "production" && execution.scope !== "full") {
    throw new Error("Production Motian v1 backfills require scope: full");
  }
  if (execution.mode === "production" && !input.source.consumeSnapshot) {
    throw new Error(
      "Production Motian v1 backfills require a consistent source snapshot"
    );
  }
  const startedAt = input.startedAt ?? new Date();
  const metrics = emptyMetrics(input.bindings);
  const artifacts: BackfillEvidenceArtifacts = {};
  const [primaryBinding] = input.bindings;
  const primaryBronId =
    primaryBinding?.bronId ?? "00000000-0000-4000-8000-000000000099";
  const { scrapeRunId } = await input.runStore.startRun(primaryBronId);
  const batchSize = input.batchSize ?? 1000;

  try {
    artifacts.scopeManifest = await importFromSource({
      batchSize,
      bindings: input.bindings,
      concurrency,
      curateStore: input.curateStore,
      metrics,
      objectStore: input.objectStore,
      provenanceStore: input.provenanceStore,
      scrapeRunId,
      source: input.source,
      starappleLiveIndex: input.starappleLiveIndex,
      startedAt,
    });
    artifacts.targetReconciliation = await reconcileProvenance({
      batchSize,
      bindings: input.bindings,
      metrics,
      provenanceStore: input.provenanceStore,
      scopeManifest: artifacts.scopeManifest,
    });
    assertNoImportFailures(metrics, artifacts.targetReconciliation);

    const result = backfillResult(execution, metrics, artifacts, "succeeded");
    await input.runStore.completeRun(scrapeRunId, result.evidence);
    return result;
  } catch (error) {
    return recordBackfillFailure({
      artifacts,
      cause: error,
      execution,
      metrics,
      runStore: input.runStore,
      scrapeRunId,
    });
  }
};
