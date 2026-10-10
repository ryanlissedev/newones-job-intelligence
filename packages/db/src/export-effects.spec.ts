import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";

import type { ExportEffectKey } from "@ji/application/registry";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import {
  PostgresExportEffectStore,
  PostgresExternalIdCrosswalkStore,
} from "./export-stores";
import * as schema from "./schema";
import {
  approvalRecord,
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

type TestDatabase = ReturnType<typeof drizzle<typeof schema>>;

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

  const databaseName = parsedUrl.pathname.slice(1);
  if (!/^ji_test_iso_[a-z0-9_]+$/u.test(databaseName)) {
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

const createKey = (scopeId: string): ExportEffectKey => ({
  actionType: "create",
  canonicalVacancyId: crypto.randomUUID(),
  scopeId,
  target: "spott",
});

describe
  .skipIf(!postgresAvailable)
  .serial("Postgres export effect store", () => {
    let clientA: ReturnType<typeof postgres>;
    let clientB: ReturnType<typeof postgres>;
    let databaseA: TestDatabase;
    let databaseB: TestDatabase;
    let storeA: PostgresExportEffectStore;
    let storeB: PostgresExportEffectStore;
    let crosswalkStoreA: PostgresExternalIdCrosswalkStore;
    let crosswalkStoreB: PostgresExternalIdCrosswalkStore;
    const ownedScopeIds = new Set<string>();

    const createScopeId = (): string => {
      const scopeId = `export-effect-spec-${crypto.randomUUID()}`;
      ownedScopeIds.add(scopeId);
      return scopeId;
    };

    const seedConfirmationReferences = async (
      key: ExportEffectKey
    ): Promise<{
      readonly approvalId: string;
      readonly snapshotId: string;
    }> => {
      const snapshotId = crypto.randomUUID();
      const approvalId = crypto.randomUUID();
      await databaseA.insert(querySnapshot).values({
        filters: {},
        id: snapshotId,
        indexVersion: 1,
        parserVersion: "export-effect-spec-v1",
        queryText: "synthetic export effect fixture",
        resultIds: [key.canonicalVacancyId],
        savedSearchId: null,
        schemaVersion: "slice-a-v1",
        scopeId: key.scopeId,
        searchAppliedSequence: 1n,
        searchGeneration: 1,
        searchScope: "active",
        userId: "export-effect-spec-user",
      });
      await databaseA.insert(approvalRecord).values({
        actorId: "export-effect-spec-actor",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        id: approvalId,
        motivatie: "Synthetic approval for export effect integration test",
        resultIds: [key.canonicalVacancyId],
        scopeId: key.scopeId,
        snapshotId,
      });
      return { approvalId, snapshotId };
    };

    const prepareExternalEffect = async (
      key: ExportEffectKey,
      externalId: string
    ): Promise<void> => {
      await storeA.reserve(key);
      await storeA.recordExternalId({
        ...key,
        externalId,
        source: "provider_response",
      });
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
      storeA = new PostgresExportEffectStore(databaseA);
      storeB = new PostgresExportEffectStore(databaseB);
      crosswalkStoreA = new PostgresExternalIdCrosswalkStore(databaseA);
      crosswalkStoreB = new PostgresExternalIdCrosswalkStore(databaseB);
    });

    afterEach(async () => {
      for (const scopeId of ownedScopeIds) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- bounded fixture scopes must clean up sequentially in foreign-key order
        await cleanupScope(scopeId);
      }
      ownedScopeIds.clear();
    });

    afterAll(async () => {
      await clientA.end({ timeout: 5 });
      await clientB.end({ timeout: 5 });
    });

    it("atomically grants one reservation across two store instances", async () => {
      const key = createKey(createScopeId());

      const results = await Promise.all([
        storeA.reserve(key),
        storeB.reserve(key),
      ]);

      expect(results.filter((result) => result.acquired)).toHaveLength(1);
      expect(results.filter((result) => !result.acquired)).toHaveLength(1);
    });

    it("reads the same external ID after recreating the adapter and connection", async () => {
      if (!disposableApplicationTestDatabaseUrl) {
        throw new Error("Disposable test database URL is unavailable");
      }
      const key = createKey(createScopeId());
      const externalId = `spott-${crypto.randomUUID()}`;
      const initialClient = postgres(disposableApplicationTestDatabaseUrl, {
        max: 1,
      });
      try {
        const initialStore = new PostgresExportEffectStore(
          drizzle(initialClient, { schema })
        );
        await initialStore.reserve(key);
        await initialStore.recordExternalId({
          ...key,
          externalId,
          source: "provider_response",
        });
      } finally {
        await initialClient.end({ timeout: 5 });
      }

      const restartedClient = postgres(disposableApplicationTestDatabaseUrl, {
        max: 1,
      });
      try {
        const restartedStore = new PostgresExportEffectStore(
          drizzle(restartedClient, { schema })
        );
        const result = await restartedStore.reserve(key);

        expect(result).toMatchObject({
          acquired: false,
          effect: { externalId, status: "external_id_acquired" },
        });
      } finally {
        await restartedClient.end({ timeout: 5 });
      }
    });

    it("rejects a different external ID for an existing effect", async () => {
      const key = createKey(createScopeId());
      await prepareExternalEffect(key, "spott-original");

      await expect(
        storeB.recordExternalId({
          ...key,
          externalId: "spott-conflicting",
          source: "manual_evidence",
        })
      ).rejects.toThrow("already has a different external ID");
    });

    it("rejects a crosswalk after another effect owns the external ID", async () => {
      const scopeId = createScopeId();
      const effectKey = createKey(scopeId);
      const crosswalkKey = createKey(scopeId);
      const externalId = `spott-${crypto.randomUUID()}`;
      await storeA.reserve(effectKey);
      await storeA.recordExternalId({
        ...effectKey,
        externalId,
        source: "provider_response",
      });

      await expect(
        crosswalkStoreB.create({ ...crosswalkKey, externalId })
      ).rejects.toThrow("already bound to another scoped export");
    });

    it("rejects effect ownership after another crosswalk owns the external ID", async () => {
      const scopeId = createScopeId();
      const effectKey = createKey(scopeId);
      const crosswalkKey = createKey(scopeId);
      const externalId = `spott-${crypto.randomUUID()}`;
      await storeA.reserve(effectKey);
      await crosswalkStoreA.create({ ...crosswalkKey, externalId });

      await expect(
        storeB.recordExternalId({
          ...effectKey,
          externalId,
          source: "provider_response",
        })
      ).rejects.toThrow("already bound to another scoped export");
    });

    it("allows only one owner when effect and crosswalk bindings race", async () => {
      const scopeId = createScopeId();
      const effectKey = createKey(scopeId);
      const crosswalkKey = createKey(scopeId);
      const externalId = `spott-${crypto.randomUUID()}`;
      await storeA.reserve(effectKey);

      const results = await Promise.allSettled([
        storeA.recordExternalId({
          ...effectKey,
          externalId,
          source: "provider_response",
        }),
        crosswalkStoreB.create({ ...crosswalkKey, externalId }),
      ]);
      const [effects, crosswalks] = await Promise.all([
        databaseA
          .select()
          .from(exportEffect)
          .where(
            and(
              eq(exportEffect.scopeId, scopeId),
              eq(exportEffect.externalId, externalId)
            )
          ),
        databaseA
          .select()
          .from(externalIdCrosswalk)
          .where(
            and(
              eq(externalIdCrosswalk.scopeId, scopeId),
              eq(externalIdCrosswalk.externalId, externalId)
            )
          ),
      ]);

      expect(
        results.filter((result) => result.status === "fulfilled")
      ).toHaveLength(1);
      expect(effects.length + crosswalks.length).toBe(1);
    });

    it("creates at most one confirmed effect during concurrent finalization", async () => {
      const key = createKey(createScopeId());
      const externalId = `spott-${crypto.randomUUID()}`;
      const { approvalId, snapshotId } = await seedConfirmationReferences(key);
      await prepareExternalEffect(key, externalId);

      const results = await Promise.allSettled([
        storeA.finalizeConfirmed({
          ...key,
          approvalId,
          externalId,
          idempotencyKey: `export-effect-${crypto.randomUUID()}`,
          responseHash: `sha256:${crypto.randomUUID()}`,
          snapshotId,
        }),
        storeB.finalizeConfirmed({
          ...key,
          approvalId,
          externalId,
          idempotencyKey: `export-effect-${crypto.randomUUID()}`,
          responseHash: `sha256:${crypto.randomUUID()}`,
          snapshotId,
        }),
      ]);

      expect(
        results.filter(
          (result) => result.status === "fulfilled" && result.value.created
        )
      ).toHaveLength(1);

      const retry = await storeA.finalizeConfirmed({
        ...key,
        approvalId,
        externalId,
        idempotencyKey: `export-effect-${crypto.randomUUID()}`,
        responseHash: `sha256:${crypto.randomUUID()}`,
        snapshotId,
      });
      expect(retry).toEqual({ created: false, externalId });
    });

    it("rolls back effect, crosswalk, attempt, and receipt changes after attempt failure", async () => {
      const key = createKey(createScopeId());
      const externalId = `spott-${crypto.randomUUID()}`;
      const { snapshotId } = await seedConfirmationReferences(key);
      await prepareExternalEffect(key, externalId);

      await expect(
        storeA.finalizeConfirmed({
          ...key,
          approvalId: crypto.randomUUID(),
          externalId,
          idempotencyKey: `export-effect-${crypto.randomUUID()}`,
          responseHash: `sha256:${crypto.randomUUID()}`,
          snapshotId,
        })
      ).rejects.toThrow();

      const [effects, crosswalks, attempts, receipts] = await Promise.all([
        databaseA
          .select()
          .from(exportEffect)
          .where(
            and(
              eq(exportEffect.scopeId, key.scopeId),
              eq(exportEffect.canonicalVacancyId, key.canonicalVacancyId)
            )
          ),
        databaseA
          .select()
          .from(externalIdCrosswalk)
          .where(eq(externalIdCrosswalk.scopeId, key.scopeId)),
        databaseA
          .select()
          .from(exportAttempt)
          .where(eq(exportAttempt.scopeId, key.scopeId)),
        databaseA
          .select()
          .from(externalReceipt)
          .where(eq(externalReceipt.scopeId, key.scopeId)),
      ]);

      expect(effects).toMatchObject([
        { externalId, status: "external_id_acquired" },
      ]);
      expect(crosswalks).toHaveLength(0);
      expect(attempts).toHaveLength(0);
      expect(receipts).toHaveLength(0);
    });

    it("rejects a blank response hash before creating finalization records", async () => {
      const key = createKey(createScopeId());
      const externalId = `spott-${crypto.randomUUID()}`;
      const { approvalId, snapshotId } = await seedConfirmationReferences(key);
      await prepareExternalEffect(key, externalId);

      await expect(
        storeA.finalizeConfirmed({
          ...key,
          approvalId,
          externalId,
          idempotencyKey: `export-effect-${crypto.randomUUID()}`,
          responseHash: " ",
          snapshotId,
        })
      ).rejects.toThrow();

      const [crosswalks, attempts, receipts] = await Promise.all([
        databaseA
          .select()
          .from(externalIdCrosswalk)
          .where(eq(externalIdCrosswalk.scopeId, key.scopeId)),
        databaseA
          .select()
          .from(exportAttempt)
          .where(eq(exportAttempt.scopeId, key.scopeId)),
        databaseA
          .select()
          .from(externalReceipt)
          .where(eq(externalReceipt.scopeId, key.scopeId)),
      ]);

      expect(crosswalks).toHaveLength(0);
      expect(attempts).toHaveLength(0);
      expect(receipts).toHaveLength(0);
    });

    it("allows confirmation to succeed after a rolled-back attempt failure", async () => {
      const key = createKey(createScopeId());
      const externalId = `spott-${crypto.randomUUID()}`;
      const { approvalId, snapshotId } = await seedConfirmationReferences(key);
      await prepareExternalEffect(key, externalId);
      const idempotencyKey = `export-effect-${crypto.randomUUID()}`;
      await expect(
        storeA.finalizeConfirmed({
          ...key,
          approvalId: crypto.randomUUID(),
          externalId,
          idempotencyKey,
          responseHash: `sha256:${crypto.randomUUID()}`,
          snapshotId,
        })
      ).rejects.toThrow();

      const result = await storeB.finalizeConfirmed({
        ...key,
        approvalId,
        externalId,
        idempotencyKey,
        responseHash: `sha256:${crypto.randomUUID()}`,
        snapshotId,
      });

      expect(result.created).toBe(true);
    });
  });
