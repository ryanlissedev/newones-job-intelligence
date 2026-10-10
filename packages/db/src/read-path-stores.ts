/* oxlint-disable max-classes-per-file -- cohesive Postgres adapters share schema mapping */
import type {
  ExportAttemptStatus,
  ListedSnapshotRecord,
  QuerySnapshotRecord,
  QuerySnapshotStore,
  SnapshotListCursor,
} from "@ji/application/registry";
import { searchFiltersSchema } from "@ji/application/registry";
import { SEARCH_SCOPES } from "@ji/search";
import { and, desc, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

import type * as schema from "./schema";
import { approvalRecord, exportAttempt, querySnapshot } from "./schema";

export type ReadPathDatabase = PostgresJsDatabase<typeof schema>;

const resultIdsSchema = z.array(z.string());
const searchScopeSchema = z.enum(SEARCH_SCOPES);

interface SnapshotSchema<Output> {
  safeParse: (
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- query snapshot JSONB columns are untyped until this helper validates them against the supplied schema
    value: unknown
  ) =>
    | { success: true; data: Output }
    | { success: false; error: { issues: readonly unknown[] } };
}

const parseSnapshotColumn = <Output>(
  schema: SnapshotSchema<Output>,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- query snapshot JSONB columns are untyped until this helper validates them against the supplied schema
  value: unknown,
  fallback: Output,
  context: {
    column: "filters" | "resultIds" | "searchScope";
    snapshotId: string;
  }
): Output => {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  // oxlint-disable-next-line no-console -- degradation must leave a trace; @ji/db has no logger dependency
  console.warn(
    JSON.stringify({
      column: context.column,
      event: "query_snapshot.column_parse_failed",
      issues: parsed.error.issues,
      snapshotId: context.snapshotId,
    })
  );
  return fallback;
};

export const toQuerySnapshotRecord = (
  row: typeof querySnapshot.$inferSelect
): QuerySnapshotRecord => ({
  createdAt: row.createdAt,
  filters: parseSnapshotColumn(
    searchFiltersSchema,
    row.filters,
    {},
    {
      column: "filters",
      snapshotId: row.id,
    }
  ),
  id: row.id,
  indexVersion: row.indexVersion ?? 0,
  parserVersion: row.parserVersion,
  queryText: row.queryText,
  resultIds: Object.freeze(
    parseSnapshotColumn(resultIdsSchema, row.resultIds, [], {
      column: "resultIds",
      snapshotId: row.id,
    })
  ),
  savedSearchId: row.savedSearchId,
  schemaVersion: row.schemaVersion,
  scope: parseSnapshotColumn(searchScopeSchema, row.searchScope, "active", {
    column: "searchScope",
    snapshotId: row.id,
  }),
  scopeId: row.scopeId,
  searchVersion: {
    appliedSequence: row.searchAppliedSequence,
    generation: row.searchGeneration,
  },
  userId: row.userId,
});

export class PostgresQuerySnapshotStore implements QuerySnapshotStore {
  private readonly database: ReadPathDatabase;

  constructor(database: ReadPathDatabase) {
    this.database = database;
  }

  async create(
    record: Omit<QuerySnapshotRecord, "createdAt" | "id">
  ): Promise<QuerySnapshotRecord> {
    const rows = await this.database
      .insert(querySnapshot)
      .values({
        filters: record.filters,
        indexVersion: record.indexVersion,
        parserVersion: record.parserVersion,
        queryText: record.queryText,
        resultIds: [...record.resultIds],
        savedSearchId: record.savedSearchId,
        schemaVersion: record.schemaVersion,
        scopeId: record.scopeId,
        searchAppliedSequence: record.searchVersion.appliedSequence,
        searchGeneration: record.searchVersion.generation,
        searchScope: record.scope,
        userId: record.userId,
      })
      .returning();

    const [row] = rows;
    if (!row) {
      throw new Error("Unable to create query snapshot");
    }

    return toQuerySnapshotRecord(row);
  }

  async getById(
    id: string,
    scopeId: string
  ): Promise<QuerySnapshotRecord | null> {
    const row = await this.database.query.querySnapshot.findFirst({
      where: and(eq(querySnapshot.id, id), eq(querySnapshot.scopeId, scopeId)),
    });
    return row ? toQuerySnapshotRecord(row) : null;
  }

  async list(input: {
    readonly cursor?: SnapshotListCursor;
    readonly limit: number;
    readonly scopeId: string;
    readonly userId: string;
  }): Promise<readonly ListedSnapshotRecord[]> {
    const latestAttempt = this.database
      .selectDistinctOn([exportAttempt.snapshotId], {
        createdAt: exportAttempt.createdAt,
        snapshotId: exportAttempt.snapshotId,
        status: exportAttempt.status,
      })
      .from(exportAttempt)
      .where(eq(exportAttempt.scopeId, input.scopeId))
      .orderBy(
        exportAttempt.snapshotId,
        desc(exportAttempt.createdAt),
        desc(exportAttempt.id)
      )
      .as("latest_attempt");

    const attemptExternalIds = this.database
      .select({
        externalIdCount:
          sql<number>`count(${exportAttempt.externalId})::int`.as(
            "external_id_count"
          ),
        hasSuccess:
          sql<boolean>`count(*) filter (where ${exportAttempt.status} in ('created', 'skipped')) > 0`.as(
            "has_success"
          ),
        snapshotId: exportAttempt.snapshotId,
      })
      .from(exportAttempt)
      .where(eq(exportAttempt.scopeId, input.scopeId))
      .groupBy(exportAttempt.snapshotId)
      .as("attempt_external_ids");

    const conditions = [
      eq(querySnapshot.scopeId, input.scopeId),
      eq(querySnapshot.userId, input.userId),
    ];
    if (input.cursor) {
      const { cursor } = input;
      conditions.push(
        sql`(${querySnapshot.createdAt}, ${querySnapshot.id}) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`
      );
    }

    const rows = await this.database
      .select({
        approvalActorId: approvalRecord.actorId,
        approvalExpiresAt: approvalRecord.expiresAt,
        createdAt: querySnapshot.createdAt,
        exportExternalIdCount: attemptExternalIds.externalIdCount,
        exportHasSuccess: attemptExternalIds.hasSuccess,
        exportLastAttemptAt: latestAttempt.createdAt,
        exportStatus: latestAttempt.status,
        id: querySnapshot.id,
        queryText: querySnapshot.queryText,
        resultIds: querySnapshot.resultIds,
      })
      .from(querySnapshot)
      .leftJoin(
        approvalRecord,
        and(
          eq(approvalRecord.snapshotId, querySnapshot.id),
          eq(approvalRecord.scopeId, input.scopeId)
        )
      )
      .leftJoin(latestAttempt, eq(latestAttempt.snapshotId, querySnapshot.id))
      .leftJoin(
        attemptExternalIds,
        eq(attemptExternalIds.snapshotId, querySnapshot.id)
      )
      .where(and(...conditions))
      .orderBy(desc(querySnapshot.createdAt), desc(querySnapshot.id))
      .limit(input.limit);

    return rows.map((row) => ({
      actorId: input.userId,
      approval:
        row.approvalExpiresAt === null || row.approvalActorId === null
          ? null
          : {
              actorId: row.approvalActorId,
              expiresAt: row.approvalExpiresAt,
            },
      createdAt: row.createdAt,
      export:
        row.exportLastAttemptAt === null || row.exportStatus === null
          ? null
          : {
              externalIdCount: row.exportExternalIdCount ?? 0,
              hasSuccess: row.exportHasSuccess ?? false,
              lastAttemptAt: row.exportLastAttemptAt,
              // SAFETY: the export_attempt_status_check constraint keeps the
              // column inside ExportAttemptStatus; parseExportAttemptStatus in
              // export-stores.ts documents the same closed vocabulary.
              status: row.exportStatus as ExportAttemptStatus,
            },
      id: row.id,
      query: row.queryText,
      resultCount: parseSnapshotColumn(resultIdsSchema, row.resultIds, [], {
        column: "resultIds",
        snapshotId: row.id,
      }).length,
    }));
  }
}
