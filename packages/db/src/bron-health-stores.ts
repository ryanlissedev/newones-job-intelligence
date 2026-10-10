/* oxlint-disable max-classes-per-file -- cohesive Postgres adapters share schema mapping */
import type { RunBaselineSample } from "@ji/application/observability";
import type {
  AlertEvidence,
  AlertRecord,
  AlertStore,
  BronHealthRecord,
  BronHealthStore,
} from "@ji/application/registry";
import { and, desc, eq, gte, isNull, lt, ne } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type {
  PostgresJsDatabase,
  PostgresJsTransaction,
} from "drizzle-orm/postgres-js";

import type * as schema from "./schema";
import { alert, bronHealth, scrapeRun } from "./schema";

export type BronHealthDatabase =
  | PostgresJsDatabase<typeof schema>
  | PostgresJsTransaction<
      typeof schema,
      ExtractTablesWithRelations<typeof schema>
    >;
export type AlertDatabase = BronHealthDatabase;

const toBronHealthRecord = (
  row: typeof bronHealth.$inferSelect
): BronHealthRecord => ({
  bronId: row.bronId,
  circuitStatus: row.circuitStatus,
  lastRunAt: row.lastRunAt,
  lastRunStatus: row.lastRunStatus,
  silenceAlertOpen: row.silenceAlertOpen,
});

export class PostgresBronHealthStore implements BronHealthStore {
  private readonly database: BronHealthDatabase;

  constructor(database: BronHealthDatabase) {
    this.database = database;
  }

  async getByBronId(bronId: string): Promise<BronHealthRecord | null> {
    const [row] = await this.database
      .select()
      .from(bronHealth)
      .where(eq(bronHealth.bronId, bronId))
      .limit(1);

    return row ? toBronHealthRecord(row) : null;
  }

  async list(): Promise<readonly BronHealthRecord[]> {
    const rows = await this.database
      .select()
      .from(bronHealth)
      .orderBy(bronHealth.bronId);

    return rows.map(toBronHealthRecord);
  }

  async upsert(record: BronHealthRecord): Promise<BronHealthRecord> {
    const [row] = await this.database
      .insert(bronHealth)
      .values({
        bronId: record.bronId,
        circuitStatus: record.circuitStatus,
        lastRunAt: record.lastRunAt,
        lastRunStatus: record.lastRunStatus,
        silenceAlertOpen: record.silenceAlertOpen,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        set: {
          circuitStatus: record.circuitStatus,
          lastRunAt: record.lastRunAt,
          lastRunStatus: record.lastRunStatus,
          silenceAlertOpen: record.silenceAlertOpen,
          updatedAt: new Date(),
        },
        target: bronHealth.bronId,
      })
      .returning();

    if (!row) {
      throw new Error("Unable to upsert bron health record");
    }

    return toBronHealthRecord(row);
  }

  upsertForRun({
    bronId,
    fenceToken,
    record,
    runId,
  }: Parameters<
    NonNullable<BronHealthStore["upsertForRun"]>
  >[0]): Promise<BronHealthRecord | null> {
    return this.database.transaction(async (transaction) => {
      // Match run-start lock order and retain this fence through the outer
      // health/alert transaction, including a takeover that resumes this run.
      const [ownedRun] = await transaction
        .select({ id: scrapeRun.id })
        .from(scrapeRun)
        .where(
          and(
            eq(scrapeRun.id, runId),
            eq(scrapeRun.bronId, bronId),
            eq(scrapeRun.fenceToken, fenceToken)
          )
        )
        .for("update");
      if (!ownedRun) {
        return null;
      }
      const [row] = await transaction
        .update(bronHealth)
        .set({
          circuitStatus: record.circuitStatus,
          lastRunAt: record.lastRunAt,
          lastRunStatus: record.lastRunStatus,
          silenceAlertOpen: record.silenceAlertOpen,
          updatedAt: new Date(),
        })
        .where(
          and(eq(bronHealth.bronId, bronId), eq(bronHealth.activeRunId, runId))
        )
        .returning();

      return row ? toBronHealthRecord(row) : null;
    });
  }
}

const toAlertRecord = (row: typeof alert.$inferSelect): AlertRecord => ({
  ackedAt: row.ackedAt,
  ackedBy: row.ackedBy,
  bronId: row.bronId,
  createdAt: row.createdAt,
  dedupeKey: row.dedupeKey,
  // SAFETY: Alert schema ensures persisted jsonb evidence conforms to AlertEvidence.
  evidence: (row.evidence ?? {}) as AlertEvidence,
  id: row.id,
  kind: row.kind,
  message: row.message,
});

export class PostgresAlertStore implements AlertStore {
  private readonly database: AlertDatabase;

  constructor(database: AlertDatabase) {
    this.database = database;
  }

  async create(
    record: Omit<AlertRecord, "ackedAt" | "ackedBy" | "createdAt" | "id"> & {
      readonly id?: string;
    }
  ): Promise<AlertRecord> {
    const [row] = await this.database
      .insert(alert)
      .values({
        bronId: record.bronId,
        dedupeKey: record.dedupeKey,
        evidence: record.evidence,
        id: record.id ?? crypto.randomUUID(),
        kind: record.kind,
        message: record.message,
      })
      .returning();

    if (!row) {
      throw new Error("Unable to create alert record");
    }

    return toAlertRecord(row);
  }

  async getById(alertId: string): Promise<AlertRecord | null> {
    const [row] = await this.database
      .select()
      .from(alert)
      .where(eq(alert.id, alertId))
      .limit(1);

    return row ? toAlertRecord(row) : null;
  }

  async findOpenByDedupeKey(dedupeKey: string): Promise<AlertRecord | null> {
    const [row] = await this.database
      .select()
      .from(alert)
      .where(and(eq(alert.dedupeKey, dedupeKey), isNull(alert.ackedAt)))
      .orderBy(desc(alert.createdAt))
      .limit(1);

    return row ? toAlertRecord(row) : null;
  }

  async listOpen(): Promise<readonly AlertRecord[]> {
    const rows = await this.database
      .select()
      .from(alert)
      .where(isNull(alert.ackedAt))
      .orderBy(desc(alert.createdAt));

    return rows.map(toAlertRecord);
  }

  async ack(alertId: string, actorId: string): Promise<AlertRecord | null> {
    const [row] = await this.database
      .update(alert)
      .set({
        ackedAt: new Date(),
        ackedBy: actorId,
      })
      .where(and(eq(alert.id, alertId), isNull(alert.ackedAt)))
      .returning();

    return row ? toAlertRecord(row) : null;
  }
}

export const querySilenceBaselineSamples = async (
  database: BronHealthDatabase,
  bronId: string,
  now: Date,
  currentScrapeRunId?: string,
  windowDays = 7
): Promise<RunBaselineSample[]> => {
  const windowMs = windowDays * 86_400_000;
  const windowStart = new Date(now.getTime() - windowMs);
  const rows = await database
    .select({
      at: scrapeRun.gestart,
      changed: scrapeRun.gewijzigd,
      found: scrapeRun.aantalGevonden,
      new: scrapeRun.nieuw,
    })
    .from(scrapeRun)
    .where(
      and(
        eq(scrapeRun.bronId, bronId),
        eq(scrapeRun.status, "succeeded"),
        eq(scrapeRun.runKind, "poll"),
        gte(scrapeRun.gestart, windowStart),
        currentScrapeRunId
          ? ne(scrapeRun.id, currentScrapeRunId)
          : lt(scrapeRun.gestart, now)
      )
    )
    .orderBy(desc(scrapeRun.gestart));

  return rows;
};

/**
 * Persists a bron's host-gate circuit (`closed` or `open`) on
 * `bron_health.circuit_status`, which `/bronnen` already renders. Every other
 * health write carries the stored value forward, so this is the only place it
 * changes. A no-op when the value is already stored.
 */
export const recordHostCircuitStatus = async (
  database: BronHealthDatabase,
  bronId: string,
  circuitStatus: "closed" | "open"
): Promise<void> => {
  await database
    .insert(bronHealth)
    .values({ bronId, circuitStatus })
    .onConflictDoUpdate({
      set: { circuitStatus },
      setWhere: ne(bronHealth.circuitStatus, circuitStatus),
      target: bronHealth.bronId,
    });
};
