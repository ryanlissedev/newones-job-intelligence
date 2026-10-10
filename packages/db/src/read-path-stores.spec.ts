import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { PostgresExportAttemptStore } from "./export-stores";
import { PostgresQuerySnapshotStore } from "./read-path-stores";
import * as schema from "./schema";
import { PostgresApprovalStore } from "./user-write-stores";

const scopeId = "catapulze-test";

const testDatabaseUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
const testDatabaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;
const migrationsFolder = path.join(import.meta.dir, "migrations");

const isPostgresAvailable = async (): Promise<boolean> => {
  const probe = postgres(testDatabaseUrl, { connect_timeout: 2, max: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
    return true;
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return false;
  }
};

describe("read-path Postgres stores", () => {
  let postgresAvailable = false;
  let sqlClient: ReturnType<typeof postgres> | undefined;

  beforeAll(async () => {
    postgresAvailable = await isPostgresAvailable();
    if (!postgresAvailable) {
      if (testDatabaseRequired) {
        throw new Error("Required test database is unavailable");
      }
      return;
    }

    sqlClient = postgres(testDatabaseUrl, { max: 1 });
    const db = drizzle(sqlClient, { schema });
    await migrate(db, { migrationsFolder });
  });

  afterAll(async () => {
    await sqlClient?.end({ timeout: 5 });
  });

  it("persists query snapshots and snapshot-bound approvals", async () => {
    if (!postgresAvailable || !sqlClient) {
      expect(postgresAvailable).toBe(false);
      return;
    }

    const db = drizzle(sqlClient, { schema });
    const snapshots = new PostgresQuerySnapshotStore(db);
    const approvals = new PostgresApprovalStore(db);

    const snapshot = await snapshots.create({
      filters: {},
      indexVersion: 3,
      parserVersion: "1",
      queryText: "Azure",
      resultIds: ["00000000-0000-4000-8000-000000000001"],
      savedSearchId: null,
      schemaVersion: "slice-a-v1",
      scope: "active",
      scopeId,
      searchVersion: { appliedSequence: 42n, generation: 2 },
      userId: "recruiter-1",
    });

    const loaded = await snapshots.getById(snapshot.id, scopeId);
    expect(loaded?.resultIds).toEqual(snapshot.resultIds);
    expect(loaded?.searchVersion).toEqual({
      appliedSequence: 42n,
      generation: 2,
    });

    const written = await approvals.createWithAudit(
      {
        actorId: "approver-1",
        expiresAt: new Date("2026-12-31T00:00:00.000Z"),
        motivatie: "Durable approval",
        resultIds: [...snapshot.resultIds],
        scopeId,
        snapshotId: snapshot.id,
      },
      "user"
    );
    expect(written.ok).toBe(true);
    if (!written.ok) {
      return;
    }

    const loadedApproval = await approvals.getBySnapshotId(
      snapshot.id,
      scopeId
    );
    expect(loadedApproval?.id).toBe(written.approval.id);
    expect(loadedApproval?.resultIds).toEqual(snapshot.resultIds);
  });

  const seedListFixtures = async (
    db: ReturnType<typeof drizzle<typeof schema>>
  ) => {
    const snapshots = new PostgresQuerySnapshotStore(db);
    const approvals = new PostgresApprovalStore(db);
    const attempts = new PostgresExportAttemptStore(db);

    const makeSnapshot = (queryText: string, userId = "recruiter-1") =>
      snapshots.create({
        filters: {},
        indexVersion: 1,
        parserVersion: "1",
        queryText,
        resultIds: ["00000000-0000-4000-8000-000000000001"],
        savedSearchId: null,
        schemaVersion: "slice-a-v1",
        scope: "active",
        scopeId,
        searchVersion: { appliedSequence: 1n, generation: 1 },
        userId,
      });

    const pending = await makeSnapshot("q-pending");
    const approved = await makeSnapshot("q-approved");
    const committed = await makeSnapshot("q-committed");
    const otherUser = await makeSnapshot("q-other", "recruiter-2");

    const approval = await approvals.createWithAudit(
      {
        actorId: "approver-1",
        expiresAt: new Date("2099-12-31T00:00:00.000Z"),
        motivatie: "ok",
        resultIds: [...approved.resultIds],
        scopeId,
        snapshotId: approved.id,
      },
      "user"
    );
    const committedApproval = await approvals.createWithAudit(
      {
        actorId: "approver-1",
        expiresAt: new Date("2099-12-31T00:00:00.000Z"),
        motivatie: "ok",
        resultIds: [...committed.resultIds],
        scopeId,
        snapshotId: committed.id,
      },
      "user"
    );
    if (!approval.ok || !committedApproval.ok) {
      throw new Error("Expected approvals to persist");
    }

    await Promise.all(
      (
        [
          ["failed", "failed", "spott-7"],
          ["ok", "created", "spott-8"],
        ] as const
      ).map(([suffix, status, externalId]) =>
        attempts.create({
          actionType: "create",
          approvalId: committedApproval.approval.id,
          canonicalVacancyId: "00000000-0000-4000-8000-000000000901",
          errorMessage: null,
          externalId,
          idempotencyKey: `idem-${committed.id}-${suffix}`,
          scopeId,
          snapshotId: committed.id,
          status,
          target: "spott",
        })
      )
    );

    return { approved, committed, otherUser, pending, snapshots };
  };

  it("lists own snapshots joined with latest approval and attempt (CTP-652)", async () => {
    if (!postgresAvailable || !sqlClient) {
      expect(postgresAvailable).toBe(false);
      return;
    }

    const { approved, committed, otherUser, pending, snapshots } =
      await seedListFixtures(drizzle(sqlClient, { schema }));

    const page = await snapshots.list({
      limit: 10,
      scopeId,
      userId: "recruiter-1",
    });
    const ids = page.map((item) => item.id);
    expect(ids).toEqual(
      expect.arrayContaining([pending.id, approved.id, committed.id])
    );
    // Owner-scoped: the other user's snapshot is not listed.
    expect(ids).not.toContain(otherUser.id);

    const committedRow = page.find((item) => item.id === committed.id);
    expect(committedRow?.export?.hasSuccess).toBe(true);
    expect(committedRow?.export?.externalIdCount).toBe(2);
    expect(committedRow?.export?.status).toBe("created");
    expect(committedRow?.approval?.actorId).toBe("approver-1");

    const pendingRow = page.find((item) => item.id === pending.id);
    expect(pendingRow?.approval).toBeNull();
    expect(pendingRow?.export).toBeNull();
    expect(pendingRow?.resultCount).toBe(1);
    expect(pendingRow?.query).toBe("q-pending");

    const last = page.at(-1);
    if (!last) {
      throw new Error("Expected a non-empty page");
    }
    const paged = await snapshots.list({
      cursor: { createdAt: last.createdAt, id: last.id },
      limit: 1,
      scopeId,
      userId: "recruiter-1",
    });
    expect(paged.every((item) => !ids.includes(item.id))).toBe(true);
  });
});
