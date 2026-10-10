/* oxlint-disable max-classes-per-file -- cohesive Postgres adapters share schema mapping */
import type {
  BackfillFailureEvidence,
  BackfillProvenanceRecord,
  BackfillProvenanceStore,
  BackfillRunEvidence,
  BackfillRunStore,
  BackfillSnapshotWindow,
  BackfillTargetProvenanceRecord,
} from "@ji/application/backfill";
import { backfillFailureEvidenceSchema } from "@ji/application/backfill";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type * as schema from "./schema";
import { aanvraag, bron, scrapeRun } from "./schema";

export type BackfillDatabase = PostgresJsDatabase<typeof schema>;

const requireRow = <Row>(rows: Row[], description: string): Row => {
  const [row] = rows;
  if (!row) {
    throw new Error(`Unable to ${description}`);
  }
  return row;
};

const backfillCheckpoint = (evidence: BackfillRunEvidence) => ({
  backfill: evidence,
});

export class PostgresBackfillProvenanceStore implements BackfillProvenanceStore {
  private readonly database: BackfillDatabase;

  constructor(database: BackfillDatabase) {
    this.database = database;
  }

  consumeReconciliationSnapshot(
    bronIds: readonly string[],
    batchSize: number,
    consume: (batch: readonly BackfillTargetProvenanceRecord[]) => Promise<void>
  ): Promise<BackfillSnapshotWindow> {
    const size = Math.max(1, batchSize);
    return this.database.transaction(
      async (transaction) => {
        const [startClock] = await transaction.execute<{
          snapshot_started_at: Date | string;
        }>(sql`SELECT transaction_timestamp() AS snapshot_started_at`);
        if (!startClock) {
          throw new Error("Unable to establish target reconciliation snapshot");
        }
        let cursor: { aanvraagId: string; v1Id: string } | null = null;
        for (;;) {
          /* oxlint-disable no-await-in-loop -- bounded keyset pages must share one target snapshot */
          const rows = await transaction
            .select({
              aanvraagId: aanvraag.id,
              bronId: aanvraag.bronId,
              bronReferentie: aanvraag.bronReferentie,
              contentHash: aanvraag.contentHash,
              rawPayloadRef: aanvraag.rawPayloadRef,
              v1Id: aanvraag.v1Id,
            })
            .from(aanvraag)
            .where(
              and(
                inArray(aanvraag.bronId, [...bronIds]),
                isNotNull(aanvraag.v1Id),
                cursor
                  ? or(
                      gt(aanvraag.v1Id, cursor.v1Id),
                      and(
                        eq(aanvraag.v1Id, cursor.v1Id),
                        gt(aanvraag.id, cursor.aanvraagId)
                      )
                    )
                  : undefined
              )
            )
            .orderBy(asc(aanvraag.v1Id), asc(aanvraag.id))
            .limit(size);
          const batch = rows.map((row) => {
            if (!row.v1Id) {
              throw new Error("Target reconciliation returned null v1_id");
            }
            return {
              bronId: row.bronId,
              bronReferentie: row.bronReferentie,
              contentHash: row.contentHash,
              rawPayloadRef: row.rawPayloadRef,
              v1Id: row.v1Id,
            };
          });
          if (batch.length === 0) {
            break;
          }
          await consume(batch);
          const last = rows.at(-1);
          if (!last?.v1Id) {
            throw new Error("Target reconciliation cursor is incomplete");
          }
          cursor = { aanvraagId: last.aanvraagId, v1Id: last.v1Id };
          if (batch.length < size) {
            break;
          }
          /* oxlint-enable no-await-in-loop */
        }
        const [endClock] = await transaction.execute<{
          snapshot_completed_at: Date | string;
        }>(sql`SELECT clock_timestamp() AS snapshot_completed_at`);
        if (!endClock) {
          throw new Error("Target reconciliation snapshot heartbeat failed");
        }
        const startedAt = new Date(
          startClock.snapshot_started_at
        ).toISOString();
        const completedAt = new Date(
          endClock.snapshot_completed_at
        ).toISOString();
        return { completedAt, startedAt };
      },
      { accessMode: "read only", isolationLevel: "repeatable read" }
    );
  }

  async findByAanvraagId(
    aanvraagId: string
  ): Promise<BackfillProvenanceRecord | null> {
    const [row] = await this.database
      .select({
        aanvraagId: aanvraag.id,
        bronId: aanvraag.bronId,
        bronReferentie: aanvraag.bronReferentie,
        contentHash: aanvraag.contentHash,
        rawPayloadRef: aanvraag.rawPayloadRef,
        v1Id: aanvraag.v1Id,
      })
      .from(aanvraag)
      .where(and(eq(aanvraag.id, aanvraagId), isNotNull(aanvraag.v1Id)))
      .limit(1);
    return row?.v1Id ? { ...row, v1Id: row.v1Id } : null;
  }

  async findByV1Id(v1Id: string): Promise<BackfillProvenanceRecord | null> {
    const [row] = await this.database
      .select({
        aanvraagId: aanvraag.id,
        bronId: aanvraag.bronId,
        bronReferentie: aanvraag.bronReferentie,
        contentHash: aanvraag.contentHash,
        rawPayloadRef: aanvraag.rawPayloadRef,
        v1Id: aanvraag.v1Id,
      })
      .from(aanvraag)
      .where(eq(aanvraag.v1Id, v1Id))
      .limit(1);
    return row?.v1Id ? { ...row, v1Id: row.v1Id } : null;
  }

  /**
   * Binds a Motian v1 job id to an aanvraag. The write only lands on a row
   * whose `v1_id` is still NULL or already equals the incoming id. If two v1
   * rows ever collapse onto one aanvraag via curateObservation, the second
   * call fails here, at the write, instead of silently re-pointing the
   * provenance and surfacing later as an unexplained reconciliation mismatch.
   */
  async registerV1Id(
    record: BackfillProvenanceRecord
  ): Promise<BackfillProvenanceRecord> {
    const { aanvraagId, v1Id } = record;
    const updated = await this.database
      .update(aanvraag)
      .set({ v1Id })
      .where(
        and(
          eq(aanvraag.id, aanvraagId),
          or(isNull(aanvraag.v1Id), eq(aanvraag.v1Id, v1Id))
        )
      )
      .returning({
        aanvraagId: aanvraag.id,
        bronId: aanvraag.bronId,
        bronReferentie: aanvraag.bronReferentie,
        contentHash: aanvraag.contentHash,
        rawPayloadRef: aanvraag.rawPayloadRef,
        v1Id: aanvraag.v1Id,
      });
    if (updated.length !== 1) {
      const cause = await this.describeRegisterV1IdFailure(v1Id, aanvraagId);
      throw new Error(
        `Refusing to register v1_id ${v1Id} on aanvraag ${aanvraagId}: expected exactly 1 row updated, got ${updated.length} (${cause})`
      );
    }
    const [registered] = updated;
    if (!registered?.v1Id) {
      throw new Error(
        `Refusing to register v1_id ${v1Id} on aanvraag ${aanvraagId}: guarded update returned null v1_id`
      );
    }
    return { ...registered, v1Id: registered.v1Id };
  }

  private async describeRegisterV1IdFailure(
    v1Id: string,
    aanvraagId: string
  ): Promise<string> {
    const [current] = await this.database
      .select({ v1Id: aanvraag.v1Id })
      .from(aanvraag)
      .where(eq(aanvraag.id, aanvraagId))
      .limit(1);
    if (!current) {
      return "aanvraag row does not exist";
    }
    if (current.v1Id !== null && current.v1Id !== v1Id) {
      return `aanvraag is already bound to v1_id ${current.v1Id}; overwriting would break provenance`;
    }
    return "row matched but the guarded update did not apply";
  }
}

export class PostgresBackfillRunStore implements BackfillRunStore {
  private readonly database: BackfillDatabase;

  constructor(database: BackfillDatabase) {
    this.database = database;
  }

  startRun(bronId: string): Promise<{ scrapeRunId: string }> {
    const scrapeRunId = crypto.randomUUID();
    return this.database.transaction(async (transaction) => {
      // Serializes every launch path (Trigger.dev, Coolify shell and manual
      // runner) around the running-row check. The lock is only needed during
      // start; the durable `running` row fences later launch attempts.
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('motian_v1_backfill_start'))`
      );
      const [running] = await transaction
        .select({ id: scrapeRun.id })
        .from(scrapeRun)
        .where(
          and(
            eq(scrapeRun.runKind, "backfill"),
            eq(scrapeRun.status, "running")
          )
        )
        .limit(1);
      if (running) {
        throw new Error("A Motian v1 backfill is already running");
      }
      const rows = await transaction
        .insert(scrapeRun)
        .values({
          bronId,
          id: scrapeRunId,
          runKind: "backfill",
          status: "running",
        })
        .returning({ id: scrapeRun.id });
      requireRow(rows, "start backfill scrape_run");
      return { scrapeRunId };
    });
  }

  async completeRun(
    scrapeRunId: string,
    evidence: BackfillRunEvidence
  ): Promise<void> {
    const { metrics } = evidence;
    const rows = await this.database
      .update(scrapeRun)
      .set({
        aantalGevonden: metrics.found,
        checkpoint: backfillCheckpoint(evidence),
        fouten: metrics.errors,
        geindigd: new Date(),
        nieuw: metrics.imported,
        rejected: metrics.rejected,
        status: "succeeded",
      })
      .where(eq(scrapeRun.id, scrapeRunId))
      .returning({ id: scrapeRun.id });
    requireRow(rows, "complete backfill scrape_run");
  }

  async failRun(
    scrapeRunId: string,
    failure: BackfillFailureEvidence,
    evidence: BackfillRunEvidence
  ): Promise<void> {
    const validatedFailure = backfillFailureEvidenceSchema.parse(failure);
    const persistedFailure = backfillFailureEvidenceSchema.parse(
      evidence.failure
    );
    if (
      persistedFailure.phase !== validatedFailure.phase ||
      persistedFailure.code !== validatedFailure.code
    ) {
      throw new Error(
        "Backfill failure evidence does not match terminal state"
      );
    }
    const { metrics } = evidence;
    const rows = await this.database
      .update(scrapeRun)
      .set({
        aantalGevonden: metrics.found,
        checkpoint: backfillCheckpoint(evidence),
        failureClass: "internal",
        failureCode: "UNEXPECTED_FAILURE",
        // The schema accepts a fixed failure envelope. Per-platform evidence
        // stays in `checkpoint`; source exceptions are never persisted because
        // they could contain raw data or connection details.
        failureMessage: "Connector run failed",
        failurePhase: "unknown",
        fouten: metrics.errors,
        geindigd: new Date(),
        nieuw: metrics.imported,
        rejected: metrics.rejected,
        status: "failed",
      })
      .where(eq(scrapeRun.id, scrapeRunId))
      .returning({ id: scrapeRun.id });
    requireRow(rows, "fail backfill scrape_run");
  }
}

export interface MotianV1BronSeed {
  readonly bronId: string;
  readonly categorie: string;
  readonly ingestieType: string;
  readonly mappingRef: string | null;
  readonly naam: string;
  readonly website: string;
}

export const seedMotianV1Bronnen = async (
  database: BackfillDatabase,
  seeds: readonly MotianV1BronSeed[]
): Promise<void> => {
  await Promise.all(
    seeds.map((seed) =>
      database
        .insert(bron)
        .values({
          actief: false,
          categorie: seed.categorie,
          id: seed.bronId,
          ingestieType: seed.ingestieType,
          interval: "manual",
          loginVereist: false,
          mappingRef: seed.mappingRef,
          naam: seed.naam,
          rateLimitPerMinute: 1,
          retentionDays: 90,
          status: "deferred",
          voorwaardenStatus: "toegestaan",
          website: seed.website,
        })
        .onConflictDoNothing({ target: bron.id })
    )
  );
};
