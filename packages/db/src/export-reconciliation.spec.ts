import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";

import {
  hashExportApprovalMotivation,
  hashOrderedExportResultIds,
  SpottExportReconciliationError,
} from "@ji/application/export/reconciliation";
import type {
  ReconcileSpottExportInput,
  SpottExportReconciliationPrincipal,
} from "@ji/application/export/reconciliation";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { reconcileSpottExportId } from "./export-reconciliation";
import type {
  ReconcileSpottExportAuthorize,
  ExportReconciliationDatabase,
} from "./export-reconciliation";
import {
  PostgresExportEffectStore,
  PostgresExternalIdCrosswalkStore,
} from "./export-stores";
import * as schema from "./schema";
import {
  approvalRecord,
  auditEvent,
  exportAttempt,
  exportEffect,
  externalIdCrosswalk,
  externalReceipt,
  querySnapshot,
} from "./schema";

const testDatabaseUrl = process.env.DATABASE_TEST_URL;
const applicationTestDatabaseUrl =
  process.env.DATABASE_APP_TEST_URL ?? testDatabaseUrl;
const testDatabaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" || testDatabaseUrl !== undefined;
const migrationsFolder = path.join(import.meta.dir, "migrations");
const reconciliationNow = new Date("2026-09-05T12:00:00.000Z");

const findPostgresErrorCode = (error: Error): string | undefined => {
  if (error instanceof postgres.PostgresError) {
    return error.code;
  }
  return error.cause instanceof Error
    ? findPostgresErrorCode(error.cause)
    : undefined;
};

type TestDatabase = ReturnType<typeof drizzle<typeof schema>>;

interface ReconciliationFixture {
  readonly approvalActorId: string;
  readonly approvalMotivation: string;
  readonly canonicalVacancyId: string;
  readonly effectId: string;
  readonly input: ReconcileSpottExportInput;
  readonly resultIds: readonly string[];
  readonly scopeId: string;
}

interface FixtureOptions {
  readonly additionalResultIds?: readonly string[];
  readonly approvalActorId?: string;
  readonly approvalCreatedAt?: Date;
  readonly approvalExpiresAt?: Date;
  readonly approvalMotivation?: string;
  readonly resultIds?: readonly string[];
  readonly scopeId?: string;
}

const requireDisposableTestDatabaseUrl = (
  candidate: string | undefined
): string | null => {
  if (!candidate) {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(candidate);
  } catch {
    throw new Error("DATABASE_TEST_URL must be a valid Postgres URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsedUrl.protocol) ||
    parsedUrl.searchParams.has("database") ||
    parsedUrl.searchParams.has("db")
  ) {
    throw new Error("DATABASE_TEST_URL must be a direct Postgres database URL");
  }
  if (!/^\/ji_test_iso_[a-z0-9_]+$/u.test(parsedUrl.pathname)) {
    throw new Error(
      "DATABASE_TEST_URL must name a disposable ji_test_iso_<pid>_<random> database"
    );
  }
  return candidate;
};

const disposableTestDatabaseUrl =
  requireDisposableTestDatabaseUrl(testDatabaseUrl);
const disposableApplicationTestDatabaseUrl = requireDisposableTestDatabaseUrl(
  applicationTestDatabaseUrl
);

if (
  disposableTestDatabaseUrl &&
  disposableApplicationTestDatabaseUrl &&
  new URL(disposableTestDatabaseUrl).pathname !==
    new URL(disposableApplicationTestDatabaseUrl).pathname
) {
  throw new Error(
    "DATABASE_TEST_URL and DATABASE_APP_TEST_URL must name the same disposable database"
  );
}

const isPostgresAvailable = async (): Promise<boolean> => {
  if (!disposableTestDatabaseUrl) {
    return false;
  }
  const probe = postgres(disposableTestDatabaseUrl, {
    connect_timeout: 2,
    max: 1,
  });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
    return true;
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return false;
  }
};

const postgresAvailable = await isPostgresAvailable();
if (!postgresAvailable && testDatabaseRequired) {
  throw new Error("Required disposable test database is unavailable");
}

const authorizedPrincipal = (
  actorId = `reconciliation-admin-${crypto.randomUUID()}`
): SpottExportReconciliationPrincipal => ({
  actorId,
  actorType: "user",
  permissions: new Set(["operator", "export"]),
});

const authorizePrincipal =
  (
    principal: SpottExportReconciliationPrincipal
  ): ReconcileSpottExportAuthorize =>
  () =>
    Promise.resolve(principal);

const expiredAuthorizationError = new SpottExportReconciliationError(
  "UNAUTHORIZED",
  "The synthetic authorization has expired"
);
const expiredAuthorize: ReconcileSpottExportAuthorize = () =>
  Promise.reject(expiredAuthorizationError);
const operationalAuthorizationError = new Error(
  "Synthetic authorization store unavailable"
);
const failingAuthorize: ReconcileSpottExportAuthorize = () =>
  Promise.reject(operationalAuthorizationError);

describe
  .skipIf(!postgresAvailable)
  .serial("Postgres Spott export reconciliation", () => {
    let clientA: ReturnType<typeof postgres>;
    let clientB: ReturnType<typeof postgres>;
    let databaseA: TestDatabase;
    let databaseB: TestDatabase;
    const ownedScopeIds = new Set<string>();

    const seedFixture = async (
      options: FixtureOptions = {}
    ): Promise<ReconciliationFixture> => {
      const scopeId =
        options.scopeId ?? `export-reconciliation-spec-${crypto.randomUUID()}`;
      const canonicalVacancyId = crypto.randomUUID();
      const snapshotId = crypto.randomUUID();
      const approvalId = crypto.randomUUID();
      const effectId = crypto.randomUUID();
      const approvalActorId =
        options.approvalActorId ?? "reconciliation-approver";
      const approvalMotivation =
        options.approvalMotivation ??
        "Synthetic export reconciliation approval";
      const resultIds = options.resultIds ?? [
        canonicalVacancyId,
        ...(options.additionalResultIds ?? []),
      ];
      ownedScopeIds.add(scopeId);

      await databaseA.insert(querySnapshot).values({
        createdAt: new Date("2026-09-01T09:00:00.000Z"),
        filters: {},
        id: snapshotId,
        indexVersion: 1,
        parserVersion: "reconciliation-spec-v1",
        queryText: "synthetic reconciliation fixture",
        resultIds: [...resultIds],
        savedSearchId: null,
        schemaVersion: "slice-a-v1",
        scopeId,
        searchAppliedSequence: 1n,
        searchGeneration: 1,
        searchScope: "active",
        userId: "reconciliation-spec-user",
      });
      await databaseA.insert(approvalRecord).values({
        actorId: approvalActorId,
        createdAt:
          options.approvalCreatedAt ?? new Date("2026-09-01T10:00:00.000Z"),
        expiresAt:
          options.approvalExpiresAt ?? new Date("2026-09-06T10:00:00.000Z"),
        id: approvalId,
        motivatie: approvalMotivation,
        resultIds: [...resultIds],
        scopeId,
        snapshotId,
      });
      await databaseA.insert(exportEffect).values({
        actionType: "create",
        canonicalVacancyId,
        createdAt: new Date("2026-09-01T11:00:00.000Z"),
        id: effectId,
        scopeId,
        status: "reserved",
        target: "spott",
        updatedAt: new Date("2026-09-01T11:00:00.000Z"),
      });

      return {
        approvalActorId,
        approvalMotivation,
        canonicalVacancyId,
        effectId,
        input: {
          apply: false,
          approvalId,
          authorizationRef: `test-auth:${crypto.randomUUID()}`,
          canonicalVacancyId,
          evidenceRef: `test-evidence:${crypto.randomUUID()}`,
          externalId: `spott-${crypto.randomUUID()}`,
          scopeId,
          snapshotId,
        },
        resultIds,
        scopeId,
      };
    };

    const reconcile = (
      database: ExportReconciliationDatabase,
      fixture: ReconciliationFixture,
      authorize: ReconcileSpottExportAuthorize,
      input: ReconcileSpottExportInput = fixture.input
    ) =>
      reconcileSpottExportId(database, input, authorize, {
        expectedScopeId: fixture.scopeId,
        now: () => reconciliationNow,
      });

    const dryRun = async (
      database: ExportReconciliationDatabase,
      fixture: ReconciliationFixture,
      authorize: ReconcileSpottExportAuthorize,
      input: ReconcileSpottExportInput = fixture.input
    ) => {
      const result = await reconcile(database, fixture, authorize, input);
      if (result.applied) {
        throw new Error("Expected reconciliation dry run");
      }
      return result;
    };

    const applyCurrentPlan = async (
      database: ExportReconciliationDatabase,
      fixture: ReconciliationFixture,
      authorize: ReconcileSpottExportAuthorize
    ) => {
      const preview = await dryRun(database, fixture, authorize);
      return reconcile(database, fixture, authorize, {
        ...fixture.input,
        apply: true,
        planHash: preview.planHash,
      });
    };

    const readReconciliationWrites = async (scopeId: string) => {
      const [effects, audits, crosswalks, attempts, receipts] =
        await Promise.all([
          databaseA
            .select()
            .from(exportEffect)
            .where(eq(exportEffect.scopeId, scopeId)),
          databaseA
            .select()
            .from(auditEvent)
            .where(eq(auditEvent.scopeId, scopeId)),
          databaseA
            .select()
            .from(externalIdCrosswalk)
            .where(eq(externalIdCrosswalk.scopeId, scopeId)),
          databaseA
            .select()
            .from(exportAttempt)
            .where(eq(exportAttempt.scopeId, scopeId)),
          databaseA
            .select()
            .from(externalReceipt)
            .where(eq(externalReceipt.scopeId, scopeId)),
        ]);
      return { attempts, audits, crosswalks, effects, receipts };
    };

    const expectNoReconciliationWrites = async (
      fixture: ReconciliationFixture
    ): Promise<void> => {
      const writes = await readReconciliationWrites(fixture.scopeId);
      expect(writes.effects).toMatchObject([
        { externalId: null, externalIdSource: null, status: "reserved" },
      ]);
      expect(writes.audits).toHaveLength(0);
      expect(writes.crosswalks).toHaveLength(0);
      expect(writes.attempts).toHaveLength(0);
      expect(writes.receipts).toHaveLength(0);
    };

    const cleanupScope = async (scopeId: string): Promise<void> => {
      await databaseA
        .delete(externalReceipt)
        .where(eq(externalReceipt.scopeId, scopeId));
      await databaseA
        .delete(exportAttempt)
        .where(eq(exportAttempt.scopeId, scopeId));
      await databaseA
        .delete(externalIdCrosswalk)
        .where(eq(externalIdCrosswalk.scopeId, scopeId));
      await databaseA.delete(auditEvent).where(eq(auditEvent.scopeId, scopeId));
      await databaseA
        .delete(exportEffect)
        .where(eq(exportEffect.scopeId, scopeId));
      await databaseA
        .delete(approvalRecord)
        .where(eq(approvalRecord.scopeId, scopeId));
      await databaseA
        .delete(querySnapshot)
        .where(eq(querySnapshot.scopeId, scopeId));
    };

    beforeAll(async () => {
      if (!disposableTestDatabaseUrl || !disposableApplicationTestDatabaseUrl) {
        throw new Error("Disposable test database URL is unavailable");
      }
      const migrationClient = postgres(disposableTestDatabaseUrl, { max: 1 });
      try {
        await migrate(drizzle(migrationClient, { schema }), {
          migrationsFolder,
        });
      } finally {
        await migrationClient.end({ timeout: 5 });
      }
      clientA = postgres(disposableApplicationTestDatabaseUrl, { max: 1 });
      clientB = postgres(disposableApplicationTestDatabaseUrl, { max: 1 });
      databaseA = drizzle(clientA, { schema });
      databaseB = drizzle(clientB, { schema });
    });

    afterEach(async () => {
      for (const scopeId of ownedScopeIds) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- bounded synthetic scopes require foreign-key ordered cleanup
        await cleanupScope(scopeId);
      }
      ownedScopeIds.clear();
    });

    afterAll(async () => {
      await clientA.end({ timeout: 5 });
      await clientB.end({ timeout: 5 });
    });

    it("uses a read-only repeatable-read transaction for dry runs", async () => {
      const fixture = await seedFixture();
      const principal = authorizedPrincipal();
      let transactionSettings:
        | { readonly isolation: string; readonly readOnly: string }
        | undefined;
      const authorize: ReconcileSpottExportAuthorize = async (
        transaction,
        mode
      ) => {
        expect(mode).toBe("dry-run");
        const [settings] = await transaction.execute<{
          isolation: string;
          readOnly: string;
        }>(sql`
          SELECT
            current_setting('transaction_isolation') AS isolation,
            current_setting('transaction_read_only') AS "readOnly"
        `);
        transactionSettings = settings;
        return principal;
      };

      const result = await dryRun(databaseA, fixture, authorize);

      expect(result.mode).toBe("dry-run");
      expect(transactionSettings).toEqual({
        isolation: "repeatable read",
        readOnly: "on",
      });
      await expectNoReconciliationWrites(fixture);
    });

    it("returns bounded selection and approval evidence in the dry-run plan", async () => {
      const fixture = await seedFixture({
        additionalResultIds: [crypto.randomUUID(), crypto.randomUUID()],
        approvalMotivation: "Synthetic motivation that must stay private",
      });
      const preview = await dryRun(
        databaseA,
        fixture,
        authorizePrincipal(authorizedPrincipal())
      );
      const [resultIdsHash, motivationHash] = await Promise.all([
        hashOrderedExportResultIds(fixture.resultIds),
        hashExportApprovalMotivation(fixture.approvalMotivation),
      ]);

      expect(preview.plan.canonicalVacancyId).toBe(fixture.canonicalVacancyId);
      expect(preview.plan.snapshot).toMatchObject({
        resultCount: fixture.resultIds.length,
        resultIdsHash,
      });
      expect(preview.plan.approval).toMatchObject({
        actorId: fixture.approvalActorId,
        motivationHash,
        resultCount: fixture.resultIds.length,
        resultIdsHash,
      });
      expect(preview.plan.snapshot).not.toHaveProperty("resultIds");
      expect(preview.plan.approval).not.toHaveProperty("resultIds");
      expect(preview.plan.approval).not.toHaveProperty("motivatie");
      expect(JSON.stringify(preview.plan)).not.toContain(
        fixture.approvalMotivation
      );
      for (const omittedResultId of fixture.resultIds.slice(1)) {
        expect(JSON.stringify(preview.plan)).not.toContain(omittedResultId);
      }
    });

    it("applies one manual ID and audit without export side effects", async () => {
      const fixture = await seedFixture();
      const principal = authorizedPrincipal();

      const result = await applyCurrentPlan(
        databaseA,
        fixture,
        authorizePrincipal(principal)
      );
      const writes = await readReconciliationWrites(fixture.scopeId);

      expect(result).toMatchObject({ applied: true, mode: "apply" });
      expect(writes.effects).toMatchObject([
        {
          externalId: fixture.input.externalId,
          externalIdSource: "manual_evidence",
          status: "external_id_acquired",
        },
      ]);
      expect(writes.audits).toHaveLength(1);
      expect(writes.audits[0]).toMatchObject({
        action: "reconcile_spott_export_id",
        actorId: principal.actorId,
        actorType: "user",
        auditClass: "effect",
        entityId: fixture.effectId,
        entityType: "export_effect",
        scopeId: fixture.scopeId,
      });
      expect(writes.audits[0]?.metadata).toEqual({
        actionType: "create",
        approvalId: fixture.input.approvalId,
        authorizationRef: fixture.input.authorizationRef,
        canonicalVacancyId: fixture.canonicalVacancyId,
        evidenceRef: fixture.input.evidenceRef,
        externalId: fixture.input.externalId,
        planHash: result.planHash,
        snapshotId: fixture.input.snapshotId,
        target: "spott",
      });
      expect(writes.crosswalks).toHaveLength(0);
      expect(writes.attempts).toHaveLength(0);
      expect(writes.receipts).toHaveLength(0);
    });

    it("rejects replay of an applied plan without duplicating its audit", async () => {
      const fixture = await seedFixture();
      const authorize = authorizePrincipal(authorizedPrincipal());
      const preview = await dryRun(databaseA, fixture, authorize);
      const applyInput = {
        ...fixture.input,
        apply: true,
        planHash: preview.planHash,
      };
      await reconcile(databaseA, fixture, authorize, applyInput);

      await expect(
        reconcile(databaseB, fixture, authorize, applyInput)
      ).rejects.toMatchObject({ code: "RESERVATION_NOT_RECONCILABLE" });
      const writes = await readReconciliationWrites(fixture.scopeId);

      expect(writes.audits).toHaveLength(1);
      expect(writes.effects).toMatchObject([
        {
          externalId: fixture.input.externalId,
          externalIdSource: "manual_evidence",
          status: "external_id_acquired",
        },
      ]);
    });

    it("uses a serializable transaction for apply", async () => {
      const fixture = await seedFixture();
      const principal = authorizedPrincipal();
      let applyTransactionSettings:
        | { readonly isolation: string; readonly readOnly: string }
        | undefined;
      const authorize: ReconcileSpottExportAuthorize = async (
        transaction,
        mode
      ) => {
        if (mode === "apply") {
          const [settings] = await transaction.execute<{
            isolation: string;
            readOnly: string;
          }>(sql`
            SELECT
              current_setting('transaction_isolation') AS isolation,
              current_setting('transaction_read_only') AS "readOnly"
          `);
          applyTransactionSettings = settings;
        }
        return principal;
      };

      await applyCurrentPlan(databaseA, fixture, authorize);

      expect(applyTransactionSettings).toEqual({
        isolation: "serializable",
        readOnly: "off",
      });
    });

    it("rejects a missing reservation", async () => {
      const fixture = await seedFixture();
      await databaseA
        .delete(exportEffect)
        .where(eq(exportEffect.id, fixture.effectId));

      await expect(
        reconcile(databaseA, fixture, authorizePrincipal(authorizedPrincipal()))
      ).rejects.toMatchObject({ code: "RESERVATION_NOT_FOUND" });
    });

    it("rejects a reservation with a known external ID", async () => {
      const fixture = await seedFixture();
      await databaseA
        .update(exportEffect)
        .set({
          externalId: "spott-already-known",
          externalIdSource: "provider_response",
          status: "external_id_acquired",
        })
        .where(eq(exportEffect.id, fixture.effectId));

      await expect(
        reconcile(databaseA, fixture, authorizePrincipal(authorizedPrincipal()))
      ).rejects.toMatchObject({ code: "RESERVATION_NOT_RECONCILABLE" });
    });

    it("rejects a confirmed reservation", async () => {
      const fixture = await seedFixture();
      await databaseA
        .update(exportEffect)
        .set({
          externalId: "spott-confirmed",
          externalIdSource: "provider_response",
          status: "confirmed",
        })
        .where(eq(exportEffect.id, fixture.effectId));

      await expect(
        reconcile(databaseA, fixture, authorizePrincipal(authorizedPrincipal()))
      ).rejects.toMatchObject({ code: "RESERVATION_NOT_RECONCILABLE" });
    });

    it("rejects a reservation that already has a crosswalk", async () => {
      const fixture = await seedFixture();
      await databaseA.insert(externalIdCrosswalk).values({
        actionType: "create",
        canonicalVacancyId: fixture.canonicalVacancyId,
        externalId: "spott-crosswalk",
        scopeId: fixture.scopeId,
        target: "spott",
      });

      await expect(
        reconcile(databaseA, fixture, authorizePrincipal(authorizedPrincipal()))
      ).rejects.toMatchObject({ code: "CROSSWALK_EXISTS" });
    });

    it("rejects an external ID already recorded on another canonical effect", async () => {
      const fixture = await seedFixture();
      const conflictingFixture = await seedFixture({
        scopeId: fixture.scopeId,
      });
      await databaseA
        .update(exportEffect)
        .set({
          externalId: fixture.input.externalId,
          externalIdSource: "manual_evidence",
          status: "external_id_acquired",
        })
        .where(eq(exportEffect.id, conflictingFixture.effectId));

      await expect(
        reconcile(databaseA, fixture, authorizePrincipal(authorizedPrincipal()))
      ).rejects.toMatchObject({ code: "EXTERNAL_ID_CONFLICT" });
      const [targetEffect] = await databaseA
        .select()
        .from(exportEffect)
        .where(eq(exportEffect.id, fixture.effectId));
      const audits = await databaseA
        .select()
        .from(auditEvent)
        .where(eq(auditEvent.scopeId, fixture.scopeId));

      expect(targetEffect).toMatchObject({
        externalId: null,
        externalIdSource: null,
        status: "reserved",
      });
      expect(audits).toHaveLength(0);
    });

    it("rejects an external ID crosswalk bound to another canonical vacancy", async () => {
      const fixture = await seedFixture();
      await databaseA.insert(externalIdCrosswalk).values({
        actionType: "create",
        canonicalVacancyId: crypto.randomUUID(),
        externalId: fixture.input.externalId,
        scopeId: fixture.scopeId,
        target: "spott",
      });

      await expect(
        reconcile(databaseA, fixture, authorizePrincipal(authorizedPrincipal()))
      ).rejects.toMatchObject({ code: "EXTERNAL_ID_CONFLICT" });
      const [targetEffect] = await databaseA
        .select()
        .from(exportEffect)
        .where(eq(exportEffect.id, fixture.effectId));

      expect(targetEffect).toMatchObject({
        externalId: null,
        externalIdSource: null,
        status: "reserved",
      });
    });

    it("rejects a scope outside the configured deployment", async () => {
      const fixture = await seedFixture();

      await expect(
        reconcileSpottExportId(
          databaseA,
          fixture.input,
          authorizePrincipal(authorizedPrincipal()),
          { expectedScopeId: `other-${fixture.scopeId}` }
        )
      ).rejects.toMatchObject({ code: "SCOPE_MISMATCH" });
      await expectNoReconciliationWrites(fixture);
    });

    it("rejects an approval bound to a different snapshot", async () => {
      const fixture = await seedFixture();
      const otherSnapshotId = crypto.randomUUID();
      await databaseA.insert(querySnapshot).values({
        createdAt: new Date("2026-09-01T09:30:00.000Z"),
        filters: {},
        id: otherSnapshotId,
        indexVersion: 1,
        parserVersion: "reconciliation-spec-v1",
        queryText: "synthetic alternate snapshot",
        resultIds: [fixture.canonicalVacancyId],
        savedSearchId: null,
        schemaVersion: "slice-a-v1",
        scopeId: fixture.scopeId,
        searchAppliedSequence: 1n,
        searchGeneration: 1,
        searchScope: "active",
        userId: "reconciliation-spec-user",
      });

      await expect(
        reconcile(
          databaseA,
          fixture,
          authorizePrincipal(authorizedPrincipal()),
          { ...fixture.input, snapshotId: otherSnapshotId }
        )
      ).rejects.toMatchObject({ code: "APPROVAL_MISMATCH" });
      await expectNoReconciliationWrites(fixture);
    });

    it("rejects a vacancy outside the approved snapshot membership", async () => {
      const fixture = await seedFixture({ resultIds: [crypto.randomUUID()] });

      await expect(
        reconcile(databaseA, fixture, authorizePrincipal(authorizedPrincipal()))
      ).rejects.toMatchObject({ code: "APPROVAL_MISMATCH" });
      await expectNoReconciliationWrites(fixture);
    });

    it("rejects an expired approval", async () => {
      const fixture = await seedFixture({
        approvalCreatedAt: new Date("2026-09-01T10:00:00.000Z"),
        approvalExpiresAt: new Date("2026-09-04T10:00:00.000Z"),
      });

      await expect(
        reconcile(databaseA, fixture, authorizePrincipal(authorizedPrincipal()))
      ).rejects.toMatchObject({ code: "APPROVAL_EXPIRED" });
      await expectNoReconciliationWrites(fixture);
    });

    it("leaves no writes when authorization has expired", async () => {
      const fixture = await seedFixture();

      await expect(
        reconcile(databaseA, fixture, expiredAuthorize)
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await expectNoReconciliationWrites(fixture);
    });

    it("propagates an operational authorization failure without writes", async () => {
      const fixture = await seedFixture();

      await expect(
        reconcile(databaseA, fixture, failingAuthorize)
      ).rejects.toBe(operationalAuthorizationError);
      await expectNoReconciliationWrites(fixture);
    });

    it("leaves no writes when the current role is not an operator", async () => {
      const fixture = await seedFixture();
      const principal: SpottExportReconciliationPrincipal = {
        actorId: "reconciliation-non-operator",
        actorType: "user",
        permissions: new Set(["export"]),
      };

      await expect(
        reconcile(databaseA, fixture, authorizePrincipal(principal))
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await expectNoReconciliationWrites(fixture);
    });

    it("leaves no writes when the current principal lacks export permission", async () => {
      const fixture = await seedFixture();
      const principal: SpottExportReconciliationPrincipal = {
        actorId: "reconciliation-no-export",
        actorType: "user",
        permissions: new Set(["operator"]),
      };

      await expect(
        reconcile(databaseA, fixture, authorizePrincipal(principal))
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await expectNoReconciliationWrites(fixture);
    });

    it("rejects apply when the dry-run plan has become stale", async () => {
      const fixture = await seedFixture();
      const authorize = authorizePrincipal(authorizedPrincipal());
      const preview = await dryRun(databaseA, fixture, authorize);
      const changedAt = new Date(
        new Date(preview.plan.effect.updatedAt).getTime() + 1000
      );
      await databaseA
        .update(exportEffect)
        .set({ updatedAt: changedAt })
        .where(eq(exportEffect.id, fixture.effectId));

      await expect(
        reconcile(databaseA, fixture, authorize, {
          ...fixture.input,
          apply: true,
          planHash: preview.planHash,
        })
      ).rejects.toMatchObject({ code: "PLAN_HASH_MISMATCH" });
      await expectNoReconciliationWrites(fixture);
    });

    it("rejects apply when the approval actor changed after dry run", async () => {
      const fixture = await seedFixture();
      const authorize = authorizePrincipal(authorizedPrincipal());
      const preview = await dryRun(databaseA, fixture, authorize);
      await databaseA
        .update(approvalRecord)
        .set({ actorId: "different-reconciliation-approver" })
        .where(eq(approvalRecord.id, fixture.input.approvalId));

      await expect(
        reconcile(databaseA, fixture, authorize, {
          ...fixture.input,
          apply: true,
          planHash: preview.planHash,
        })
      ).rejects.toMatchObject({ code: "PLAN_HASH_MISMATCH" });
      await expectNoReconciliationWrites(fixture);
    });

    it("rejects apply when approval motivation changed after dry run", async () => {
      const fixture = await seedFixture();
      const authorize = authorizePrincipal(authorizedPrincipal());
      const preview = await dryRun(databaseA, fixture, authorize);
      await databaseA
        .update(approvalRecord)
        .set({ motivatie: "Changed synthetic reconciliation motivation" })
        .where(eq(approvalRecord.id, fixture.input.approvalId));

      await expect(
        reconcile(databaseA, fixture, authorize, {
          ...fixture.input,
          apply: true,
          planHash: preview.planHash,
        })
      ).rejects.toMatchObject({ code: "PLAN_HASH_MISMATCH" });
      await expectNoReconciliationWrites(fixture);
    });

    it("rolls the effect update back when audit persistence fails", async () => {
      const fixture = await seedFixture();
      const invalidAuditPrincipal = {
        actorId: "reconciliation-invalid-audit-actor",
        // SAFETY: this DB fixture deliberately crosses the typed boundary to force the audit constraint failure after the effect update.
        actorType: "invalid" as SpottExportReconciliationPrincipal["actorType"],
        permissions: new Set(["operator", "export"]),
      };
      const authorize = authorizePrincipal(invalidAuditPrincipal);

      await expect(
        applyCurrentPlan(databaseA, fixture, authorize)
      ).rejects.toThrow();
      await expectNoReconciliationWrites(fixture);
    });

    it("allows at most one concurrent apply for the same external ID", async () => {
      const fixture = await seedFixture();
      const authorize = authorizePrincipal(authorizedPrincipal());
      const preview = await dryRun(databaseA, fixture, authorize);
      const applyInput = {
        ...fixture.input,
        apply: true,
        planHash: preview.planHash,
      };

      const results = await Promise.allSettled([
        reconcile(databaseA, fixture, authorize, applyInput),
        reconcile(databaseB, fixture, authorize, applyInput),
      ]);
      const writes = await readReconciliationWrites(fixture.scopeId);

      expect(
        results.filter((result) => result.status === "fulfilled")
      ).toHaveLength(1);
      expect(writes.audits).toHaveLength(1);
      expect(writes.effects).toMatchObject([
        {
          externalId: fixture.input.externalId,
          externalIdSource: "manual_evidence",
          status: "external_id_acquired",
        },
      ]);
    });

    it("allows at most one concurrent apply for competing external IDs", async () => {
      const fixture = await seedFixture();
      const authorize = authorizePrincipal(authorizedPrincipal());
      const firstPreview = await dryRun(databaseA, fixture, authorize);
      const competingInput = {
        ...fixture.input,
        externalId: `spott-competing-${crypto.randomUUID()}`,
      };
      const competingPreview = await reconcileSpottExportId(
        databaseA,
        competingInput,
        authorize,
        { expectedScopeId: fixture.scopeId, now: () => reconciliationNow }
      );
      if (competingPreview.applied) {
        throw new Error("Expected competing reconciliation dry run");
      }

      const results = await Promise.allSettled([
        reconcile(databaseA, fixture, authorize, {
          ...fixture.input,
          apply: true,
          planHash: firstPreview.planHash,
        }),
        reconcile(databaseB, fixture, authorize, {
          ...competingInput,
          apply: true,
          planHash: competingPreview.planHash,
        }),
      ]);
      const writes = await readReconciliationWrites(fixture.scopeId);

      expect(
        results.filter((result) => result.status === "fulfilled")
      ).toHaveLength(1);
      expect(writes.audits).toHaveLength(1);
      const persistedExternalId = writes.effects[0]?.externalId;
      if (!persistedExternalId) {
        throw new Error("Expected the winning external ID to be persisted");
      }
      expect([fixture.input.externalId, competingInput.externalId]).toContain(
        persistedExternalId
      );
    });

    it("allows exactly one canonical reservation to bind a shared external ID", async () => {
      const firstFixture = await seedFixture();
      const secondFixture = await seedFixture({
        scopeId: firstFixture.scopeId,
      });
      const externalId = `spott-shared-${crypto.randomUUID()}`;
      const principal = authorizedPrincipal();
      const authorize = authorizePrincipal(principal);
      const firstInput = { ...firstFixture.input, externalId };
      const secondInput = { ...secondFixture.input, externalId };
      const firstPreview = await dryRun(
        databaseA,
        firstFixture,
        authorize,
        firstInput
      );
      const secondPreview = await dryRun(
        databaseA,
        secondFixture,
        authorize,
        secondInput
      );

      const results = await Promise.allSettled([
        reconcile(databaseA, firstFixture, authorize, {
          ...firstInput,
          apply: true,
          planHash: firstPreview.planHash,
        }),
        reconcile(databaseB, secondFixture, authorize, {
          ...secondInput,
          apply: true,
          planHash: secondPreview.planHash,
        }),
      ]);
      const writes = await readReconciliationWrites(firstFixture.scopeId);

      expect(
        results.filter((result) => result.status === "fulfilled")
      ).toHaveLength(1);
      expect(
        writes.effects.filter((effect) => effect.externalId === externalId)
      ).toHaveLength(1);
      expect(
        writes.effects.filter((effect) => effect.status === "reserved")
      ).toHaveLength(1);
      expect(writes.audits).toHaveLength(1);
      expect(writes.crosswalks).toHaveLength(0);
      expect(writes.attempts).toHaveLength(0);
      expect(writes.receipts).toHaveLength(0);
    });

    it("aborts reconciliation after an overlapping recordExternalId ownership claim", async () => {
      const reconciliationFixture = await seedFixture();
      const providerFixture = await seedFixture({
        scopeId: reconciliationFixture.scopeId,
      });
      const externalId = `spott-shared-${crypto.randomUUID()}`;
      const principal = authorizedPrincipal();
      const authorize = authorizePrincipal(principal);
      const reconciliationInput = {
        ...reconciliationFixture.input,
        externalId,
      };
      const preview = await dryRun(
        databaseA,
        reconciliationFixture,
        authorize,
        reconciliationInput
      );
      const providerStore = new PostgresExportEffectStore(databaseB);
      const overlappingAuthorize: ReconcileSpottExportAuthorize = async (
        transaction
      ) => {
        // Establish A's serializable snapshot, then let B read the same absence
        // and commit before A resumes with its intentionally stale snapshot.
        await transaction.execute(sql`select 1`);
        await providerStore.recordExternalId({
          actionType: "create",
          canonicalVacancyId: providerFixture.canonicalVacancyId,
          externalId,
          scopeId: providerFixture.scopeId,
          source: "provider_response",
          target: "spott",
        });
        return principal;
      };

      let rejection: Error | undefined;
      try {
        await reconcile(
          databaseA,
          reconciliationFixture,
          overlappingAuthorize,
          {
            ...reconciliationInput,
            apply: true,
            planHash: preview.planHash,
          }
        );
      } catch (error) {
        if (!(error instanceof Error)) {
          throw error;
        }
        rejection = error;
      }
      if (!rejection) {
        throw new Error("Expected reconciliation serialization failure");
      }
      expect(findPostgresErrorCode(rejection)).toBe("40001");
      const writes = await readReconciliationWrites(
        reconciliationFixture.scopeId
      );

      expect(
        writes.effects.filter((effect) => effect.externalId === externalId)
      ).toHaveLength(1);
      const reconciledEffect = writes.effects.find(
        (effect) =>
          effect.canonicalVacancyId === reconciliationFixture.canonicalVacancyId
      );
      expect(reconciledEffect).toMatchObject({
        externalId: null,
        status: "reserved",
      });
      expect(writes.audits).toHaveLength(0);
      expect(writes.crosswalks).toHaveLength(0);
      expect(writes.attempts).toHaveLength(0);
      expect(writes.receipts).toHaveLength(0);
    });

    it("aborts reconciliation after overlapping crosswalk ownership creation", async () => {
      const fixture = await seedFixture();
      const { externalId } = fixture.input;
      const principal = authorizedPrincipal();
      const authorize = authorizePrincipal(principal);
      const preview = await dryRun(databaseA, fixture, authorize);
      const crosswalkCanonicalVacancyId = crypto.randomUUID();
      const crosswalkStore = new PostgresExternalIdCrosswalkStore(databaseB);
      const overlappingAuthorize: ReconcileSpottExportAuthorize = async (
        transaction
      ) => {
        // Establish A's serializable snapshot, then let B read the same absence
        // and commit before A resumes with its intentionally stale snapshot.
        await transaction.execute(sql`select 1`);
        await crosswalkStore.create({
          actionType: "create",
          canonicalVacancyId: crosswalkCanonicalVacancyId,
          externalId,
          scopeId: fixture.scopeId,
          target: "spott",
        });
        return principal;
      };

      let rejection: Error | undefined;
      try {
        await reconcile(databaseA, fixture, overlappingAuthorize, {
          ...fixture.input,
          apply: true,
          planHash: preview.planHash,
        });
      } catch (error) {
        if (!(error instanceof Error)) {
          throw error;
        }
        rejection = error;
      }
      if (!rejection) {
        throw new Error("Expected reconciliation serialization failure");
      }
      expect(findPostgresErrorCode(rejection)).toBe("40001");
      const writes = await readReconciliationWrites(fixture.scopeId);

      expect(writes.effects).toMatchObject([
        { externalId: null, status: "reserved" },
      ]);
      expect(writes.crosswalks).toMatchObject([
        { canonicalVacancyId: crosswalkCanonicalVacancyId, externalId },
      ]);
      expect(writes.audits).toHaveLength(0);
      expect(writes.attempts).toHaveLength(0);
      expect(writes.receipts).toHaveLength(0);
    });
  });
