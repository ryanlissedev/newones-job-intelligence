import { processObservation } from "@ji/application/identity";
import type { SupportedBronSlug } from "@ji/application/identity";
import { SOURCES } from "@ji/application/sources";
import { CONNECTOR_OBSERVATION_CONTRACT_VERSION } from "@ji/connectors";
import type {
  ConnectorObservation,
  ObjectStore,
  StoredObject,
} from "@ji/connectors";
import type { BronId, ScrapeRunId } from "@ji/domain";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  min,
  notInArray,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { compareSourcePointerOrder } from "./bron-runtime";
import type { BronRuntimeDatabase } from "./bron-runtime";
import {
  causeChain,
  describeCauseChain,
  errorNameOf,
} from "./error-cause-chain";
import type { ThrownValue } from "./error-cause-chain";
import { PostgresCurateStore } from "./postgres-curate-store";
import type { PostgresCurateTransaction } from "./postgres-curate-store";
import { redactConnectionUrls } from "./redact-connection-urls";
import { aanvraag, aanvraagVersie, scrapeRun } from "./schema/curated";
import { aanvraagObservation, sourceRecord } from "./schema/staging";

const DEFAULT_ATTEMPT_LIMIT = 100;
const SCAN_MULTIPLIER = 10;
const ACTIVE_STATUSES = ["awaiting_curation", "pending"] as const;
const MISSING_RAW_STATUSES = [
  "deferred_missing_raw",
  "deferred_missing_raw_legacy",
] as const;
const BLOCKED_STATUSES = [
  "blocked_ordering",
  "blocked_ordering_legacy",
] as const;
export const RECOVERABLE_STATUSES = [
  ...ACTIVE_STATUSES,
  ...MISSING_RAW_STATUSES,
  ...BLOCKED_STATUSES,
] as const;
const APPLIED_STATUSES = new Set(["already_committed", "curated", "unchanged"]);

/**
 * Statuses that produce candidates. `deferred_missing_raw*` rows are
 * recoverable for `hasEarlierRecoverable` and `remaining` purposes but are
 * never processed: they wait on an operator requeue, so they do not rank
 * identities and are not loaded as candidates.
 */
const CANDIDATE_STATUSES = [...ACTIVE_STATUSES, ...BLOCKED_STATUSES] as const;

/**
 * How many dominated rows one pass may supersede in a single statement.
 *
 * The dominated sweep exists for the Bij Oranje treadmill (CTP-621): roughly
 * 85% of that backlog is `unchanged` re-observations whose later sibling
 * already carries the same content, so marking them `superseded` is the only
 * way intake stops outrunning the curation budget. The bound keeps one UPDATE
 * statement from locking an entire source's backlog at once; the sweep is
 * idempotent, so whatever is left is taken on the next pass.
 */
const DOMINATED_SWEEP_LIMIT = 5000;

/**
 * Terminal review status for an observation whose processing threw something
 * `processCandidate` does not classify.
 *
 * Deliberately absent from `RECOVERABLE_STATUSES`, so `loadCandidates` never
 * selects the row again and `markObservation` never writes over it: that is
 * what stops one poison observation from re-aborting every later pass.
 * CTP-499: observation 7100e5cb-... blocked 7,126 Harvey Nash observations
 * from 9 September because the rethrow below aborted the whole pass and the
 * row stayed `awaiting_curation`, so the next pass picked the same oldest
 * candidate and failed identically.
 *
 * `staging.aanvraag_observation.status` is a plain `text` column with a
 * `'pending'` default and no enum, `CHECK`, or foreign key (see
 * `packages/db/src/schema/staging.ts` and migration 0001), so this value needs
 * no migration. The only constrained column on that table is `outcome`
 * (`aanvraag_observation_outcome_check`, `IN ('new','changed','unchanged')`).
 *
 * Clearing it is a deliberate human act: fix the defect, then
 * `UPDATE ... SET status = 'awaiting_curation'` to re-queue. See
 * `docs/runbooks/onbox-poller.md`.
 */
const CURATION_FAILED_STATUS = "curation_failed";

/**
 * Statuses a later same-content sibling may carry while dominating an earlier
 * `unchanged` row. An applied sibling proves the refresh already landed and
 * allows an immediate mark; an active or ordering-blocked sibling can only
 * suppress the earlier row from this pass's candidacy, because it may still
 * fail or defer when attempted. Everything else is excluded: `curation_failed`
 * and the missing-raw deferrals are operator-revivable, and `superseded` or
 * `quarantined` rows are terminal without having applied, so none of them can
 * stand in for the earlier row.
 */
const DOMINATING_STATUSES = [
  ...CANDIDATE_STATUSES,
  "already_committed",
  "curated",
  "unchanged",
] as const;

/**
 * Distinct dominator raw objects one pass may read while proving a
 * will-apply sibling can stand in for the earlier row. An applied dominator
 * needs no read -- its raw was already consumed -- so the cap only bounds
 * siblings that have not processed yet; rows whose dominators go unchecked
 * simply stay recoverable and qualify on a later pass.
 */
const DOMINATED_RAW_CHECK_LIMIT = 500;

/** Enough of the chain to name the failing statement without flooding stderr. */
const MAX_LOGGED_CAUSE_LENGTH = 500;

/**
 * How many observations one pass may park before it gives up and throws.
 *
 * Parking is for a row that is individually bad. A systemic in-loop failure --
 * a revoked grant, a half-applied deploy, a constraint added ahead of the code
 * that satisfies it -- looks identical one row at a time, and without a cap it
 * would quietly park an entire backlog inside a single poll budget. Five is
 * enough that a handful of genuinely bad rows still clear in one pass, and
 * small enough that a systemic fault stops the pass while nearly all of the
 * backlog is still recoverable. Rows already parked stay parked and the
 * progress of the pass is kept; the next poll continues from there.
 */
const MAX_PARKED_PER_PASS = 5;

/**
 * Postgres SQLSTATE classes that say "try again", not "this row is bad".
 *
 * - `08` connection exception: a pooled connection reset mid-transaction.
 * - `40` transaction rollback: `40001` serialization failure and `40P01`
 *   deadlock. `processCandidate` takes `FOR UPDATE` on the source record and
 *   `FOR KEY SHARE` on the run while lifecycle reconciliation touches the same
 *   rows, so a deadlock is an ordinary outcome, not a defect in the row.
 * - `53` insufficient resources: out of memory, connection slots, disk.
 * - `57` operator intervention: `57P01` admin shutdown, `57P02` crash shutdown,
 *   `57P03` cannot connect now.
 *
 * Everything else is a property of the row and parks: `54000` (the CTP-499
 * oversized index tuple), `22*` data exceptions, `23*` integrity violations.
 */
const TRANSIENT_SQLSTATE_CLASSES = ["08", "40", "53", "57"] as const;

/**
 * postgres.js reports a client-side connection drop with its own literal codes
 * instead of a SQLSTATE (`node_modules/postgres/src/errors.js`), and a raw
 * socket failure surfaces as a Node system code. All of them are about the
 * connection, never about the row, so they abort the pass like `08*` does.
 */
const TRANSIENT_LITERAL_CODES = new Set([
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECTION_ENDED",
  "CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
]);

/**
 * Name carried by the error raised when the object store refuses to answer, as
 * distinct from answering "no such object".
 *
 * These are not interchangeable. An absent object defers to
 * `deferred_missing_raw`, which is a review status an operator requeues by hand
 * (`docs/runbooks/curation-recovery.md`). A store that is merely unreachable
 * would strand every row it touched behind that manual step, so it aborts the
 * pass instead and the next poll retries the whole backlog untouched.
 *
 * Tagged by `name` rather than by class, so the check survives the error
 * crossing a module boundary and needs no shared constructor identity.
 */
export const RAW_READ_ERROR_NAME = "RawReadError";

/** Name carried by the error raised when a pass hits {@link MAX_PARKED_PER_PASS}. */
export const TOO_MANY_PARKED_ERROR_NAME = "TooManyParkedObservationsError";

const namedError = (
  name: string,
  message: string,
  options?: { cause: unknown }
): Error => {
  const error = new Error(message, options);
  error.name = name;
  return error;
};

const rawReadError = (rawPayloadRef: string, cause: unknown): Error =>
  namedError(
    RAW_READ_ERROR_NAME,
    `Raw object read failed for ${rawPayloadRef}`,
    { cause }
  );

const isRawReadError = (input: ThrownValue): boolean =>
  input.error instanceof Error && input.error.name === RAW_READ_ERROR_NAME;

/** postgres.js hangs the SQLSTATE off `code`; nothing else on the error matters here. */
const SQLSTATE_SCHEMA = z.object({ code: z.string() });

/**
 * True when any link of the cause chain carries a transient SQLSTATE or one of
 * the client-side connection codes in {@link TRANSIENT_LITERAL_CODES}.
 *
 * The chain is walked rather than the outermost error inspected, because
 * Drizzle wraps the postgres.js error that actually carries `code`.
 */
export const isTransientPostgresError = (input: ThrownValue): boolean =>
  causeChain(input).some((link) => {
    const parsed = SQLSTATE_SCHEMA.safeParse(link);
    return (
      parsed.success &&
      (TRANSIENT_LITERAL_CODES.has(parsed.data.code) ||
        TRANSIENT_SQLSTATE_CLASSES.some((klass) =>
          parsed.data.code.startsWith(klass)
        ))
    );
  });

const OBSERVATION_SCHEMA = z.object({
  bronId: z.string(),
  bronReferentie: z.string().trim().min(1),
  contentHash: z.string().trim().min(1),
  contentType: z.enum(["html", "json", "pdf"]),
  contractVersion: z.literal(CONNECTOR_OBSERVATION_CONTRACT_VERSION),
  observedAt: z.iso.datetime({ offset: true }),
  rawPayloadRef: z.string().trim().min(1),
  scrapeRunId: z.string(),
  sourceRecordId: z.string(),
});

/**
 * The full contract check `loadCandidates` applies to a scanned row, exported
 * so the dominated-unchanged sweep and the operator repair tool can hold a
 * would-be dominator to the same standard: a sibling that could not itself be
 * processed must not stand in for the earlier row.
 */
export const isValidCandidatePayload = (row: {
  bronId: string;
  bronReferentie: string;
  contentHash: string;
  payload: unknown;
  runBronId: string;
  scrapeRunId: string;
  sourceRecordBronId: string;
  sourceRecordId: string;
}): boolean => {
  const parsed = OBSERVATION_SCHEMA.safeParse(row.payload);
  return (
    parsed.success &&
    parsed.data.bronId === row.bronId &&
    parsed.data.bronReferentie === row.bronReferentie &&
    parsed.data.contentHash === row.contentHash &&
    parsed.data.scrapeRunId === row.scrapeRunId &&
    parsed.data.sourceRecordId === row.sourceRecordId &&
    row.runBronId === row.bronId &&
    row.sourceRecordBronId === row.bronId
  );
};

type RecoveryDisposition =
  | "already_committed"
  | "blocked_ordering"
  | "process"
  | "superseded"
  | "unchanged";

type CandidateDisposition =
  | Exclude<RecoveryDisposition, "process">
  | "curated"
  | "curation_failed"
  | "pending"
  | "quarantined";

interface PersistedPointer {
  contentHash: string;
  observedAt: string;
  phase: "ambiguous" | "lifecycle" | "observation";
  rawPayloadRef: string;
  scrapeRunId: string;
  startedAt: Date;
}

interface RecoveryCandidate {
  bronId: string;
  contentHash: string;
  createdAt: Date;
  id: string;
  payload: ConnectorObservation;
  runBronId: string;
  runStartedAt: Date;
  scrapeRunId: string;
  sourceRecordId: string;
  sourceRecordBronId: string;
  status: string;
}

type RecoveryDatabase = BronRuntimeDatabase | PostgresCurateTransaction;

/**
 * Run statuses whose observations a pass may recover. The poll path only ever
 * curates `succeeded` runs; the operator recovery tool
 * (`tools/backfill/recover-failed-run-observations.ts`, CTP-625) widens the
 * set to `failed`/`cancelled` so a run that died after recording still yields
 * its usable observations.
 */
export type EligibleRunStatus = "cancelled" | "failed" | "succeeded";

const DEFAULT_ELIGIBLE_RUN_STATUSES: readonly EligibleRunStatus[] = [
  "succeeded",
];

const eligibleRunStatuses = (input: CurateScrapeRunInput): string[] => [
  ...(input.eligibleRunStatuses ?? DEFAULT_ELIGIBLE_RUN_STATUSES),
];

export interface CurateScrapeRunInput {
  attemptLimit?: number;
  bronId: BronId;
  bronSlug: SupportedBronSlug;
  database: BronRuntimeDatabase;
  eligibleRunStatuses?: readonly EligibleRunStatus[];
  objectStore: ObjectStore;
  /** Runs after committed terminal work; telemetry errors must not park data. */
  onProgress?: () => Promise<void>;
  /**
   * Restrict the pass to observations recorded by `scrapeRunId` itself
   * (scoped recovery of one failed/cancelled run). The default pass scans
   * the bron's whole backlog. Ordering checks against committed history are
   * unchanged either way.
   */
  scopeToRun?: boolean;
  scrapeRunId: ScrapeRunId;
  signal?: AbortSignal;
}

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("Aborted", "AbortError");
  }
};

export interface CurateScrapeRunResult {
  alreadyCommitted: number;
  attemptedObservationIds: string[];
  blockedOrdering: number;
  curated: number;
  /** Candidates that threw and were parked on `curation_failed`. */
  failed: number;
  pending: number;
  quarantined: number;
  superseded: number;
  unchanged: number;
  remaining: number;
}

export const classifyRecoveryCandidate = (input: {
  candidate: PersistedPointer;
  current: PersistedPointer | null;
  legacyPending: boolean;
}): RecoveryDisposition => {
  if (!input.current) {
    return "process";
  }
  const { candidate, current } = input;
  if (current.phase === "ambiguous") {
    return "blocked_ordering";
  }
  // Lifecycle reconciliation runs before curation and can write a version in
  // this same run with a later timestamp. That is a phase boundary, not proof
  // that this run's observation was already curated.
  if (
    candidate.scrapeRunId === current.scrapeRunId &&
    current.phase === "lifecycle"
  ) {
    return "process";
  }
  if (
    input.legacyPending &&
    current.phase === "observation" &&
    candidate.scrapeRunId === current.scrapeRunId &&
    candidate.contentHash === current.contentHash &&
    candidate.rawPayloadRef === current.rawPayloadRef
  ) {
    return "already_committed";
  }
  const order = compareSourcePointerOrder(candidate, current);
  if (!input.legacyPending && order === 0) {
    return "process";
  }
  if (
    input.legacyPending &&
    candidate.contentHash === current.contentHash &&
    order <= 0
  ) {
    return "unchanged";
  }
  if (order < 0) {
    return "superseded";
  }
  if (order === 0) {
    return "blocked_ordering";
  }
  return "process";
};

/**
 * The observation timestamp ordering key, compared as text rather than cast
 * to timestamptz. `compareSourcePointerOrder` is the contract for which row
 * is an identity's head, so the per-identity bound must order by the same
 * tuple or the bound can cut the head itself: a backfilled row has a late
 * `created_at` but an early pointer, and a `created_at`-ordered slice would
 * load only its successors, which then block on the unloaded head every
 * pass. Text ordering matches the comparator for the ISO-8601 values
 * connectors write, and -- unlike a cast -- a malformed `observedAt` can
 * never abort the candidate query and stall the whole source's recovery.
 */
const observedAtOrder = sql`${aanvraagObservation.payload}->>'observedAt'`;

const queryCandidates = (
  input: CurateScrapeRunInput,
  statuses: readonly string[],
  limit: number,
  sourceRecordId: string,
  excludedIds: readonly string[]
) =>
  input.database
    .select({
      bronId: aanvraagObservation.bronId,
      bronReferentie: sourceRecord.bronReferentie,
      contentHash: aanvraagObservation.contentHash,
      createdAt: aanvraagObservation.createdAt,
      id: aanvraagObservation.id,
      payload: aanvraagObservation.payload,
      runBronId: scrapeRun.bronId,
      runStartedAt: scrapeRun.gestart,
      scrapeRunId: aanvraagObservation.scrapeRunId,
      sourceRecordBronId: sourceRecord.bronId,
      sourceRecordId: aanvraagObservation.sourceRecordId,
      status: aanvraagObservation.status,
    })
    .from(aanvraagObservation)
    .innerJoin(scrapeRun, eq(scrapeRun.id, aanvraagObservation.scrapeRunId))
    .innerJoin(
      sourceRecord,
      eq(sourceRecord.id, aanvraagObservation.sourceRecordId)
    )
    .where(
      and(
        eq(aanvraagObservation.bronId, input.bronId),
        inArray(scrapeRun.status, eligibleRunStatuses(input)),
        inArray(aanvraagObservation.status, [...statuses]),
        eq(aanvraagObservation.sourceRecordId, sourceRecordId),
        input.scopeToRun
          ? eq(aanvraagObservation.scrapeRunId, input.scrapeRunId)
          : undefined,
        excludedIds.length > 0
          ? notInArray(aanvraagObservation.id, [...excludedIds])
          : undefined
      )
    )
    .orderBy(
      asc(scrapeRun.gestart),
      asc(observedAtOrder),
      asc(aanvraagObservation.scrapeRunId),
      asc(aanvraagObservation.contentHash),
      asc(sql`${aanvraagObservation.payload}->>'rawPayloadRef'`),
      asc(aanvraagObservation.id)
    )
    .limit(limit);

/**
 * How many per-identity candidate queries may run at once. Selection can
 * choose up to `2 * attemptLimit` identities, so one query each must still be
 * fanned out in bounded batches rather than all at once.
 */
const QUERY_BATCH_SIZE = 25;

/**
 * Picks which identities this pass works on, before any rows are loaded.
 *
 * CTP-621: the old scan took the first `scanLimit` rows by `created_at` and
 * forced every active row of the current run into the candidate map. On a
 * backlog deeper than the scan window that read the same oldest slice every
 * pass, so an identity whose head fell outside the window never appeared,
 * while its freshly injected current-run row became the de-facto head and was
 * parked `blocked_ordering`. Ranking identities by their earliest recoverable
 * `created_at` instead means a pass always sees each selected identity's true
 * head; up to `attemptLimit` identities observed in the current run are added
 * on top, so a brand-new identity with no backlog is not left to the next
 * poll. Both lists are capped: the pass attempts at most `attemptLimit`
 * candidates anyway, and an unbounded union would fan out one query per
 * current-run identity on every large scrape.
 */
export const candidateSourceRecordIds = async (
  input: CurateScrapeRunInput,
  attemptLimit: number
): Promise<string[]> => {
  const [ranked, currentRun] = await Promise.all([
    input.database
      .select({
        firstCreatedAt: min(aanvraagObservation.createdAt),
        sourceRecordId: aanvraagObservation.sourceRecordId,
      })
      .from(aanvraagObservation)
      .innerJoin(scrapeRun, eq(scrapeRun.id, aanvraagObservation.scrapeRunId))
      .where(
        and(
          eq(aanvraagObservation.bronId, input.bronId),
          inArray(scrapeRun.status, eligibleRunStatuses(input)),
          inArray(aanvraagObservation.status, [...CANDIDATE_STATUSES]),
          input.scopeToRun
            ? eq(aanvraagObservation.scrapeRunId, input.scrapeRunId)
            : undefined
        )
      )
      .groupBy(aanvraagObservation.sourceRecordId)
      .orderBy(asc(min(aanvraagObservation.createdAt)))
      .limit(attemptLimit),
    input.database
      .select({
        firstCreatedAt: min(aanvraagObservation.createdAt),
        sourceRecordId: aanvraagObservation.sourceRecordId,
      })
      .from(aanvraagObservation)
      .innerJoin(scrapeRun, eq(scrapeRun.id, aanvraagObservation.scrapeRunId))
      .where(
        and(
          eq(aanvraagObservation.bronId, input.bronId),
          inArray(scrapeRun.status, eligibleRunStatuses(input)),
          eq(aanvraagObservation.scrapeRunId, input.scrapeRunId),
          inArray(aanvraagObservation.status, [...ACTIVE_STATUSES])
        )
      )
      .groupBy(aanvraagObservation.sourceRecordId)
      .orderBy(asc(min(aanvraagObservation.createdAt)))
      .limit(attemptLimit),
  ]);
  const sourceRecordIds = ranked.map((row) => row.sourceRecordId);
  const seen = new Set(sourceRecordIds);
  for (const row of currentRun) {
    if (!seen.has(row.sourceRecordId)) {
      seen.add(row.sourceRecordId);
      sourceRecordIds.push(row.sourceRecordId);
    }
  }
  return sourceRecordIds;
};

/**
 * Marks `unchanged` observations `superseded` when they are provably no-op
 * refreshes: a later succeeded run holds the same `contentHash` for the same
 * source record, and the canonical record is already `active` on that hash.
 *
 * Both halves of that proof matter. Without the canonical check, an earlier
 * row could still be the one that reactivates a `stale` or `closed` record;
 * superseding it would move the lifecycle transition to the later sibling's
 * pointer and lose the SCD2 interval the earlier row would have written.
 * Without a dominator restricted to statuses that will apply or already did
 * and proven to have its raw object still readable, the earlier row could
 * be superseded behind a sibling that turns out to be unprocessable and
 * leaves nothing able to refresh the record. With both, a dominated row can
 * only ever repeat the refresh the sibling performs --
 * canonical content and status are already correct, so at worst a
 * `laatstGezienOp` update waits for the later observation, which reports the
 * truth more accurately anyway.
 *
 * Only applied dominators are marked here. A will-apply dominator instead
 * suppresses its predecessors for this pass: they are excluded from the
 * bounded per-identity slices and ignored by ordering checks, so they
 * consume no attempt slots and cannot deadlock an intervening sibling, but
 * they stay recoverable until a dominator actually applies -- a dominator
 * that then fails, defers, or stays blocked never strands the earlier
 * refresh. `markSuppressedBehindApplied` marks them after processing once
 * a dominator has applied, and the returned map carries both the
 * suppression set and the dominator ids that check needs.
 *
 * This is what made the Bij Oranje backlog a treadmill (CTP-621): ~85% of its
 * recoverable rows were dominated `unchanged` re-observations that the
 * bounded scan re-read every pass while real `new`/`changed` work starved
 * behind them.
 *
 * Ordering uses `scrape_run.gestart` like `compareSourcePointerOrder`, and the
 * `(scrapeRunId, sourceRecordId, contentHash)` unique constraint means a
 * sibling is always in a strictly later run, so no same-run row can dominate
 * itself. The row stays in the table with an honest terminal status, so
 * history is preserved.
 */
/** Redacted and length-capped, ready to go on a log line. */
const loggableCauseChain = (input: ThrownValue): string =>
  redactConnectionUrls(describeCauseChain(input)).slice(
    0,
    MAX_LOGGED_CAUSE_LENGTH
  );

/**
 * Reads the raw object, keeping "no such object" and "the store would not
 * answer" apart.
 *
 * `null` means absent, which the caller defers to `deferred_missing_raw`. A
 * throw means the store is unreachable, which says nothing about this row and
 * must not consume a review status, so it is retagged as `RawReadError`
 * and aborts the pass: the next poll then retries the whole backlog with every
 * row still in an active status.
 */
const readStoredRaw = async (
  objectStore: ObjectStore,
  rawPayloadRef: string
): Promise<StoredObject | null> => {
  try {
    return await objectStore.get(rawPayloadRef);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        causeChain: loggableCauseChain({ error }),
        errorName: errorNameOf({ error }),
        event: "curation_raw_read_failed",
        rawPayloadRef,
      })}\n`
    );
    throw rawReadError(rawPayloadRef, error);
  }
};

/**
 * A dominated `unchanged` row paired with one candidate dominator. Both the
 * runtime sweep and the operator repair tool produce this shape so the
 * dominator classification below is applied identically in each.
 */
export interface DominatedPair {
  dominatorBronId: string;
  dominatorBronReferentie: string;
  dominatorContentHash: string;
  dominatorId: string;
  dominatorPayload: unknown;
  dominatorRunBronId: string;
  dominatorScrapeRunId: string;
  dominatorSourceRecordBronId: string;
  dominatorSourceRecordId: string;
  dominatorStatus: string;
  id: string;
}

export interface ResolvedDominatedPairs {
  /**
   * Rows dominated by an already-applied sibling. The refresh provably
   * landed, so these may be marked `superseded` immediately.
   */
  appliedDominatedIds: Set<string>;
  /**
   * Rows dominated by a sibling that has not applied yet, mapped to the
   * dominator ids that stand for it. These are suppressed for the pass --
   * excluded from candidate slices and ordering checks -- but they are NOT
   * marked: a dominator that subsequently fails, defers, or stays blocked
   * leaves the row recoverable for the next pass.
   */
  willApplyDominatedBy: Map<string, Set<string>>;
}

/**
 * Splits dominated ids by dominator proof strength.
 *
 * A dominator stands when its payload passes the full contract check
 * candidate selection applies, and it either already applied (its raw was
 * consumed) or still will apply because its raw object is present. A
 * will-apply sibling whose raw is missing would defer to
 * `deferred_missing_raw` the first time it is attempted, so it cannot even
 * suppress the earlier row. Raw reads dedupe per `rawPayloadRef` and are
 * capped by DOMINATED_RAW_CHECK_LIMIT; an unreachable store aborts the pass
 * rather than silently disqualifying, matching candidate semantics. Without
 * an object store only the applied half is resolved.
 */
export const resolveDominatedPairs = async (input: {
  objectStore?: ObjectStore;
  pairs: readonly DominatedPair[];
}): Promise<ResolvedDominatedPairs> => {
  const appliedDominatedIds = new Set<string>();
  const willApplyDominatedBy = new Map<string, Set<string>>();
  const rawAvailability = new Map<string, boolean>();
  let rawChecks = 0;
  for (const pair of input.pairs) {
    if (
      appliedDominatedIds.has(pair.id) ||
      !isValidCandidatePayload({
        bronId: pair.dominatorBronId,
        bronReferentie: pair.dominatorBronReferentie,
        contentHash: pair.dominatorContentHash,
        payload: pair.dominatorPayload,
        runBronId: pair.dominatorRunBronId,
        scrapeRunId: pair.dominatorScrapeRunId,
        sourceRecordBronId: pair.dominatorSourceRecordBronId,
        sourceRecordId: pair.dominatorSourceRecordId,
      })
    ) {
      continue;
    }
    if (APPLIED_STATUSES.has(pair.dominatorStatus)) {
      appliedDominatedIds.add(pair.id);
      willApplyDominatedBy.delete(pair.id);
      continue;
    }
    if (!input.objectStore) {
      continue;
    }
    // SAFETY: isValidCandidatePayload validated every field consumed here.
    const { rawPayloadRef } = pair.dominatorPayload as ConnectorObservation;
    let available = rawAvailability.get(rawPayloadRef);
    if (available === false) {
      continue;
    }
    if (available === undefined) {
      if (rawChecks >= DOMINATED_RAW_CHECK_LIMIT) {
        continue;
      }
      rawChecks += 1;
      available =
        // oxlint-disable-next-line no-await-in-loop -- deduped reads bound the pass
        (await readStoredRaw(input.objectStore, rawPayloadRef)) !== null;
      rawAvailability.set(rawPayloadRef, available);
      if (!available) {
        continue;
      }
    }
    const dominators = willApplyDominatedBy.get(pair.id) ?? new Set<string>();
    dominators.add(pair.dominatorId);
    willApplyDominatedBy.set(pair.id, dominators);
  }
  return { appliedDominatedIds, willApplyDominatedBy };
};

const markDominatedUnchangedObservations = async (
  input: CurateScrapeRunInput
): Promise<{ marked: number; suppressedBy: Map<string, Set<string>> }> => {
  const dominatingObservation = alias(
    aanvraagObservation,
    "dominating_observation"
  );
  const dominatingRun = alias(scrapeRun, "dominating_run");
  // One pair per dominated row: its best dominator (an applied one first, else
  // the newest). A chain of N same-hash re-observations used to yield ~N²/2
  // pairs, so the 5000-pair sweep covered only a handful of rows per pass.
  // Now it covers 5000 rows, and their dominators collapse to the chain head,
  // which costs one raw check per identity instead of one per pair.
  const dominatedPairs = await input.database
    .selectDistinctOn([aanvraagObservation.id], {
      dominatorBronId: dominatingObservation.bronId,
      dominatorBronReferentie: sourceRecord.bronReferentie,
      dominatorContentHash: dominatingObservation.contentHash,
      dominatorId: dominatingObservation.id,
      dominatorPayload: dominatingObservation.payload,
      dominatorRunBronId: dominatingRun.bronId,
      dominatorScrapeRunId: dominatingObservation.scrapeRunId,
      dominatorSourceRecordBronId: sourceRecord.bronId,
      dominatorSourceRecordId: dominatingObservation.sourceRecordId,
      dominatorStatus: dominatingObservation.status,
      id: aanvraagObservation.id,
    })
    .from(aanvraagObservation)
    .innerJoin(
      scrapeRun,
      and(
        eq(scrapeRun.id, aanvraagObservation.scrapeRunId),
        inArray(scrapeRun.status, eligibleRunStatuses(input))
      )
    )
    .innerJoin(
      sourceRecord,
      eq(sourceRecord.id, aanvraagObservation.sourceRecordId)
    )
    .innerJoin(
      aanvraag,
      and(
        eq(aanvraag.bronId, aanvraagObservation.bronId),
        eq(aanvraag.bronReferentie, sourceRecord.bronReferentie),
        eq(aanvraag.contentHash, aanvraagObservation.contentHash),
        eq(aanvraag.status, "active")
      )
    )
    .innerJoin(
      dominatingObservation,
      and(
        eq(dominatingObservation.bronId, aanvraagObservation.bronId),
        eq(
          dominatingObservation.sourceRecordId,
          aanvraagObservation.sourceRecordId
        ),
        eq(dominatingObservation.contentHash, aanvraagObservation.contentHash),
        inArray(dominatingObservation.status, [...DOMINATING_STATUSES])
      )
    )
    .innerJoin(
      dominatingRun,
      and(
        eq(dominatingRun.id, dominatingObservation.scrapeRunId),
        eq(dominatingRun.status, "succeeded"),
        gt(dominatingRun.gestart, scrapeRun.gestart)
      )
    )
    .where(
      and(
        eq(aanvraagObservation.bronId, input.bronId),
        eq(aanvraagObservation.outcome, "unchanged"),
        inArray(aanvraagObservation.status, [...RECOVERABLE_STATUSES]),
        input.scopeToRun
          ? eq(aanvraagObservation.scrapeRunId, input.scrapeRunId)
          : undefined
      )
    )
    .orderBy(
      aanvraagObservation.id,
      desc(inArray(dominatingObservation.status, [...APPLIED_STATUSES])),
      desc(dominatingRun.gestart)
    )
    .limit(DOMINATED_SWEEP_LIMIT);
  const resolved = await resolveDominatedPairs({
    objectStore: input.objectStore,
    pairs: dominatedPairs,
  });
  for (const id of resolved.appliedDominatedIds) {
    resolved.willApplyDominatedBy.delete(id);
  }
  if (resolved.appliedDominatedIds.size === 0) {
    return { marked: 0, suppressedBy: resolved.willApplyDominatedBy };
  }
  const marked = await input.database
    .update(aanvraagObservation)
    .set({ status: "superseded" })
    .where(
      and(
        inArray(aanvraagObservation.id, [...resolved.appliedDominatedIds]),
        inArray(aanvraagObservation.status, [...RECOVERABLE_STATUSES])
      )
    )
    .returning({ id: aanvraagObservation.id });
  return { marked: marked.length, suppressedBy: resolved.willApplyDominatedBy };
};

/**
 * Marks suppressed rows whose dominator reached an applied status since the
 * pass resolved them. The canonical-hash proof was already established when
 * the row was suppressed, so it is not re-checked here: an applied dominator
 * means a strictly later same-content observation performed the refresh,
 * and marking the earlier `unchanged` row `superseded` matches the terminal
 * status pointer classification would give it behind applied history. A
 * dominator that failed, deferred, or stayed blocked marks nothing, so its
 * suppressed predecessors resume as ordinary candidates next pass.
 */
const markSuppressedBehindApplied = async (
  input: CurateScrapeRunInput,
  suppressedBy: ReadonlyMap<string, ReadonlySet<string>>
): Promise<number> => {
  if (suppressedBy.size === 0) {
    return 0;
  }
  const dominatorIds = [
    ...new Set([...suppressedBy.values()].flatMap((ids) => [...ids])),
  ];
  const appliedRows = await input.database
    .select({ id: aanvraagObservation.id })
    .from(aanvraagObservation)
    .where(
      and(
        inArray(aanvraagObservation.id, dominatorIds),
        inArray(aanvraagObservation.status, [...APPLIED_STATUSES])
      )
    );
  const applied = new Set(appliedRows.map((row) => row.id));
  const markable = [...suppressedBy.entries()]
    .filter(([, dominators]) => [...dominators].some((id) => applied.has(id)))
    .map(([id]) => id);
  if (markable.length === 0) {
    return 0;
  }
  const marked = await input.database
    .update(aanvraagObservation)
    .set({ status: "superseded" })
    .where(
      and(
        inArray(aanvraagObservation.id, markable),
        inArray(aanvraagObservation.status, [...RECOVERABLE_STATUSES])
      )
    )
    .returning({ id: aanvraagObservation.id });
  return marked.length;
};

const loadCandidates = async (
  input: CurateScrapeRunInput,
  attemptLimit: number,
  suppressed: ReadonlySet<string>
): Promise<{
  candidates: RecoveryCandidate[];
  invalidRows: { id: string; status: string }[];
}> => {
  const sourceRecordIds = await candidateSourceRecordIds(input, attemptLimit);
  // Bound per identity rather than globally: a global `created_at` window can
  // still exclude a selected identity's head entirely when earlier identities
  // own the oldest rows, which is the starvation this selection strategy is
  // meant to remove. Every selected identity contributes its head plus up to
  // SCAN_MULTIPLIER successors; longer tails reload on a later pass once the
  // head has applied. Suppressed rows are excluded in SQL, before the bound:
  // they must not fill the slice while their dominator falls beyond it, or
  // the suppression could never resolve and the same slice would repeat
  // every pass. Batches cap the fan-out at QUERY_BATCH_SIZE concurrent
  // queries.
  const suppressedIds = [...suppressed];
  const chainRows: Awaited<ReturnType<typeof queryCandidates>>[] = [];
  for (
    let index = 0;
    index < sourceRecordIds.length;
    index += QUERY_BATCH_SIZE
  ) {
    // oxlint-disable-next-line no-await-in-loop -- bounded batches cap query fan-out per pass
    const batch = await Promise.all(
      sourceRecordIds
        .slice(index, index + QUERY_BATCH_SIZE)
        .map((sourceRecordId) =>
          queryCandidates(
            input,
            CANDIDATE_STATUSES,
            SCAN_MULTIPLIER,
            sourceRecordId,
            suppressedIds
          )
        )
    );
    chainRows.push(...batch);
  }
  const rows = chainRows.flat();

  const candidates: RecoveryCandidate[] = [];
  const invalidRows: { id: string; status: string }[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) {
      continue;
    }
    seen.add(row.id);
    if (!isValidCandidatePayload(row)) {
      invalidRows.push({ id: row.id, status: row.status });
      continue;
    }
    // SAFETY: the schema validates every field consumed below; remaining
    // connector contract fields stay opaque to recovery classification.
    const payload = row.payload as ConnectorObservation;
    candidates.push({ ...row, payload });
  }
  return { candidates, invalidRows };
};

const isRecoverableStatus = (status: string): boolean =>
  RECOVERABLE_STATUSES.some((candidate) => candidate === status);

const isLegacyStatus = (status: string): boolean =>
  status === "pending" || status.endsWith("_legacy");

const blockedStatus = (status: string): string =>
  isLegacyStatus(status) ? "blocked_ordering_legacy" : "blocked_ordering";

const missingRawStatus = (status: string): string =>
  isLegacyStatus(status)
    ? "deferred_missing_raw_legacy"
    : "deferred_missing_raw";

const fairOldestFirst = (
  candidates: readonly RecoveryCandidate[],
  limit: number
): RecoveryCandidate[] => {
  const byIdentity = new Map<string, RecoveryCandidate[]>();
  for (const candidate of candidates) {
    const queue = byIdentity.get(candidate.sourceRecordId) ?? [];
    queue.push(candidate);
    byIdentity.set(candidate.sourceRecordId, queue);
  }
  for (const queue of byIdentity.values()) {
    queue.sort((left, right) =>
      compareSourcePointerOrder(
        { ...left.payload, startedAt: left.runStartedAt },
        { ...right.payload, startedAt: right.runStartedAt }
      )
    );
  }

  const ordered: RecoveryCandidate[] = [];
  while (ordered.length < limit) {
    let added = false;
    for (const queue of byIdentity.values()) {
      const candidate = queue.shift();
      if (candidate) {
        ordered.push(candidate);
        added = true;
        if (ordered.length === limit) {
          break;
        }
      }
    }
    if (!added) {
      break;
    }
  }
  return ordered;
};

const currentPointer = async (
  database: RecoveryDatabase,
  payload: ConnectorObservation
): Promise<PersistedPointer | null> => {
  const [row] = await database
    .select({
      contentHash: aanvraag.contentHash,
      observedAt: aanvraag.laatstGezienOp,
      rawPayloadRef: aanvraag.rawPayloadRef,
      scrapeRunId: aanvraag.scrapeRunId,
      startedAt: scrapeRun.gestart,
    })
    .from(aanvraag)
    .innerJoin(scrapeRun, eq(scrapeRun.id, aanvraag.scrapeRunId))
    .where(
      and(
        eq(aanvraag.bronId, payload.bronId),
        eq(aanvraag.bronReferentie, payload.bronReferentie)
      )
    )
    .limit(1);
  return row
    ? {
        ...row,
        observedAt: row.observedAt.toISOString(),
        phase: "observation",
      }
    : null;
};

const classifyVersionPhase = async (
  database: RecoveryDatabase,
  aanvraagId: string,
  versie: number
): Promise<"ambiguous" | "lifecycle" | "observation"> => {
  if (versie === 1) {
    return "observation";
  }
  const [currentRow] = await database
    .select({
      contentHash: aanvraagVersie.contentHash,
      rawPayloadRef: aanvraagVersie.rawPayloadRef,
    })
    .from(aanvraagVersie)
    .where(
      and(
        eq(aanvraagVersie.aanvraagId, aanvraagId),
        eq(aanvraagVersie.versie, versie)
      )
    )
    .limit(1);
  const [previousRow] = await database
    .select({
      contentHash: aanvraagVersie.contentHash,
      rawPayloadRef: aanvraagVersie.rawPayloadRef,
    })
    .from(aanvraagVersie)
    .where(
      and(
        eq(aanvraagVersie.aanvraagId, aanvraagId),
        eq(aanvraagVersie.versie, versie - 1)
      )
    )
    .limit(1);
  if (!currentRow || !previousRow) {
    return "ambiguous";
  }
  return currentRow.contentHash !== previousRow.contentHash ||
    currentRow.rawPayloadRef !== previousRow.rawPayloadRef
    ? "observation"
    : "lifecycle";
};

const latestVersionPointer = async (
  database: RecoveryDatabase,
  payload: ConnectorObservation
): Promise<PersistedPointer | null> => {
  const [row] = await database
    .select({
      aanvraagId: aanvraagVersie.aanvraagId,
      contentHash: aanvraagVersie.contentHash,
      observedAt: aanvraagVersie.geldigVan,
      rawPayloadRef: aanvraagVersie.rawPayloadRef,
      scrapeRunId: aanvraagVersie.scrapeRunId,
      startedAt: scrapeRun.gestart,
      versie: aanvraagVersie.versie,
    })
    .from(aanvraagVersie)
    .innerJoin(aanvraag, eq(aanvraag.id, aanvraagVersie.aanvraagId))
    .innerJoin(scrapeRun, eq(scrapeRun.id, aanvraagVersie.scrapeRunId))
    .where(
      and(
        eq(aanvraag.bronId, payload.bronId),
        eq(aanvraag.bronReferentie, payload.bronReferentie)
      )
    )
    .orderBy(desc(aanvraagVersie.geldigVan), desc(aanvraagVersie.versie))
    .limit(1);
  if (!row) {
    return null;
  }
  const phase = await classifyVersionPhase(
    database,
    row.aanvraagId,
    row.versie
  );
  return {
    contentHash: row.contentHash,
    observedAt: row.observedAt.toISOString(),
    phase,
    rawPayloadRef: row.rawPayloadRef,
    scrapeRunId: row.scrapeRunId,
    startedAt: row.startedAt,
  };
};

const committedFallback = async (
  database: RecoveryDatabase,
  payload: ConnectorObservation
): Promise<PersistedPointer | null> => {
  const current = await currentPointer(database, payload);
  const version = await latestVersionPointer(database, payload);
  if (!current) {
    return version;
  }
  if (!version) {
    return current;
  }
  return compareSourcePointerOrder(version, current) > 0 ? version : current;
};

const effectiveObservedAt = async (
  database: RecoveryDatabase,
  payload: ConnectorObservation
): Promise<Date> => {
  const observedAt = new Date(payload.observedAt);
  const [latest] = await database
    .select({ geldigVan: aanvraagVersie.geldigVan })
    .from(aanvraagVersie)
    .innerJoin(aanvraag, eq(aanvraag.id, aanvraagVersie.aanvraagId))
    .where(
      and(
        eq(aanvraag.bronId, payload.bronId),
        eq(aanvraag.bronReferentie, payload.bronReferentie)
      )
    )
    .orderBy(desc(aanvraagVersie.geldigVan))
    .limit(1);
  return latest && latest.geldigVan > observedAt
    ? latest.geldigVan
    : observedAt;
};

const isObservationCommittedVersion = async (
  database: RecoveryDatabase,
  payload: ConnectorObservation
): Promise<boolean> => {
  const [row] = await database
    .select({
      aanvraagId: aanvraagVersie.aanvraagId,
      versie: aanvraagVersie.versie,
    })
    .from(aanvraagVersie)
    .innerJoin(aanvraag, eq(aanvraag.id, aanvraagVersie.aanvraagId))
    .where(
      and(
        eq(aanvraag.bronId, payload.bronId),
        eq(aanvraag.bronReferentie, payload.bronReferentie),
        eq(aanvraagVersie.scrapeRunId, payload.scrapeRunId),
        eq(aanvraagVersie.contentHash, payload.contentHash),
        eq(aanvraagVersie.rawPayloadRef, payload.rawPayloadRef)
      )
    )
    .limit(1);
  if (!row) {
    return false;
  }
  const phase = await classifyVersionPhase(
    database,
    row.aanvraagId,
    row.versie
  );
  return phase === "observation";
};

const toCandidatePointer = (
  candidate: RecoveryCandidate
): PersistedPointer => ({
  ...candidate.payload,
  phase: "observation",
  startedAt: candidate.runStartedAt,
});

const appliedHighWater = async (
  database: RecoveryDatabase,
  candidate: RecoveryCandidate,
  fallback: PersistedPointer | null
): Promise<PersistedPointer | null> => {
  const rows = await database
    .select({
      payload: aanvraagObservation.payload,
      startedAt: scrapeRun.gestart,
      status: aanvraagObservation.status,
    })
    .from(aanvraagObservation)
    .innerJoin(scrapeRun, eq(scrapeRun.id, aanvraagObservation.scrapeRunId))
    .where(eq(aanvraagObservation.sourceRecordId, candidate.sourceRecordId));
  let maximum = fallback;
  for (const row of rows) {
    const parsed = OBSERVATION_SCHEMA.safeParse(row.payload);
    if (!parsed.success) {
      continue;
    }
    const pointer: PersistedPointer = {
      contentHash: parsed.data.contentHash,
      observedAt: parsed.data.observedAt,
      phase: "observation",
      rawPayloadRef: parsed.data.rawPayloadRef,
      scrapeRunId: parsed.data.scrapeRunId,
      startedAt: row.startedAt,
    };
    if (APPLIED_STATUSES.has(row.status)) {
      if (
        maximum &&
        pointer.scrapeRunId === maximum.scrapeRunId &&
        pointer.contentHash === maximum.contentHash &&
        pointer.rawPayloadRef === maximum.rawPayloadRef
      ) {
        // Source ordering comes from the immutable observation timestamp. The
        // later SCD2 validity floor is applied only when committing below.
        maximum = pointer;
      } else if (!maximum || compareSourcePointerOrder(pointer, maximum) >= 0) {
        maximum = pointer;
      }
    }
  }
  return maximum;
};

const hasEarlierRecoverable = async (
  database: RecoveryDatabase,
  candidate: RecoveryCandidate,
  suppressed: ReadonlySet<string>,
  runStatuses: readonly string[]
): Promise<boolean> => {
  const rows = await database
    .select({
      id: aanvraagObservation.id,
      payload: aanvraagObservation.payload,
      startedAt: scrapeRun.gestart,
    })
    .from(aanvraagObservation)
    .innerJoin(scrapeRun, eq(scrapeRun.id, aanvraagObservation.scrapeRunId))
    .where(
      and(
        eq(aanvraagObservation.sourceRecordId, candidate.sourceRecordId),
        inArray(scrapeRun.status, [...runStatuses]),
        inArray(aanvraagObservation.status, [...RECOVERABLE_STATUSES])
      )
    );
  const candidatePointer = toCandidatePointer(candidate);
  return rows.some((row) => {
    if (row.id === candidate.id) {
      return false;
    }
    // A suppressed row must not block any candidate this pass, not only its
    // dominators. It is a provable no-op refresh: every candidate later in
    // pointer order performs the refresh it waits on, and yielding only to
    // the dominator would deadlock a chain like A(dup) -> B(change) ->
    // C(dominator), where B waits on A while C waits on B. If no dominator
    // applies, the row resumes as an ordinary candidate next pass.
    if (suppressed.has(row.id)) {
      return false;
    }
    const parsed = OBSERVATION_SCHEMA.safeParse(row.payload);
    if (!parsed.success) {
      return row.startedAt.getTime() <= candidate.runStartedAt.getTime();
    }
    return (
      compareSourcePointerOrder(
        {
          contentHash: parsed.data.contentHash,
          observedAt: parsed.data.observedAt,
          rawPayloadRef: parsed.data.rawPayloadRef,
          scrapeRunId: parsed.data.scrapeRunId,
          startedAt: row.startedAt,
        },
        candidatePointer
      ) < 0
    );
  });
};

const markObservation = async (
  database: RecoveryDatabase,
  id: string,
  status: string
): Promise<boolean> => {
  const rows = await database
    .update(aanvraagObservation)
    .set({ status })
    .where(
      and(
        eq(aanvraagObservation.id, id),
        inArray(aanvraagObservation.status, [...RECOVERABLE_STATUSES])
      )
    )
    .returning({ id: aanvraagObservation.id });
  return rows.length > 0;
};

const processCandidate = async (
  input: CurateScrapeRunInput,
  candidate: RecoveryCandidate,
  suppressed: ReadonlySet<string>
): Promise<{ disposition: CandidateDisposition; madeProgress: boolean }> => {
  throwIfAborted(input.signal);
  const preliminaryCommitted =
    isLegacyStatus(candidate.status) &&
    (await isObservationCommittedVersion(input.database, candidate.payload));
  throwIfAborted(input.signal);
  const preliminaryCurrent = await committedFallback(
    input.database,
    candidate.payload
  );
  throwIfAborted(input.signal);
  const preliminaryHighWater = await appliedHighWater(
    input.database,
    candidate,
    preliminaryCurrent
  );
  throwIfAborted(input.signal);
  const preliminaryDisposition = preliminaryCommitted
    ? "already_committed"
    : classifyRecoveryCandidate({
        candidate: toCandidatePointer(candidate),
        current: preliminaryHighWater,
        legacyPending: isLegacyStatus(candidate.status),
      });
  // An unreachable object store is a storage problem, never a property of this
  // row, so it must reach neither the terminal `curation_failed` path nor the
  // `deferred_missing_raw` one: the first needs an operator to fix a defect
  // that does not exist, and the second is equally manual to requeue, so an
  // outage would strand up to `attemptLimit` rows per source per cycle. It
  // aborts the pass instead. Only a genuinely absent object defers.
  const stored =
    preliminaryDisposition === "process"
      ? await readStoredRaw(input.objectStore, candidate.payload.rawPayloadRef)
      : null;
  throwIfAborted(input.signal);
  if (preliminaryDisposition === "process" && !stored) {
    await markObservation(
      input.database,
      candidate.id,
      missingRawStatus(candidate.status)
    );
    throwIfAborted(input.signal);
    return { disposition: "pending", madeProgress: false };
  }

  let madeProgress = false;
  const finalDisposition = await input.database.transaction(async (tx) => {
    throwIfAborted(input.signal);
    const [lockedRun] = await tx
      .select({
        bronId: scrapeRun.bronId,
        status: scrapeRun.status,
      })
      .from(scrapeRun)
      .where(eq(scrapeRun.id, candidate.scrapeRunId))
      .limit(1)
      .for("key share");
    throwIfAborted(input.signal);
    if (
      !lockedRun ||
      lockedRun.bronId !== input.bronId ||
      !eligibleRunStatuses(input).includes(lockedRun.status)
    ) {
      return "blocked_ordering" as const;
    }
    const [lockedIdentity] = await tx
      .select({
        bronId: sourceRecord.bronId,
        bronReferentie: sourceRecord.bronReferentie,
        id: sourceRecord.id,
      })
      .from(sourceRecord)
      .where(eq(sourceRecord.id, candidate.sourceRecordId))
      .limit(1)
      .for("update");
    throwIfAborted(input.signal);
    if (
      !lockedIdentity ||
      lockedIdentity.bronId !== candidate.payload.bronId ||
      lockedIdentity.bronReferentie !== candidate.payload.bronReferentie
    ) {
      return "blocked_ordering" as const;
    }
    const [locked] = await tx
      .select({
        bronId: aanvraagObservation.bronId,
        contentHash: aanvraagObservation.contentHash,
        payload: aanvraagObservation.payload,
        scrapeRunId: aanvraagObservation.scrapeRunId,
        sourceRecordId: aanvraagObservation.sourceRecordId,
        status: aanvraagObservation.status,
      })
      .from(aanvraagObservation)
      .where(eq(aanvraagObservation.id, candidate.id))
      .limit(1)
      .for("update");
    throwIfAborted(input.signal);
    if (!locked || !isRecoverableStatus(locked.status)) {
      return "already_committed" as const;
    }
    if (
      locked.bronId !== candidate.bronId ||
      locked.contentHash !== candidate.contentHash ||
      locked.scrapeRunId !== candidate.scrapeRunId ||
      locked.sourceRecordId !== candidate.sourceRecordId ||
      !OBSERVATION_SCHEMA.safeParse(locked.payload).success
    ) {
      await markObservation(tx, candidate.id, blockedStatus(locked.status));
      throwIfAborted(input.signal);
      return "blocked_ordering" as const;
    }
    const hasEarlier = await hasEarlierRecoverable(
      tx,
      candidate,
      suppressed,
      eligibleRunStatuses(input)
    );
    throwIfAborted(input.signal);
    if (hasEarlier) {
      await markObservation(tx, candidate.id, blockedStatus(locked.status));
      throwIfAborted(input.signal);
      return "blocked_ordering" as const;
    }

    const committed =
      isLegacyStatus(locked.status) &&
      (await isObservationCommittedVersion(tx, candidate.payload));
    throwIfAborted(input.signal);
    const current = await appliedHighWater(
      tx,
      candidate,
      await committedFallback(tx, candidate.payload)
    );
    throwIfAborted(input.signal);
    const disposition = committed
      ? "already_committed"
      : classifyRecoveryCandidate({
          candidate: toCandidatePointer(candidate),
          current,
          legacyPending: isLegacyStatus(locked.status),
        });
    if (disposition !== "process") {
      await markObservation(
        tx,
        candidate.id,
        disposition === "blocked_ordering"
          ? blockedStatus(locked.status)
          : disposition
      );
      throwIfAborted(input.signal);
      madeProgress = disposition !== "blocked_ordering";
      return disposition;
    }

    if (!stored) {
      await markObservation(tx, candidate.id, blockedStatus(locked.status));
      throwIfAborted(input.signal);
      return "blocked_ordering" as const;
    }
    throwIfAborted(input.signal);
    const processed = await processObservation(new PostgresCurateStore(tx), {
      body: stored.body,
      bronId: candidate.payload.bronId,
      bronSlug: input.bronSlug,
      contentHash: candidate.payload.contentHash,
      observedAt: await effectiveObservedAt(tx, candidate.payload),
      rawPayloadRef: candidate.payload.rawPayloadRef,
      scrapeRunId: candidate.payload.scrapeRunId,
    });
    throwIfAborted(input.signal);
    await tx
      .update(aanvraagObservation)
      .set({ status: processed.status })
      .where(eq(aanvraagObservation.id, candidate.id));
    throwIfAborted(input.signal);
    madeProgress = true;
    return processed.status;
  });
  return { disposition: finalDisposition, madeProgress };
};

const recordDisposition = (
  result: CurateScrapeRunResult,
  blockedIdentities: Set<string>,
  candidate: RecoveryCandidate,
  disposition: CandidateDisposition
): void => {
  switch (disposition) {
    case "pending": {
      blockedIdentities.add(candidate.sourceRecordId);
      break;
    }
    case "curated": {
      result.curated += 1;
      break;
    }
    case "quarantined": {
      result.quarantined += 1;
      blockedIdentities.add(candidate.sourceRecordId);
      break;
    }
    case "curation_failed": {
      result.failed += 1;
      // Block the identity for the rest of this pass, so a newer observation of
      // the same source record cannot be curated immediately behind the one that
      // just failed. This is a within-pass guard only: a later pass will curate
      // the newer observation, and a re-queued row then classifies as superseded
      // rather than rewinding the aanvraag.
      blockedIdentities.add(candidate.sourceRecordId);
      break;
    }
    case "already_committed": {
      result.alreadyCommitted += 1;
      break;
    }
    case "blocked_ordering": {
      result.blockedOrdering += 1;
      blockedIdentities.add(candidate.sourceRecordId);
      break;
    }
    case "superseded": {
      result.superseded += 1;
      break;
    }
    case "unchanged": {
      result.unchanged += 1;
      break;
    }
    default: {
      const _exhaustive: never = disposition;
      throw new Error(`Unknown disposition: ${String(_exhaustive)}`);
    }
  }
};

/**
 * Parks one candidate that threw and leaves a line on stderr naming it.
 *
 * `processCandidate` does all its writing inside a transaction, so an
 * unexpected throw has already rolled back: the row is still in a recoverable
 * status here, which is exactly what `markObservation` requires. When it is
 * not -- another writer moved it first -- the candidate still counts as failed
 * and its identity is still blocked, because this pass did not curate it.
 */
const parkFailedCandidate = async (input: {
  database: BronRuntimeDatabase;
  error: unknown;
  observationId: string;
}): Promise<void> => {
  const { database, error, observationId } = input;
  process.stderr.write(
    `${JSON.stringify({
      causeChain: loggableCauseChain({ error }),
      errorName: errorNameOf({ error }),
      event: "curation_candidate_failed",
      observationId,
      status: CURATION_FAILED_STATUS,
    })}\n`
  );
  await markObservation(database, observationId, CURATION_FAILED_STATUS);
};

// oxlint-disable-next-line complexity -- bounded cancellation checks preserve candidate ordering and rollback semantics
export const curateScrapeRun = async (
  input: CurateScrapeRunInput
): Promise<CurateScrapeRunResult> => {
  const source = SOURCES[input.bronSlug];
  if (!source || source.bronId !== input.bronId) {
    throw new Error("Curation source slug does not match bronId");
  }
  const attemptLimit = input.attemptLimit ?? DEFAULT_ATTEMPT_LIMIT;
  if (
    !Number.isSafeInteger(attemptLimit) ||
    attemptLimit < 1 ||
    attemptLimit > 500
  ) {
    throw new RangeError("attemptLimit must be an integer between 1 and 500");
  }
  if (input.eligibleRunStatuses && input.eligibleRunStatuses.length === 0) {
    throw new RangeError("eligibleRunStatuses must not be empty");
  }
  // Runs before candidate selection so dominated rows can neither rank their
  // identity nor consume an attempt slot this pass. Rows dominated only by a
  // will-apply sibling are suppressed, not marked: they resume as ordinary
  // candidates next pass if the dominator does not apply.
  const dominated = await markDominatedUnchangedObservations(input);
  const suppressedIds = new Set(dominated.suppressedBy.keys());
  const loaded = await loadCandidates(input, attemptLimit, suppressedIds);
  const candidates = fairOldestFirst(loaded.candidates, attemptLimit);
  // Malformed review rows use only capacity left after valid work, so a large
  // historical review queue cannot starve current curation.
  const invalidRows = loaded.invalidRows.slice(
    0,
    attemptLimit - candidates.length
  );
  const result: CurateScrapeRunResult = {
    alreadyCommitted: 0,
    attemptedObservationIds: [],
    blockedOrdering: 0,
    curated: 0,
    failed: 0,
    pending: 0,
    quarantined: 0,
    remaining: 0,
    superseded: dominated.marked,
    unchanged: 0,
  };
  for (const invalidRow of invalidRows) {
    throwIfAborted(input.signal);
    // oxlint-disable-next-line no-await-in-loop -- each invalid row receives a durable review marker
    const marked = await markObservation(
      input.database,
      invalidRow.id,
      blockedStatus(invalidRow.status)
    );
    if (marked) {
      result.attemptedObservationIds.push(invalidRow.id);
      result.blockedOrdering += 1;
    }
    throwIfAborted(input.signal);
  }
  const blockedIdentities = new Set<string>();
  for (const candidate of candidates) {
    throwIfAborted(input.signal);
    if (blockedIdentities.has(candidate.sourceRecordId)) {
      continue;
    }
    result.attemptedObservationIds.push(candidate.id);
    let madeProgress = false;
    try {
      // oxlint-disable-next-line no-await-in-loop -- recovery is ordered per identity
      const processed = await processCandidate(input, candidate, suppressedIds);
      recordDisposition(
        result,
        blockedIdentities,
        candidate,
        processed.disposition
      );
      ({ madeProgress } = processed);
    } catch (error) {
      // CTP-499: rethrowing every error here aborted the whole pass, so one
      // candidate that Postgres refused blocked every other identity of the
      // source indefinitely. Only errors that are genuinely about this row park
      // it and let the pass continue.
      //
      // An unreachable object store and a transient Postgres failure are about
      // the infrastructure, not the row. Parking either would burn a review
      // status that only an operator can clear, on a condition a retry would
      // have cleared by itself, so both abort the pass and leave every row in
      // an active status for the next poll.
      if (
        input.signal?.aborted ||
        isRawReadError({ error }) ||
        isTransientPostgresError({ error })
      ) {
        throw error;
      }
      // oxlint-disable-next-line no-await-in-loop -- the marker must land before the next candidate
      await parkFailedCandidate({
        database: input.database,
        error,
        observationId: candidate.id,
      });
      recordDisposition(
        result,
        blockedIdentities,
        candidate,
        "curation_failed"
      );
      madeProgress = true;
      if (result.failed >= MAX_PARKED_PER_PASS) {
        throw namedError(
          TOO_MANY_PARKED_ERROR_NAME,
          `Parked ${result.failed} observations in one pass; stopping in case the failure is systemic`
        );
      }
    }
    if (madeProgress) {
      // oxlint-disable-next-line no-await-in-loop -- observe committed progress before advancing to the next candidate
      await input.onProgress?.();
    }
  }
  // Dominators that applied during this pass now prove their suppressed
  // predecessors redundant; dominators that failed, deferred, or stayed
  // blocked mark nothing, so those rows resume next pass.
  result.superseded += await markSuppressedBehindApplied(
    input,
    dominated.suppressedBy
  );
  const [backlogRows, missingRawRows] = await Promise.all([
    input.database
      .select({ value: count() })
      .from(aanvraagObservation)
      .innerJoin(scrapeRun, eq(scrapeRun.id, aanvraagObservation.scrapeRunId))
      .where(
        and(
          eq(aanvraagObservation.bronId, input.bronId),
          inArray(scrapeRun.status, eligibleRunStatuses(input)),
          inArray(aanvraagObservation.status, [...RECOVERABLE_STATUSES]),
          input.scopeToRun
            ? eq(aanvraagObservation.scrapeRunId, input.scrapeRunId)
            : undefined
        )
      ),
    input.database
      .select({ value: count() })
      .from(aanvraagObservation)
      .innerJoin(scrapeRun, eq(scrapeRun.id, aanvraagObservation.scrapeRunId))
      .where(
        and(
          eq(aanvraagObservation.bronId, input.bronId),
          inArray(scrapeRun.status, eligibleRunStatuses(input)),
          inArray(aanvraagObservation.status, [...MISSING_RAW_STATUSES]),
          input.scopeToRun
            ? eq(aanvraagObservation.scrapeRunId, input.scrapeRunId)
            : undefined
        )
      ),
  ]);
  const [backlog] = backlogRows;
  const [missingRaw] = missingRawRows;
  result.pending = missingRaw?.value ?? 0;
  result.remaining = backlog?.value ?? 0;
  return result;
};
