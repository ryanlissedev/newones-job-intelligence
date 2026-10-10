import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { EnrichmentProposal } from "@ji/application/enrichment";
import { CLEARED } from "@ji/domain";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  aanvraagUpdatedAtToken,
  PostgresEnrichmentStore,
} from "./enrichment-store";
import type { EnrichmentDatabase } from "./enrichment-store";
import * as schema from "./schema";
import {
  aanvraag,
  aanvraagEnrichment,
  bron,
  outboxEvent,
  scrapeRun,
} from "./schema";

const testDatabaseUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
const applicationUrl =
  process.env.DATABASE_APP_TEST_URL ??
  "postgresql://ji_app:ji_app_local@127.0.0.1:5432/ji_test";
const databaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;

const NOW = new Date("2026-09-20T10:00:00Z");

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

const locatieProposal: EnrichmentProposal = {
  confidence: 0.95,
  field: "locatie",
  rawRefs: [
    { excerpt: "Standplaats: Utrecht", field: "locatie", sourcePath: "body" },
  ],
  source: "deterministic",
  value: { locatieTekst: "Utrecht" },
};

const urenProposal: EnrichmentProposal = {
  confidence: 0.95,
  field: "uren",
  rawRefs: [{ excerpt: "36 uur per week", field: "uren", sourcePath: "body" }],
  source: "deterministic",
  value: { urenPerWeek: "36" },
};

/**
 * CTP-626: one enrichment lands exactly once and never over a newer row
 * state or a manual clear. Runs on the least-privilege `ji_app` role like
 * the worker does.
 */
describe("PostgresEnrichmentStore.applyEnrichmentAtomically", () => {
  let available = false;
  let client: ReturnType<typeof postgres> | null = null;
  let database: EnrichmentDatabase | null = null;
  let store: PostgresEnrichmentStore | null = null;
  const bronId = crypto.randomUUID();
  const runId = crypto.randomUUID();

  beforeAll(async () => {
    available = await isPostgresAvailable();
    if (!available) {
      if (databaseRequired) {
        throw new Error("Required test database is unavailable");
      }
      return;
    }
    client = postgres(applicationUrl, { max: 2 });
    database = drizzle(client, { schema });
    store = new PostgresEnrichmentStore(database);
    await database.insert(bron).values({
      categorie: "runtime-test",
      id: bronId,
      naam: `Enrichment ${bronId.slice(0, 8)}`,
    });
    await database.insert(scrapeRun).values({ bronId, id: runId });
  });

  afterAll(async () => {
    if (database) {
      await database.delete(aanvraag).where(eq(aanvraag.bronId, bronId));
      await database.delete(scrapeRun).where(eq(scrapeRun.id, runId));
      await database.delete(bron).where(eq(bron.id, bronId));
    }
    await client?.end({ timeout: 5 });
  });

  const seedIncomplete = async (): Promise<{
    id: string;
    updatedAt: Date;
    updatedAtToken: string;
  }> => {
    if (!database) {
      throw new Error("Postgres fixture is unavailable");
    }
    const id = crypto.randomUUID();
    const [row] = await database
      .insert(aanvraag)
      .values({
        beschrijving: "Interim adviseur, standplaats Utrecht, 36 uur per week.",
        bronId,
        bronReferentie: `ref-${id}`,
        contentHash: `hash-${id}`,
        eersteGezienOp: NOW,
        extractieMethode: "html_parser",
        id,
        laatstGezienOp: NOW,
        locatieTekst: "unknown",
        rawPayloadRef: `raw/enrichment/${id}.html`,
        scrapeRunId: runId,
        status: "active",
        titel: "Interim adviseur",
        versie: 1,
      })
      .returning({
        updatedAt: aanvraag.updatedAt,
        updatedAtToken: aanvraagUpdatedAtToken,
      });
    if (!row) {
      throw new Error("aanvraag insert returned no row");
    }
    return { id, updatedAt: row.updatedAt, updatedAtToken: row.updatedAtToken };
  };

  const state = async (id: string) => {
    if (!database) {
      throw new Error("Postgres fixture is unavailable");
    }
    const [row] = await database
      .select({
        locatieTekst: aanvraag.locatieTekst,
        updatedAt: aanvraag.updatedAt,
        urenPerWeek: aanvraag.urenPerWeek,
      })
      .from(aanvraag)
      .where(eq(aanvraag.id, id));
    const enrichmentRows = await database
      .select({ field: aanvraagEnrichment.field })
      .from(aanvraagEnrichment)
      .where(eq(aanvraagEnrichment.aanvraagId, id));
    const outboxRows = await database
      .select({ payload: outboxEvent.payload })
      .from(outboxEvent)
      .where(
        and(
          eq(outboxEvent.aggregateId, id),
          eq(outboxEvent.eventType, "aanvraag.enriched")
        )
      );
    return { enrichmentRows, outboxRows, row };
  };

  it("applies proposals, curated patch and one outbox event in one commit, then treats a replay as stale", async () => {
    if (!available || !store) {
      expect(available).toBe(false);
      return;
    }
    const seeded = await seedIncomplete();

    const applied = await store.applyEnrichmentAtomically({
      aanvraagId: seeded.id,
      expectedUpdatedAt: seeded.updatedAtToken,
      proposals: [locatieProposal],
    });
    expect(applied.outcome).toBe("applied");
    if (applied.outcome !== "applied") {
      return;
    }
    expect(applied.fields).toEqual(["locatie"]);
    const after = await state(seeded.id);
    expect(after.row?.locatieTekst).toBe("Utrecht");
    expect(after.row?.updatedAt.getTime()).not.toBe(seeded.updatedAt.getTime());
    expect(after.enrichmentRows).toEqual([{ field: "locatie" }]);
    expect(after.outboxRows).toEqual([
      { payload: { field_count: 1, fields: ["locatie"] } },
    ]);

    // Kill after commit, before ack: the replayed job carries the old token.
    const replay = await store.applyEnrichmentAtomically({
      aanvraagId: seeded.id,
      expectedUpdatedAt: seeded.updatedAtToken,
      proposals: [locatieProposal],
    });
    expect(replay).toEqual({ outcome: "stale" });
    const afterReplay = await state(seeded.id);
    expect(afterReplay.enrichmentRows).toHaveLength(1);
    expect(afterReplay.outboxRows).toHaveLength(1);
    expect(afterReplay.row?.updatedAt.getTime()).toBe(
      after.row?.updatedAt.getTime()
    );
  });

  it("lets a concurrent user edit win: stale, no writes", async () => {
    if (!available || !store || !database) {
      expect(available).toBe(false);
      return;
    }
    const seeded = await seedIncomplete();
    await database
      .update(aanvraag)
      .set({ titel: "Interim adviseur (aangepast)" })
      .where(eq(aanvraag.id, seeded.id));

    const outcome = await store.applyEnrichmentAtomically({
      aanvraagId: seeded.id,
      expectedUpdatedAt: seeded.updatedAtToken,
      proposals: [locatieProposal],
    });
    expect(outcome).toEqual({ outcome: "stale" });
    const after = await state(seeded.id);
    expect(after.row?.locatieTekst).toBe("unknown");
    expect(after.enrichmentRows).toEqual([]);
    expect(after.outboxRows).toEqual([]);
  });

  it("stays stale when the concurrent edit lands inside the same millisecond", async () => {
    if (!available || !store || !database) {
      expect(available).toBe(false);
      return;
    }
    const seeded = await seedIncomplete();
    // Same millisecond, different microsecond: a Date-based guard would still match.
    const seededMicros = Number(seeded.updatedAtToken.slice(-4, -1));
    const shiftedMicros = seededMicros === 1 ? 2 : 1;
    await database.execute(
      sql`UPDATE ${aanvraag} SET ${sql.identifier("titel")} = ${"Interim adviseur (aangepast)"}, ${sql.identifier("updated_at")} = date_trunc('milliseconds', ${aanvraag.updatedAt}) + ${shiftedMicros}::int * interval '1 microsecond' WHERE ${aanvraag.id} = ${seeded.id}`
    );

    const outcome = await store.applyEnrichmentAtomically({
      aanvraagId: seeded.id,
      expectedUpdatedAt: seeded.updatedAtToken,
      proposals: [locatieProposal],
    });
    expect(outcome).toEqual({ outcome: "stale" });
    const after = await state(seeded.id);
    expect(after.row?.updatedAt.getTime()).toBe(seeded.updatedAt.getTime());
    expect(after.row?.locatieTekst).toBe("unknown");
    expect(after.enrichmentRows).toEqual([]);
    expect(after.outboxRows).toEqual([]);
  });

  it("lets a manual clear win: nothing_to_fill, value stays CLEARED", async () => {
    if (!available || !store || !database) {
      expect(available).toBe(false);
      return;
    }
    const seeded = await seedIncomplete();
    const [cleared] = await database
      .update(aanvraag)
      .set({ locatieTekst: CLEARED })
      .where(eq(aanvraag.id, seeded.id))
      .returning({ updatedAtToken: aanvraagUpdatedAtToken });
    if (!cleared) {
      throw new Error("clear returned no row");
    }

    const outcome = await store.applyEnrichmentAtomically({
      aanvraagId: seeded.id,
      expectedUpdatedAt: cleared.updatedAtToken,
      proposals: [locatieProposal],
    });
    expect(outcome).toEqual({ outcome: "nothing_to_fill" });
    const after = await state(seeded.id);
    expect(after.row?.locatieTekst).toBe(CLEARED);
    expect(after.enrichmentRows).toEqual([]);
    expect(after.outboxRows).toEqual([]);
  });

  it("applies only the fields that are still gaps when one is cleared", async () => {
    if (!available || !store || !database) {
      expect(available).toBe(false);
      return;
    }
    const seeded = await seedIncomplete();
    const [cleared] = await database
      .update(aanvraag)
      .set({ locatieTekst: CLEARED })
      .where(eq(aanvraag.id, seeded.id))
      .returning({ updatedAtToken: aanvraagUpdatedAtToken });
    if (!cleared) {
      throw new Error("clear returned no row");
    }

    const outcome = await store.applyEnrichmentAtomically({
      aanvraagId: seeded.id,
      expectedUpdatedAt: cleared.updatedAtToken,
      proposals: [locatieProposal, urenProposal],
    });
    expect(outcome.outcome).toBe("applied");
    if (outcome.outcome !== "applied") {
      return;
    }
    expect(outcome.fields).toEqual(["uren"]);
    const after = await state(seeded.id);
    expect(after.row?.locatieTekst).toBe(CLEARED);
    expect(after.row?.urenPerWeek).toBe("36");
    expect(after.outboxRows).toEqual([
      { payload: { field_count: 1, fields: ["uren"] } },
    ]);
  });

  it("lists a single candidate by id and null once it is complete", async () => {
    if (!available || !store) {
      expect(available).toBe(false);
      return;
    }
    const seeded = await seedIncomplete();
    const candidate = await store.listIncompleteById(seeded.id);
    expect(candidate?.id).toBe(seeded.id);
    expect(candidate?.updatedAt.getTime()).toBe(seeded.updatedAt.getTime());
    expect(candidate?.updatedAtToken).toBe(seeded.updatedAtToken);
    expect(candidate?.missingFields).toContain("locatie");
    expect(await store.listIncompleteById(crypto.randomUUID())).toBeNull();
  });
});
