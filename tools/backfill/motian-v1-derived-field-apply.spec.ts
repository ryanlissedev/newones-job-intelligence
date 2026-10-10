import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";

import {
  hashContent,
  buildContentAddressedRawObjectPath,
} from "@ji/connectors";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import * as schema from "../../packages/db/src/schema";
import { PostgresAuditStore } from "../../packages/db/src/user-write-stores";
import {
  MOTIAN_REPAIR_ACTOR_ID,
  MOTIAN_REPAIR_APPLY_ACTION,
  MOTIAN_REPAIR_EVENT_TYPE,
  MOTIAN_REPAIR_ROLLBACK_ACTION,
  applyMotianV1DerivedFieldRepair,
  rollbackMotianV1DerivedFieldRepair,
} from "./motian-v1-derived-field-apply";
import type {
  CurrentMotianDerivedFieldRow,
  MotianDerivedFieldRepairManifestEntry,
} from "./motian-v1-derived-field-repair";

const migratorUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
const applicationUrl =
  process.env.DATABASE_APP_TEST_URL ??
  "postgresql://ji_app:ji_app_local@127.0.0.1:5432/ji_test";
const databaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;
const migrationsFolder = path.join(
  import.meta.dir,
  "../../packages/db/src/migrations"
);
const BRON_ID = "00000000-0000-4000-8000-000000000030";
const NOW = new Date("2026-09-10T00:00:00.000Z");

interface MotianRawFixture {
  readonly application_deadline: string | null;
  readonly competences: readonly { readonly name: string }[] | null;
  readonly education_level: string | null;
  readonly archived_at: null;
  readonly company: string | null;
  readonly contract_type: string | null;
  readonly deleted_at: null;
  readonly description: null;
  readonly end_client: null;
  readonly external_id: string;
  readonly external_url: null;
  readonly id: string;
  readonly location: null;
  readonly platform: "nationalevacaturebank";
  readonly posted_at: string | null;
  readonly province: string | null;
  readonly rate_max: null;
  readonly rate_min: null;
  readonly scraped_at: null;
  readonly start_date: string | null;
  readonly status: null;
  readonly title: "Data engineer";
}

type DerivedFields = Pick<
  CurrentMotianDerivedFieldRow,
  | "contracttype"
  | "opdrachtgeverNaam"
  | "publicatiedatum"
  | "sluitingsdatum"
  | "startDatum"
>;

interface Fixture extends DerivedFields {
  readonly aanvraagId: string;
  readonly bronReferentie: string;
  readonly contentHash: string;
  readonly body: Uint8Array;
  readonly manifest: MotianDerivedFieldRepairManifestEntry;
  readonly rawPayloadRef: string;
  readonly runId: string;
  readonly v1Id: string;
}

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

const rawBody = (input: {
  readonly externalId: string;
  readonly v1Id: string;
  readonly applicationDeadline?: string | null;
  readonly company?: string | null;
  readonly competences?: readonly { readonly name: string }[];
  readonly contractType?: string | null;
  readonly educationLevel?: string;
  readonly postedAt?: string | null;
  readonly province?: string | null;
  readonly startDate?: string | null;
}): Uint8Array => {
  const body: MotianRawFixture = {
    application_deadline: input.applicationDeadline ?? "2026-09-15 09:30:00",
    archived_at: null,
    company: input.company ?? "NVB opdrachtgever",
    competences: input.competences ?? null,
    contract_type: input.contractType ?? "detachering",
    deleted_at: null,
    description: null,
    education_level: input.educationLevel ?? null,
    end_client: null,
    external_id: input.externalId,
    external_url: null,
    id: input.v1Id,
    location: null,
    platform: "nationalevacaturebank",
    posted_at: input.postedAt ?? "2026-09-10 08:10:11",
    province: input.province ?? null,
    rate_max: null,
    rate_min: null,
    scraped_at: null,
    start_date: input.startDate ?? "2026-10-01 00:00:00",
    status: null,
    title: "Data engineer",
  };
  return new TextEncoder().encode(JSON.stringify(body));
};

const rawReader = (fixture: Fixture, onRead?: () => Promise<void>) => {
  let reads = 0;
  return {
    readRawObject: async (rawPayloadRef: string) => {
      reads += 1;
      await onRead?.();
      if (rawPayloadRef !== fixture.rawPayloadRef) {
        return null;
      }
      return { body: fixture.body, contentType: "json" as const };
    },
    reads: () => reads,
  };
};

describe
  .skipIf(!postgresAvailable)
  .serial("Motian v1 derived-field apply and rollback", () => {
    let migratorClient: ReturnType<typeof postgres>;
    let applicationClient: ReturnType<typeof postgres>;
    let auditClient: ReturnType<typeof postgres>;

    beforeAll(async () => {
      migratorClient = postgres(migratorUrl, { max: 1 });
      await migrate(drizzle(migratorClient, { schema }), {
        migrationsFolder,
      });
      applicationClient = postgres(applicationUrl, { max: 2 });
      auditClient = postgres(applicationUrl, { max: 1 });
      await migratorClient`
        INSERT INTO curated.bron (id, naam, categorie, actief, status)
        VALUES (${BRON_ID}, 'Nationale Vacaturebank', 'msp_broker', false, 'blocked')
        ON CONFLICT (id) DO NOTHING
      `;
    });

    afterAll(async () => {
      await applicationClient?.end({ timeout: 5 });
      await auditClient?.end({ timeout: 5 });
      await migratorClient?.end({ timeout: 5 });
    });

    const seedFixture = async (
      input: {
        readonly fields?: Partial<DerivedFields>;
        readonly raw?: {
          readonly competences?: readonly { readonly name: string }[];
          readonly educationLevel?: string;
          readonly province?: string;
        };
        readonly suffix?: string;
      } = {}
    ): Promise<Fixture> => {
      const suffix = input.suffix ?? crypto.randomUUID().replaceAll("-", "");
      const aanvraagId = crypto.randomUUID();
      const runId = crypto.randomUUID();
      const v1Id = `motian-${suffix}`;
      const bronReferentie = `external-${suffix}`;
      const body = rawBody({
        ...input.raw,
        externalId: bronReferentie,
        v1Id,
      });
      const contentHash = await hashContent(body);
      const rawPayloadRef = buildContentAddressedRawObjectPath({
        bronSlug: "nationalevacaturebank",
        contentHash,
        contentType: "json",
        startedAt: NOW,
      });
      const fields: DerivedFields = {
        contracttype: null,
        opdrachtgeverNaam: null,
        publicatiedatum: null,
        sluitingsdatum: null,
        startDatum: null,
        ...input.fields,
      };

      await migratorClient`
        INSERT INTO curated.scrape_run (id, bron_id, status, gestart)
        VALUES (${runId}, ${BRON_ID}, 'running', ${NOW.toISOString()})
      `;
      await migratorClient`
        INSERT INTO curated.aanvraag (
          id,
          beschrijving,
          bron_id,
          bron_referentie,
          content_hash,
          contracttype,
          opdrachtgever_naam,
          publicatiedatum,
          eerste_gezien_op,
          extractie_methode,
          laatst_gezien_op,
          raw_payload_ref,
          scrape_run_id,
          sluitingsdatum,
          start_datum,
          status,
          titel,
          v1_id,
          versie
        ) VALUES (
          ${aanvraagId},
          'Motian repair fixture',
          ${BRON_ID},
          ${bronReferentie},
          ${contentHash},
          ${fields.contracttype},
          ${fields.opdrachtgeverNaam},
          ${fields.publicatiedatum},
          ${NOW.toISOString()},
          'spec',
          ${NOW.toISOString()},
          ${rawPayloadRef},
          ${runId},
          ${fields.sluitingsdatum?.toISOString() ?? null},
          ${fields.startDatum},
          'active',
          'Data engineer',
          ${v1Id},
          7
        )
      `;
      await migratorClient`
        INSERT INTO curated.aanvraag_versie (
          aanvraag_id,
          content_hash,
          raw_payload_ref,
          scrape_run_id,
          snapshot,
          versie
        ) VALUES (
          ${aanvraagId},
          ${contentHash},
          ${rawPayloadRef},
          ${runId},
          ${JSON.stringify({ fixture: "before-repair" })}::text::jsonb,
          7
        )
      `;
      return {
        aanvraagId,
        body,
        bronReferentie,
        contentHash,
        manifest: {
          aanvraagId,
          bronId: BRON_ID,
          bronReferentie,
          contentHash,
          rawPayloadRef,
          v1Id,
        },
        rawPayloadRef,
        runId,
        v1Id,
        ...fields,
      };
    };

    const cleanupFixture = async (fixture: Fixture): Promise<void> => {
      await migratorClient`
        DELETE FROM curated.audit_event WHERE entity_id = ${fixture.aanvraagId}
      `;
      await migratorClient`
        DELETE FROM curated.outbox_event WHERE aggregate_id = ${fixture.aanvraagId}
      `;
      await migratorClient`
        DELETE FROM curated.aanvraag WHERE id = ${fixture.aanvraagId}
      `;
      await migratorClient`
        DELETE FROM curated.scrape_run WHERE id = ${fixture.runId}
      `;
    };

    const readFixtureRow = async (fixture: Fixture) => {
      const rows = await applicationClient<
        {
          aanvraagId: string;
          bronId: string;
          bronReferentie: string;
          contentHash: string;
          rawPayloadRef: string;
          v1Id: string;
          opdrachtgeverNaam: string | null;
          contracttype: string | null;
          publicatiedatum: string | null;
          startDatum: string | null;
          sluitingsdatum: Date | null;
          versie: number;
        }[]
      >`
        SELECT
          id::text AS "aanvraagId",
          bron_id::text AS "bronId",
          bron_referentie AS "bronReferentie",
          content_hash AS "contentHash",
          raw_payload_ref AS "rawPayloadRef",
          v1_id AS "v1Id",
          opdrachtgever_naam AS "opdrachtgeverNaam",
          contracttype,
          publicatiedatum,
          start_datum AS "startDatum",
          sluitingsdatum,
          versie
        FROM curated.aanvraag
        WHERE id = ${fixture.aanvraagId}
      `;
      const [row] = rows;
      if (!row) {
        throw new Error("Fixture row was not found");
      }
      return row;
    };

    const installOutboxFailure = async (
      aanvraagId: string
    ): Promise<() => Promise<void>> => {
      const token = crypto.randomUUID().replaceAll("-", "");
      const functionName = `motian_fail_${token}`;
      const triggerName = `${functionName}_trigger`;
      await migratorClient.unsafe(`
        CREATE FUNCTION ${functionName}() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'forced Motian outbox failure';
        END;
        $$
      `);
      await migratorClient.unsafe(`
        CREATE TRIGGER ${triggerName}
        BEFORE INSERT ON curated.outbox_event
        FOR EACH ROW
        WHEN (NEW.aggregate_id = '${aanvraagId}'::uuid)
        EXECUTE FUNCTION ${functionName}()
      `);
      return async () => {
        await migratorClient.unsafe(
          `DROP TRIGGER IF EXISTS ${triggerName} ON curated.outbox_event`
        );
        await migratorClient.unsafe(
          `DROP FUNCTION IF EXISTS ${functionName}()`
        );
      };
    };

    it("persists opleidingsniveau, provincie, and skills together in one bron_specifiek update", async () => {
      const fixture = await seedFixture({
        raw: {
          competences: [{ name: "SQL" }, { name: "Python" }],
          educationLevel: "HBO",
          province: "Utrecht",
        },
      });
      try {
        const reader = rawReader(fixture);
        const result = await applyMotianV1DerivedFieldRepair({
          database: applicationClient,
          manifest: fixture.manifest,
          manifestSha256: "b".repeat(64),
          readRawObject: reader.readRawObject,
        });

        expect(result.status).toBe("applied");
        expect(result.changedFields).toEqual(
          expect.arrayContaining(["opleidingsniveau", "provincie", "skills"])
        );

        const rows = await applicationClient<{ bronSpecifiek: unknown }[]>`
          SELECT bron_specifiek AS "bronSpecifiek"
          FROM curated.aanvraag
          WHERE id = ${fixture.aanvraagId}
        `;
        expect(rows[0]?.bronSpecifiek).toMatchObject({
          opleidingsniveau: "HBO",
          provincie: "Utrecht",
          skills: ["SQL", "Python"],
        });

        const rollback = await rollbackMotianV1DerivedFieldRepair({
          auditId: result.auditId ?? "",
          database: applicationClient,
        });
        expect(rollback.status).toBe("rolled_back");
        const restored = await applicationClient<{ bronSpecifiek: unknown }[]>`
          SELECT bron_specifiek AS "bronSpecifiek"
          FROM curated.aanvraag
          WHERE id = ${fixture.aanvraagId}
        `;
        expect(restored[0]?.bronSpecifiek).not.toMatchObject({
          opleidingsniveau: "HBO",
        });
        expect(restored[0]?.bronSpecifiek).not.toMatchObject({
          provincie: "Utrecht",
        });
        expect(restored[0]?.bronSpecifiek).not.toMatchObject({
          skills: ["SQL", "Python"],
        });
      } finally {
        await cleanupFixture(fixture);
      }
    });

    it("updates null derived fields atomically and preserves version, raw identity, and history", async () => {
      const fixture = await seedFixture({
        fields: { contracttype: "existing contract" },
      });
      try {
        const before = await readFixtureRow(fixture);
        const reader = rawReader(fixture);
        const result = await applyMotianV1DerivedFieldRepair({
          database: applicationClient,
          manifest: fixture.manifest,
          manifestSha256: "a".repeat(64),
          readRawObject: reader.readRawObject,
        });

        expect(result).toMatchObject({
          changedFields: [
            "opdrachtgeverNaam",
            "publicatiedatum",
            "startDatum",
            "sluitingsdatum",
          ],
          status: "applied",
          v1Id: fixture.v1Id,
        });
        expect(reader.reads()).toBe(1);

        const after = await readFixtureRow(fixture);
        expect(after).toMatchObject({
          aanvraagId: before.aanvraagId,
          bronId: before.bronId,
          bronReferentie: before.bronReferentie,
          contentHash: before.contentHash,
          contracttype: "existing contract",
          opdrachtgeverNaam: "NVB opdrachtgever",
          publicatiedatum: "2026-09-10T08:10:11.000Z",
          rawPayloadRef: before.rawPayloadRef,
          startDatum: "2026-10-01",
          versie: before.versie,
        });
        expect(after.sluitingsdatum?.toISOString()).toBe(
          "2026-09-15T09:30:00.000Z"
        );
        const history = await applicationClient<
          {
            contentHash: string;
            rawPayloadRef: string;
            snapshot: unknown;
            versie: number;
          }[]
        >`
          SELECT
            content_hash AS "contentHash",
            raw_payload_ref AS "rawPayloadRef",
            snapshot,
            versie
          FROM curated.aanvraag_versie
          WHERE aanvraag_id = ${fixture.aanvraagId}
        `;
        expect(
          history.map(({ contentHash, rawPayloadRef, snapshot, versie }) => ({
            contentHash,
            rawPayloadRef,
            snapshot,
            versie,
          }))
        ).toEqual([
          {
            contentHash: before.contentHash,
            rawPayloadRef: before.rawPayloadRef,
            snapshot: { fixture: "before-repair" },
            versie: before.versie,
          },
        ]);

        const auditRows = await applicationClient<
          { action: string; metadata: unknown }[]
        >`
          SELECT action, metadata
          FROM curated.audit_event
          WHERE id = ${result.auditId ?? ""}
        `;
        expect(auditRows).toHaveLength(1);
        expect(auditRows[0]).toMatchObject({
          action: MOTIAN_REPAIR_APPLY_ACTION,
        });
        expect(auditRows[0]?.metadata).toMatchObject({
          afterimage: expect.objectContaining({
            contracttype: "existing contract",
            opdrachtgeverNaam: "NVB opdrachtgever",
          }),
          preimage: expect.objectContaining({
            contracttype: "existing contract",
            opdrachtgeverNaam: null,
          }),
        });
        const auditStore = new PostgresAuditStore(
          drizzle(auditClient, { schema })
        );
        const decodedAudits = await auditStore.listByActorId(
          MOTIAN_REPAIR_ACTOR_ID,
          "catapulze"
        );
        expect(decodedAudits.some((audit) => audit.id === result.auditId)).toBe(
          true
        );
        const outboxRows = await applicationClient<
          { eventType: string; payload: unknown }[]
        >`
          SELECT event_type AS "eventType", payload
          FROM curated.outbox_event
          WHERE aggregate_id = ${fixture.aanvraagId}
        `;
        expect(
          outboxRows.map(({ eventType, payload }) => ({ eventType, payload }))
        ).toEqual([
          {
            eventType: MOTIAN_REPAIR_EVENT_TYPE,
            payload: {
              content_hash: fixture.contentHash,
              parser_version: "motian-v1-derived-field-repair/v3",
            },
          },
        ]);
      } finally {
        await cleanupFixture(fixture);
      }
    });

    it("rejects each manifest binding mismatch before reading raw storage", async () => {
      const fixture = await seedFixture();
      try {
        const mismatches: {
          readonly manifest: MotianDerivedFieldRepairManifestEntry;
          readonly reason: "current_row_missing" | "current_row_mismatch";
        }[] = [
          {
            manifest: { ...fixture.manifest, aanvraagId: crypto.randomUUID() },
            reason: "current_row_missing",
          },
          {
            manifest: { ...fixture.manifest, bronId: crypto.randomUUID() },
            reason: "current_row_mismatch",
          },
          {
            manifest: {
              ...fixture.manifest,
              bronReferentie: "another-reference",
            },
            reason: "current_row_mismatch",
          },
          {
            manifest: { ...fixture.manifest, contentHash: "b".repeat(64) },
            reason: "current_row_mismatch",
          },
          {
            manifest: {
              ...fixture.manifest,
              rawPayloadRef: "raw/nationalevacaturebank/changed.json",
            },
            reason: "current_row_mismatch",
          },
          {
            manifest: { ...fixture.manifest, v1Id: "another-v1-id" },
            reason: "current_row_mismatch",
          },
        ];
        await Promise.all(
          mismatches.map(async (mismatch) => {
            let reads = 0;
            const result = await applyMotianV1DerivedFieldRepair({
              database: applicationClient,
              manifest: mismatch.manifest,
              manifestSha256: "c".repeat(64),
              readRawObject: () => {
                reads += 1;
                return Promise.resolve({
                  body: fixture.body,
                  contentType: "json",
                });
              },
            });
            expect(result).toEqual({
              reason: mismatch.reason,
              status: "rejected",
              v1Id: mismatch.manifest.v1Id,
            });
            expect(reads).toBe(0);
          })
        );
      } finally {
        await cleanupFixture(fixture);
      }
    });

    it("rechecks all manifest bindings after the raw read and before the row lock", async () => {
      const fixture = await seedFixture();
      try {
        let mutationDone = false;
        const reader = rawReader(fixture, async () => {
          if (!mutationDone) {
            mutationDone = true;
            await migratorClient`
              UPDATE curated.aanvraag
              SET content_hash = ${"d".repeat(64)}
              WHERE id = ${fixture.aanvraagId}
            `;
          }
        });
        const result = await applyMotianV1DerivedFieldRepair({
          database: applicationClient,
          manifest: fixture.manifest,
          manifestSha256: "e".repeat(64),
          readRawObject: reader.readRawObject,
        });
        expect(result).toEqual({
          reason: "current_row_mismatch",
          status: "rejected",
          v1Id: fixture.v1Id,
        });
        expect(await readFixtureRow(fixture)).toMatchObject({
          contentHash: "d".repeat(64),
          contracttype: null,
          opdrachtgeverNaam: null,
        });
      } finally {
        await cleanupFixture(fixture);
      }
    });

    it("rolls back the row and audit when the outbox insert fails", async () => {
      const fixture = await seedFixture();
      const removeFailure = await installOutboxFailure(fixture.aanvraagId);
      try {
        const result = await applyMotianV1DerivedFieldRepair({
          database: applicationClient,
          manifest: fixture.manifest,
          manifestSha256: "f".repeat(64),
          readRawObject: () =>
            Promise.resolve({
              body: fixture.body,
              contentType: "json",
            }),
        });
        expect(result).toEqual({
          reason: "transaction_failed",
          status: "rejected",
          v1Id: fixture.v1Id,
        });
        expect(await readFixtureRow(fixture)).toMatchObject({
          contracttype: null,
          opdrachtgeverNaam: null,
          publicatiedatum: null,
          sluitingsdatum: null,
          startDatum: null,
        });
        const audits = await applicationClient`
          SELECT id FROM curated.audit_event WHERE entity_id = ${fixture.aanvraagId}
        `;
        const events = await applicationClient`
          SELECT id FROM curated.outbox_event WHERE aggregate_id = ${fixture.aanvraagId}
        `;
        expect(audits).toHaveLength(0);
        expect(events).toHaveLength(0);
      } finally {
        await removeFailure();
        await cleanupFixture(fixture);
      }
    });

    it("isolates a failed candidate from another candidate and makes apply repeat-safe", async () => {
      const failedFixture = await seedFixture();
      const goodFixture = await seedFixture();
      const removeFailure = await installOutboxFailure(
        failedFixture.aanvraagId
      );
      try {
        const [failed, applied] = await Promise.all([
          applyMotianV1DerivedFieldRepair({
            database: applicationClient,
            manifest: failedFixture.manifest,
            manifestSha256: "1".repeat(64),
            readRawObject: () =>
              Promise.resolve({
                body: failedFixture.body,
                contentType: "json",
              }),
          }),
          applyMotianV1DerivedFieldRepair({
            database: applicationClient,
            manifest: goodFixture.manifest,
            manifestSha256: "2".repeat(64),
            readRawObject: () =>
              Promise.resolve({
                body: goodFixture.body,
                contentType: "json",
              }),
          }),
        ]);
        expect(failed).toMatchObject({
          reason: "transaction_failed",
          status: "rejected",
        });
        expect(applied.status).toBe("applied");
        const repeated = await applyMotianV1DerivedFieldRepair({
          database: applicationClient,
          manifest: goodFixture.manifest,
          manifestSha256: "2".repeat(64),
          readRawObject: () =>
            Promise.resolve({
              body: goodFixture.body,
              contentType: "json",
            }),
        });
        expect(repeated).toEqual({
          auditId: applied.auditId,
          status: "unchanged",
          v1Id: goodFixture.v1Id,
        });
        const goodAudits = await applicationClient`
          SELECT id FROM curated.audit_event WHERE entity_id = ${goodFixture.aanvraagId}
        `;
        const goodEvents = await applicationClient`
          SELECT id FROM curated.outbox_event WHERE aggregate_id = ${goodFixture.aanvraagId}
        `;
        expect(goodAudits).toHaveLength(1);
        expect(goodEvents).toHaveLength(1);
      } finally {
        await removeFailure();
        await cleanupFixture(failedFixture);
        await cleanupFixture(goodFixture);
      }
    });

    it("rolls back only fields that still equal the recorded after-image and is idempotent", async () => {
      const fixture = await seedFixture();
      try {
        const applied = await applyMotianV1DerivedFieldRepair({
          database: applicationClient,
          manifest: fixture.manifest,
          manifestSha256: "3".repeat(64),
          readRawObject: () =>
            Promise.resolve({
              body: fixture.body,
              contentType: "json",
            }),
        });
        if (!applied.auditId) {
          throw new Error("Expected an apply audit id");
        }
        await migratorClient`
          UPDATE curated.aanvraag
          SET contracttype = 'later edit'
          WHERE id = ${fixture.aanvraagId}
        `;
        const rolledBack = await rollbackMotianV1DerivedFieldRepair({
          auditId: applied.auditId,
          database: applicationClient,
        });
        expect(rolledBack).toMatchObject({
          restoredFields: [
            "opdrachtgeverNaam",
            "publicatiedatum",
            "startDatum",
            "sluitingsdatum",
          ],
          skippedFields: ["contracttype"],
          status: "rolled_back",
        });
        expect(await readFixtureRow(fixture)).toMatchObject({
          contracttype: "later edit",
          opdrachtgeverNaam: null,
          publicatiedatum: null,
          sluitingsdatum: null,
          startDatum: null,
        });
        const repeated = await rollbackMotianV1DerivedFieldRepair({
          auditId: applied.auditId,
          database: applicationClient,
        });
        expect(repeated).toEqual({
          auditId: rolledBack.auditId,
          status: "unchanged",
        });
        const audits = await applicationClient<
          { action: string; metadata: unknown }[]
        >`
          SELECT action, metadata
          FROM curated.audit_event
          WHERE entity_id = ${fixture.aanvraagId}
          ORDER BY created_at, id
        `;
        expect(audits.map((audit) => audit.action)).toEqual([
          MOTIAN_REPAIR_APPLY_ACTION,
          MOTIAN_REPAIR_ROLLBACK_ACTION,
        ]);
        expect(audits[1]?.metadata).toMatchObject({
          changedFields: [
            "opdrachtgeverNaam",
            "publicatiedatum",
            "startDatum",
            "sluitingsdatum",
          ],
          rollbackOfAuditId: applied.auditId,
        });
      } finally {
        await cleanupFixture(fixture);
      }
    });

    it("rolls back atomically when rollback outbox insertion fails", async () => {
      const fixture = await seedFixture();
      try {
        const applied = await applyMotianV1DerivedFieldRepair({
          database: applicationClient,
          manifest: fixture.manifest,
          manifestSha256: "4".repeat(64),
          readRawObject: () =>
            Promise.resolve({
              body: fixture.body,
              contentType: "json",
            }),
        });
        if (!applied.auditId) {
          throw new Error("Expected an apply audit id");
        }
        const removeFailure = await installOutboxFailure(fixture.aanvraagId);
        try {
          const result = await rollbackMotianV1DerivedFieldRepair({
            auditId: applied.auditId,
            database: applicationClient,
          });
          expect(result).toEqual({
            reason: "rollback_transaction_failed",
            status: "rejected",
          });
          expect(await readFixtureRow(fixture)).toMatchObject({
            contracttype: "detachering",
            opdrachtgeverNaam: "NVB opdrachtgever",
            publicatiedatum: "2026-09-10T08:10:11.000Z",
            startDatum: "2026-10-01",
          });
          const audits = await applicationClient`
            SELECT id FROM curated.audit_event WHERE entity_id = ${fixture.aanvraagId}
          `;
          const events = await applicationClient`
            SELECT id FROM curated.outbox_event WHERE aggregate_id = ${fixture.aanvraagId}
          `;
          expect(audits).toHaveLength(1);
          expect(events).toHaveLength(1);
        } finally {
          await removeFailure();
        }
      } finally {
        await cleanupFixture(fixture);
      }
    });

    it("rejects malformed Motian audit metadata through the actual Postgres audit read path", async () => {
      const entityId = crypto.randomUUID();
      const actorScope = `motian-audit-decoder-${crypto.randomUUID()}`;
      try {
        await migratorClient`
          INSERT INTO curated.audit_event (
            action,
            actor_id,
            actor_type,
            audit_class,
            entity_id,
            entity_type,
            metadata,
            scope_id
          ) VALUES (
            ${MOTIAN_REPAIR_APPLY_ACTION},
            ${MOTIAN_REPAIR_ACTOR_ID},
            'service',
            'effect',
            ${entityId},
            'aanvraag',
            ${JSON.stringify({
              aanvraagId: entityId,
              repairVersion: "motian-v1-derived-field-repair/v3",
            })}::text::jsonb,
            ${actorScope}
          )
        `;
        const auditStore = new PostgresAuditStore(
          drizzle(auditClient, { schema })
        );
        await expect(
          auditStore.listByActorId(MOTIAN_REPAIR_ACTOR_ID, actorScope)
        ).rejects.toThrow();
      } finally {
        await migratorClient`
          DELETE FROM curated.audit_event WHERE entity_id = ${entityId}
        `;
      }
    });
  });
