import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";

import type { MotianDerivedFieldRepairV2AuditMetadata } from "@ji/application/registry";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { PostgresQuerySnapshotStore } from "./read-path-stores";
import * as schema from "./schema";
import {
  aanvraag,
  aanvraagMarkering,
  approvalRecord,
  auditEvent,
  bron,
  querySnapshot,
  savedSearch,
  scrapeRun,
} from "./schema";
import {
  PostgresApprovalStore,
  PostgresAuditStore,
  PostgresMarkeringStore,
  PostgresSavedSearchStore,
} from "./user-write-stores";

const migratorUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
const applicationUrl =
  process.env.DATABASE_APP_TEST_URL ??
  "postgresql://ji_app:ji_app_local@127.0.0.1:5432/ji_test";
const databaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;
const migrationsFolder = path.join(import.meta.dir, "migrations");

type TestDatabase = ReturnType<typeof drizzle<typeof schema>>;

const isPostgresAvailable = async (): Promise<boolean> => {
  const probe = postgres(migratorUrl, { connect_timeout: 2, max: 1 });
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
if (!postgresAvailable && databaseRequired) {
  throw new Error("Required test database is unavailable");
}

const createStoreRegistry = (database: TestDatabase) => ({
  approvals: new PostgresApprovalStore(database),
  audit: new PostgresAuditStore(database),
  markeringen: new PostgresMarkeringStore(database),
  savedSearches: new PostgresSavedSearchStore(database),
  snapshots: new PostgresQuerySnapshotStore(database),
});

const createSnapshot = (
  database: TestDatabase,
  scopeId: string,
  resultIds: readonly string[]
) =>
  new PostgresQuerySnapshotStore(database).create({
    filters: {},
    indexVersion: 1,
    parserVersion: "1",
    queryText: "Azure",
    resultIds: [...resultIds],
    savedSearchId: null,
    schemaVersion: "slice-a-v1",
    scope: "active",
    scopeId,
    searchVersion: { appliedSequence: 1n, generation: 1 },
    userId: "snapshot-owner",
  });

describe
  .skipIf(!postgresAvailable)
  .serial("durable Postgres user writes", () => {
    let migratorClient: ReturnType<typeof postgres>;
    let migratorDatabase: TestDatabase;

    beforeAll(async () => {
      migratorClient = postgres(migratorUrl, { max: 1 });
      migratorDatabase = drizzle(migratorClient, { schema });
      await migrate(migratorDatabase, { migrationsFolder });
    });

    afterAll(async () => {
      await migratorClient.end({ timeout: 5 });
    });

    const seedAanvraag = async (): Promise<{
      readonly aanvraagId: string;
      readonly bronId: string;
      readonly runId: string;
    }> => {
      const suffix = crypto.randomUUID();
      const bronId = crypto.randomUUID();
      const runId = crypto.randomUUID();
      const aanvraagId = crypto.randomUUID();
      await migratorDatabase.insert(bron).values({
        categorie: "runtime-test",
        id: bronId,
        naam: `Durable user write ${suffix}`,
      });
      await migratorDatabase.insert(scrapeRun).values({ bronId, id: runId });
      const observedAt = new Date("2026-09-02T10:00:00.000Z");
      await migratorDatabase.insert(aanvraag).values({
        beschrijving: "Durable user-write fixture",
        bronId,
        bronReferentie: `durable-${suffix}`,
        contentHash: `hash-${suffix}`,
        eersteGezienOp: observedAt,
        extractieMethode: "spec",
        id: aanvraagId,
        laatstGezienOp: observedAt,
        rawPayloadRef: `raw/spec/${suffix}.json`,
        scrapeRunId: runId,
        status: "active",
        titel: "Durable fixture",
      });
      return { aanvraagId, bronId, runId };
    };

    const cleanup = async (
      scopeId: string,
      fixture: {
        readonly aanvraagId: string;
        readonly bronId: string;
        readonly runId: string;
      }
    ): Promise<void> => {
      await migratorDatabase
        .delete(auditEvent)
        .where(eq(auditEvent.scopeId, scopeId));
      await migratorDatabase
        .delete(approvalRecord)
        .where(eq(approvalRecord.scopeId, scopeId));
      await migratorDatabase
        .delete(querySnapshot)
        .where(eq(querySnapshot.scopeId, scopeId));
      await migratorDatabase
        .delete(aanvraagMarkering)
        .where(eq(aanvraagMarkering.scopeId, scopeId));
      await migratorDatabase
        .delete(savedSearch)
        .where(eq(savedSearch.scopeId, scopeId));
      await migratorDatabase
        .delete(aanvraag)
        .where(eq(aanvraag.id, fixture.aanvraagId));
      await migratorDatabase
        .delete(scrapeRun)
        .where(eq(scrapeRun.id, fixture.runId));
      await migratorDatabase.delete(bron).where(eq(bron.id, fixture.bronId));
    };

    it("survives a new connection without crossing user or deployment boundaries", async () => {
      const fixture = await seedAanvraag();
      const scopeId = `durable-scope-${crypto.randomUUID()}`;
      const otherScopeId = `other-scope-${crypto.randomUUID()}`;
      const actorId = `durable-user-${crypto.randomUUID()}`;
      const otherActorId = `other-user-${crypto.randomUUID()}`;
      const firstClient = postgres(applicationUrl, { max: 1 });
      let savedSearchId = "";
      let auditEventId = "";
      try {
        const firstRegistry = createStoreRegistry(
          drizzle(firstClient, { schema })
        );
        const saved = await firstRegistry.savedSearches.createWithAudit(
          {
            deletedAt: null,
            filters: { locatieLand: ["NL"] },
            naam: "Duurzame zoekopdracht",
            parserVersion: "1",
            queryText: "Azure AND engineer",
            schemaVersion: "slice-a-v1",
            scopeId,
            userId: actorId,
          },
          "user"
        );
        savedSearchId = saved.savedSearch.id;
        const marked = await firstRegistry.markeringen.setWithAudit(
          {
            aanvraagId: fixture.aanvraagId,
            reden: "Past bij het profiel",
            scopeId,
            status: "relevant",
            userId: actorId,
          },
          "user"
        );
        auditEventId = marked.auditEvent.id;

        const [rawAudit] = await migratorDatabase
          .select({
            actorType: auditEvent.actorType,
            auditClass: auditEvent.auditClass,
            scopeId: auditEvent.scopeId,
          })
          .from(auditEvent)
          .where(eq(auditEvent.id, auditEventId));
        expect(rawAudit).toEqual({
          actorType: "user",
          auditClass: "effect",
          scopeId,
        });
      } finally {
        await firstClient.end({ timeout: 5 });
      }

      const secondClient = postgres(applicationUrl, { max: 1 });
      try {
        const restartedRegistry = createStoreRegistry(
          drizzle(secondClient, { schema })
        );
        const saved = await restartedRegistry.savedSearches.getById(
          savedSearchId,
          actorId,
          scopeId
        );
        expect(saved?.queryText).toBe("Azure AND engineer");
        expect(
          await restartedRegistry.savedSearches.getById(
            savedSearchId,
            otherActorId,
            scopeId
          )
        ).toBeNull();

        const updatedSearch =
          await restartedRegistry.savedSearches.updateWithAudit(
            savedSearchId,
            actorId,
            scopeId,
            {
              filters: { locatieLand: ["BE"] },
              naam: "Bijgewerkte zoekopdracht",
              parserVersion: "1",
              queryText: "Azure AND architect",
              schemaVersion: "slice-a-v1",
            },
            "user"
          );
        expect(updatedSearch?.savedSearch.queryText).toBe(
          "Azure AND architect"
        );
        expect(
          await restartedRegistry.savedSearches.list(actorId, scopeId)
        ).toHaveLength(1);
        expect(
          await restartedRegistry.savedSearches.updateWithAudit(
            savedSearchId,
            otherActorId,
            scopeId,
            {
              filters: {},
              naam: "Verboden",
              parserVersion: "1",
              queryText: "forbidden",
              schemaVersion: "slice-a-v1",
            },
            "user"
          )
        ).toBeNull();
        expect(
          await restartedRegistry.savedSearches.getById(
            savedSearchId,
            actorId,
            otherScopeId
          )
        ).toBeNull();

        const markering = await restartedRegistry.markeringen.get(
          fixture.aanvraagId,
          actorId,
          scopeId
        );
        expect(markering).toMatchObject({
          reden: "Past bij het profiel",
          revision: 1,
          scopeId,
          status: "relevant",
          userId: actorId,
        });
        expect(
          await restartedRegistry.markeringen.get(
            fixture.aanvraagId,
            otherActorId,
            scopeId
          )
        ).toBeNull();

        const cleared = await restartedRegistry.markeringen.clearWithAudit(
          fixture.aanvraagId,
          actorId,
          scopeId,
          "user"
        );
        expect(cleared?.cleared.revision).toBe(1);
        expect(
          await restartedRegistry.markeringen.get(
            fixture.aanvraagId,
            actorId,
            scopeId
          )
        ).toBeNull();

        const recreated = await restartedRegistry.markeringen.setWithAudit(
          {
            aanvraagId: fixture.aanvraagId,
            reden: "Recreated after clear",
            scopeId,
            status: "gevolgd",
            userId: actorId,
          },
          "user"
        );
        expect(recreated.markering.revision).toBe(2);
        expect(
          await restartedRegistry.markeringen.get(
            fixture.aanvraagId,
            actorId,
            scopeId
          )
        ).toMatchObject({ revision: 2, status: "gevolgd" });

        const removedSearch =
          await restartedRegistry.savedSearches.removeWithAudit(
            savedSearchId,
            actorId,
            scopeId,
            "user"
          );
        expect(removedSearch?.savedSearch.deletedAt).toBeInstanceOf(Date);
        expect(
          await restartedRegistry.savedSearches.getById(
            savedSearchId,
            actorId,
            scopeId
          )
        ).toBeNull();
        expect(
          await restartedRegistry.markeringen.get(
            fixture.aanvraagId,
            actorId,
            otherScopeId
          )
        ).toBeNull();

        const audit = await restartedRegistry.audit.listByActorId(
          actorId,
          scopeId
        );
        expect(audit.map((event) => event.id)).toContain(auditEventId);
        expect(audit.map((event) => event.action)).toEqual(
          expect.arrayContaining([
            "clear_markering",
            "create_saved_search",
            "markeer_aanvraag",
            "remove_saved_search",
            "update_saved_search",
          ])
        );
        expect(
          await restartedRegistry.audit.listByActorId(actorId, otherScopeId)
        ).toEqual([]);
      } finally {
        await secondClient.end({ timeout: 5 });
        await cleanup(scopeId, fixture);
      }
    });

    it("bounds recent audit reads within actor and scope with deterministic timestamp ties", async () => {
      const scopeId = `recent-audit-${crypto.randomUUID()}`;
      const otherScopeId = `${scopeId}-other`;
      const actorId = "recent-audit-owner";
      const applicationClient = postgres(applicationUrl, { max: 1 });
      const createdAt = new Date("2026-09-05T12:00:00.000Z");
      const ownRows = Array.from({ length: 12 }, () => ({
        action: "markeer_aanvraag",
        actorId,
        actorType: "user",
        auditClass: "effect",
        createdAt,
        entityId: "fixture-entity",
        entityType: "aanvraag",
        id: crypto.randomUUID(),
        metadata: { reden: null, status: "relevant" },
        scopeId,
      }));
      const [sample] = ownRows;
      if (!sample) {
        throw new Error("Expected an audit fixture");
      }
      try {
        await migratorDatabase
          .insert(auditEvent)
          .values([
            ...ownRows,
            { ...sample, actorId: "another-actor", id: crypto.randomUUID() },
            { ...sample, id: crypto.randomUUID(), scopeId: otherScopeId },
          ]);
        const store = new PostgresAuditStore(
          drizzle(applicationClient, { schema })
        );
        const recent = await store.listRecentByActorId(actorId, scopeId, 3);
        expect(recent).toHaveLength(3);
        expect(recent.map((event) => event.id)).toEqual(
          ownRows
            .map((event) => event.id)
            .toSorted()
            .toReversed()
            .slice(0, 3)
        );
        expect(
          recent.every(
            (event) => event.actorId === actorId && event.scopeId === scopeId
          )
        ).toBe(true);
        const foreignScope = await store.listRecentByActorId(
          actorId,
          otherScopeId,
          3
        );
        expect(foreignScope).toHaveLength(1);
      } finally {
        await applicationClient.end({ timeout: 5 });
        await migratorDatabase
          .delete(auditEvent)
          .where(eq(auditEvent.scopeId, scopeId));
        await migratorDatabase
          .delete(auditEvent)
          .where(eq(auditEvent.scopeId, otherScopeId));
      }
    });

    it("decodes a stored v2 Motian repair audit image after the v3 field bump", async () => {
      const scopeId = `motian-v2-audit-${crypto.randomUUID()}`;
      const actorId = `motian-v2-actor-${crypto.randomUUID()}`;
      const applicationClient = postgres(applicationUrl, { max: 1 });
      const v2Image = {
        contracttype: "detachering",
        opdrachtgeverNaam: "NVB opdrachtgever",
        opleidingsniveau: "HBO",
        publicatiedatum: "2026-09-10T08:10:11.000Z",
        sluitingsdatum: "2026-09-15T09:30:00.000Z",
        startDatum: "2026-10-01",
        tariefEenheid: null,
        tariefMax: null,
        tariefMin: null,
        urenPerWeek: "36",
      };
      const metadata: MotianDerivedFieldRepairV2AuditMetadata = {
        aanvraagId: crypto.randomUUID(),
        afterimage: v2Image,
        bronId: crypto.randomUUID(),
        bronReferentie: "external-v2",
        changedFields: ["opleidingsniveau"],
        contentHash: "a".repeat(64),
        manifestSha256: "b".repeat(64),
        preimage: { ...v2Image, opleidingsniveau: null },
        rawPayloadRef: "raw/nationalevacaturebank/2026/09/10/x.json",
        repairVersion: "motian-v1-derived-field-repair/v2",
        sourceAbsentFields: [],
        v1Id: "motian-v2-row",
      };
      try {
        await migratorDatabase.insert(auditEvent).values({
          action: "motian_v1_derived_field_repair_apply",
          actorId,
          actorType: "service",
          auditClass: "effect",
          entityId: metadata.aanvraagId,
          entityType: "aanvraag",
          id: crypto.randomUUID(),
          metadata,
          scopeId,
        });
        const store = new PostgresAuditStore(
          drizzle(applicationClient, { schema })
        );
        const events = await store.listByActorId(actorId, scopeId);
        expect(events).toHaveLength(1);
        expect(events[0]?.metadata).toEqual(metadata);
      } finally {
        await applicationClient.end({ timeout: 5 });
        await migratorDatabase
          .delete(auditEvent)
          .where(eq(auditEvent.scopeId, scopeId));
      }
    });

    it("rolls markering inserts and updates back when the audit append fails", async () => {
      const fixture = await seedAanvraag();
      const scopeId = `rollback-markering-${crypto.randomUUID()}`;
      const actorId = `rollback-user-${crypto.randomUUID()}`;
      const insertActorId = `rollback-insert-user-${crypto.randomUUID()}`;
      const applicationClient = postgres(applicationUrl, { max: 1 });
      try {
        const database = drizzle(applicationClient, { schema });
        const durable = new PostgresMarkeringStore(database);
        await durable.setWithAudit(
          {
            aanvraagId: fixture.aanvraagId,
            reden: null,
            scopeId,
            status: "relevant",
            userId: actorId,
          },
          "user"
        );
        const failing = new PostgresMarkeringStore(database, () =>
          Promise.reject(new Error("forced audit append failure"))
        );

        await expect(
          failing.setWithAudit(
            {
              aanvraagId: fixture.aanvraagId,
              reden: "must roll back",
              scopeId,
              status: "gevolgd",
              userId: actorId,
            },
            "agent"
          )
        ).rejects.toThrow("forced audit append failure");
        expect(
          await durable.get(fixture.aanvraagId, actorId, scopeId)
        ).toMatchObject({ reden: null, revision: 1, status: "relevant" });

        await expect(
          failing.setWithAudit(
            {
              aanvraagId: fixture.aanvraagId,
              reden: null,
              scopeId,
              status: "niet_relevant",
              userId: insertActorId,
            },
            "agent"
          )
        ).rejects.toThrow("forced audit append failure");
        expect(
          await durable.get(fixture.aanvraagId, insertActorId, scopeId)
        ).toBeNull();
      } finally {
        await applicationClient.end({ timeout: 5 });
        await cleanup(scopeId, fixture);
      }
    });

    it("rolls an approval back when its audit append fails", async () => {
      const fixture = await seedAanvraag();
      const scopeId = `rollback-approval-${crypto.randomUUID()}`;
      const actorId = `approval-user-${crypto.randomUUID()}`;
      const applicationClient = postgres(applicationUrl, { max: 2 });
      try {
        const database = drizzle(applicationClient, { schema });
        const snapshot = await createSnapshot(database, scopeId, [
          fixture.aanvraagId,
        ]);
        const input = {
          actorId,
          expiresAt: new Date("2030-09-30T00:00:00.000Z"),
          motivatie: "Rollback evidence",
          resultIds: [...snapshot.resultIds],
          scopeId,
          snapshotId: snapshot.id,
        };
        const failing = new PostgresApprovalStore(database, () =>
          Promise.reject(new Error("forced approval audit failure"))
        );

        await expect(failing.createWithAudit(input, "service")).rejects.toThrow(
          "forced approval audit failure"
        );

        const approvalRows = await migratorDatabase
          .select({ id: approvalRecord.id })
          .from(approvalRecord)
          .where(eq(approvalRecord.snapshotId, snapshot.id));
        const auditRows = await migratorDatabase
          .select({ id: auditEvent.id })
          .from(auditEvent)
          .where(
            and(
              eq(auditEvent.action, "approve_snapshot"),
              eq(auditEvent.actorId, actorId),
              eq(auditEvent.scopeId, scopeId)
            )
          );
        expect(approvalRows).toHaveLength(0);
        expect(auditRows).toHaveLength(0);

        const retry = await new PostgresApprovalStore(database).createWithAudit(
          input,
          "service"
        );
        expect(retry.ok).toBe(true);
        if (retry.ok) {
          expect(retry.created).toBe(true);
        }
      } finally {
        await applicationClient.end({ timeout: 5 });
        await cleanup(scopeId, fixture);
      }
    });

    it("deduplicates concurrent exact approval retries and rejects divergent retries", async () => {
      const fixture = await seedAanvraag();
      const scopeId = `approval-idempotency-${crypto.randomUUID()}`;
      const actorId = `approval-agent-${crypto.randomUUID()}`;
      const applicationClient = postgres(applicationUrl, { max: 6 });
      try {
        const database = drizzle(applicationClient, { schema });
        const snapshot = await createSnapshot(database, scopeId, [
          fixture.aanvraagId,
        ]);
        const input = {
          actorId,
          expiresAt: new Date("2030-09-30T00:00:00.000Z"),
          motivatie: "Exact idempotent approval",
          resultIds: [...snapshot.resultIds],
          scopeId,
          snapshotId: snapshot.id,
        };
        const approvals = new PostgresApprovalStore(database);
        const results = await Promise.all(
          Array.from({ length: 4 }, () =>
            approvals.createWithAudit(input, "agent")
          )
        );
        expect(results.every((result) => result.ok)).toBe(true);
        const successful = results.flatMap((result) =>
          result.ok ? [result] : []
        );
        expect(successful).toHaveLength(4);
        expect(successful.filter((result) => result.created)).toHaveLength(1);
        expect(
          new Set(successful.map((result) => result.approval.id)).size
        ).toBe(1);
        expect(
          new Set(successful.map((result) => result.auditEvent.id)).size
        ).toBe(1);
        const [firstSuccessful] = successful;
        if (!firstSuccessful) {
          throw new Error("Expected an idempotent approval result");
        }

        const rawApprovals = await migratorDatabase
          .select({ id: approvalRecord.id, scopeId: approvalRecord.scopeId })
          .from(approvalRecord)
          .where(eq(approvalRecord.snapshotId, snapshot.id));
        const rawAudits = await migratorDatabase
          .select({
            actorType: auditEvent.actorType,
            auditClass: auditEvent.auditClass,
            id: auditEvent.id,
            scopeId: auditEvent.scopeId,
          })
          .from(auditEvent)
          .where(
            and(
              eq(auditEvent.action, "approve_snapshot"),
              eq(auditEvent.actorId, actorId),
              eq(auditEvent.scopeId, scopeId)
            )
          );
        expect(rawApprovals).toHaveLength(1);
        expect(rawApprovals[0]?.scopeId).toBe(scopeId);
        expect(rawAudits).toEqual([
          {
            actorType: "agent",
            auditClass: "effect",
            id: firstSuccessful.auditEvent.id,
            scopeId,
          },
        ]);

        const conflict = await approvals.createWithAudit(
          { ...input, motivatie: "Different retry payload" },
          "agent"
        );
        expect(conflict).toEqual({
          ok: false,
          reason: "snapshot_already_approved",
        });
        const actorTypeConflict = await approvals.createWithAudit(
          input,
          "service"
        );
        expect(actorTypeConflict).toEqual({
          ok: false,
          reason: "snapshot_already_approved",
        });
      } finally {
        await applicationClient.end({ timeout: 5 });
        await cleanup(scopeId, fixture);
      }
    });

    it("serializes concurrent markering revisions with monotone timestamps", async () => {
      const fixture = await seedAanvraag();
      const scopeId = `markering-concurrency-${crypto.randomUUID()}`;
      const actorId = `markering-user-${crypto.randomUUID()}`;
      const applicationClient = postgres(applicationUrl, { max: 8 });
      try {
        const database = drizzle(applicationClient, { schema });
        const markeringen = new PostgresMarkeringStore(database);
        const initial = await markeringen.setWithAudit(
          {
            aanvraagId: fixture.aanvraagId,
            reden: "initial",
            scopeId,
            status: "relevant",
            userId: actorId,
          },
          "user"
        );
        const updates = await Promise.all(
          Array.from({ length: 6 }, (_, index) =>
            markeringen.setWithAudit(
              {
                aanvraagId: fixture.aanvraagId,
                reden: `concurrent-${index}`,
                scopeId,
                status: index % 2 === 0 ? "gevolgd" : "niet_relevant",
                userId: actorId,
              },
              "user"
            )
          )
        );
        const ordered = updates
          .map((result) => result.markering)
          .toSorted((left, right) => left.revision - right.revision);

        expect(initial.markering.revision).toBe(1);
        expect(ordered.map((record) => record.revision)).toEqual([
          2, 3, 4, 5, 6, 7,
        ]);
        for (const [index, record] of ordered.entries()) {
          const previous = index === 0 ? initial.markering : ordered[index - 1];
          expect(previous).toBeDefined();
          if (previous) {
            expect(record.updatedAt.getTime()).toBeGreaterThan(
              previous.updatedAt.getTime()
            );
          }
        }

        const finalRecord = await markeringen.get(
          fixture.aanvraagId,
          actorId,
          scopeId
        );
        expect(finalRecord?.revision).toBe(7);
        expect(finalRecord?.updatedAt.getTime()).toBe(
          ordered.at(-1)?.updatedAt.getTime()
        );

        const rawAudits = await migratorDatabase
          .select({
            actorType: auditEvent.actorType,
            auditClass: auditEvent.auditClass,
            scopeId: auditEvent.scopeId,
          })
          .from(auditEvent)
          .where(
            and(
              eq(auditEvent.action, "markeer_aanvraag"),
              eq(auditEvent.actorId, actorId),
              eq(auditEvent.scopeId, scopeId)
            )
          );
        expect(rawAudits).toHaveLength(7);
        expect(
          rawAudits.every(
            (event) =>
              event.actorType === "user" &&
              event.auditClass === "effect" &&
              event.scopeId === scopeId
          )
        ).toBe(true);
      } finally {
        await applicationClient.end({ timeout: 5 });
        await cleanup(scopeId, fixture);
      }
    });
  });
