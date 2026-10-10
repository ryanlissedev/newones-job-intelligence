import type {
  ApprovalStore,
  ExportAttemptStore,
  ListedSnapshotRecord,
  QuerySnapshotRecord,
  QuerySnapshotStore,
  SnapshotListCursor,
} from "../types";
import { randomId } from "./random-id";

export class MemoryQuerySnapshotStore implements QuerySnapshotStore {
  private readonly approvals: ApprovalStore | undefined;
  private readonly exportAttempts: ExportAttemptStore | undefined;
  private readonly records = new Map<string, QuerySnapshotRecord>();

  constructor(approvals?: ApprovalStore, exportAttempts?: ExportAttemptStore) {
    this.approvals = approvals;
    this.exportAttempts = exportAttempts;
  }

  create(
    record: Omit<QuerySnapshotRecord, "createdAt" | "id">
  ): Promise<QuerySnapshotRecord> {
    const snapshot: QuerySnapshotRecord = {
      ...record,
      createdAt: new Date(),
      id: randomId(),
      resultIds: Object.freeze([...record.resultIds]),
    };
    this.records.set(snapshot.id, snapshot);
    return Promise.resolve(snapshot);
  }

  getById(id: string, scopeId: string): Promise<QuerySnapshotRecord | null> {
    const record = this.records.get(id);
    if (!record || record.scopeId !== scopeId) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      ...record,
      resultIds: Object.freeze([...record.resultIds]),
    });
  }

  list(input: {
    readonly cursor?: SnapshotListCursor;
    readonly limit: number;
    readonly scopeId: string;
    readonly userId: string;
  }): Promise<readonly ListedSnapshotRecord[]> {
    const ordered = [...this.records.values()]
      .filter(
        (record) =>
          record.scopeId === input.scopeId && record.userId === input.userId
      )
      .toSorted((left, right) => {
        const byTime = right.createdAt.getTime() - left.createdAt.getTime();
        return byTime === 0 ? right.id.localeCompare(left.id) : byTime;
      })
      .filter((record) =>
        input.cursor
          ? record.createdAt.getTime() < input.cursor.createdAt.getTime() ||
            (record.createdAt.getTime() === input.cursor.createdAt.getTime() &&
              record.id < input.cursor.id)
          : true
      );

    const page = ordered.slice(0, input.limit);
    return Promise.all(
      page.map(async (record): Promise<ListedSnapshotRecord> => {
        const approval = this.approvals
          ? await this.approvals.getBySnapshotId(record.id, input.scopeId)
          : null;
        const attempts = this.exportAttempts
          ? await this.exportAttempts.listBySnapshotId(record.id, input.scopeId)
          : [];
        const latestAttempt = attempts
          .toSorted((left, right) => {
            const byTime = right.createdAt.getTime() - left.createdAt.getTime();
            return byTime === 0 ? right.id.localeCompare(left.id) : byTime;
          })
          .at(0);
        return {
          actorId: record.userId,
          approval: approval
            ? { actorId: approval.actorId, expiresAt: approval.expiresAt }
            : null,
          createdAt: record.createdAt,
          export: latestAttempt
            ? {
                externalIdCount: attempts.filter(
                  (attempt) => attempt.externalId !== null
                ).length,
                hasSuccess: attempts.some(
                  (attempt) =>
                    attempt.status === "created" || attempt.status === "skipped"
                ),
                lastAttemptAt: latestAttempt.createdAt,
                status: latestAttempt.status,
              }
            : null,
          id: record.id,
          query: record.queryText,
          resultCount: record.resultIds.length,
        };
      })
    );
  }
}
