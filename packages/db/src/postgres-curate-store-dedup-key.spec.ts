import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";

import type { StoredDedupGroep } from "@ji/application/identity";
import { curateObservation } from "@ji/application/identity";
import type { NormalisedAanvraagDraft } from "@ji/application/normalise";
import { buildDedupKey } from "@ji/application/normalise";
import type { BronId, ScrapeRunId } from "@ji/domain";
import { UNKNOWN } from "@ji/domain";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { PostgresCurateStore } from "./postgres-curate-store";
import * as schema from "./schema";
import { aanvraag, bron, dedupGroep, scrapeRun } from "./schema";

const testDatabaseUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
const testDatabaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;
const migrationsFolder = path.join(import.meta.dir, "migrations");
/** Long enough that a blocked insert is unmistakably blocked, short enough to keep the suite fast. */
const BLOCKED_PROBE_MS = 300;
const OBSERVED_AT = new Date("2026-09-01T06:00:00.000Z");
const provenance = { parserVersion: "spec", sourcePath: "n/a" };

type TestDatabase = ReturnType<typeof drizzle<typeof schema>>;

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

const uniqueKey = (label: string): string =>
  buildDedupKey({
    opdrachtgeverNaam: "Gemeente Amsterdam",
    startDatum: "2026-09-01",
    titel: `${label} ${crypto.randomUUID()}`,
  });

const countGroups = async (
  database: TestDatabase,
  dedupKey: string
): Promise<number> => {
  const rows = await database
    .select({ id: dedupGroep.id })
    .from(dedupGroep)
    .where(eq(dedupGroep.dedupKey, dedupKey));
  return rows.length;
};

const deleteGroups = async (
  database: TestDatabase,
  dedupKey: string
): Promise<void> => {
  await database.delete(dedupGroep).where(eq(dedupGroep.dedupKey, dedupKey));
};

const draft = (
  bronReferentie: string,
  titel: string
): NormalisedAanvraagDraft => ({
  beschrijving: { provenance, value: `beschrijving ${bronReferentie}` },
  bronReferentie: { provenance, value: bronReferentie },
  bronSpecifiek: { provenance, value: {} },
  bronUrl: { provenance, value: UNKNOWN },
  contentHash: `hash-${bronReferentie}`,
  extractieMethode: "html_parser",
  lifecycle: "active",
  locatieLand: { provenance, value: "NL" },
  locatieTekst: { provenance, value: UNKNOWN },
  opdrachtgeverNaam: { provenance, value: "Gemeente Amsterdam" },
  parserVersion: "spec",
  startDatum: { provenance, value: "2026-09-01" },
  status: "active",
  tarief: { eenheid: UNKNOWN, max: UNKNOWN, min: UNKNOWN, valuta: "EUR" },
  titel: { provenance, value: titel },
});

const seedBronAndRun = async (
  database: TestDatabase
): Promise<{ bronId: BronId; scrapeRunId: ScrapeRunId }> => {
  const bronId: BronId = crypto.randomUUID();
  await database.insert(bron).values({
    actief: true,
    categorie: "msp_broker",
    crawlDelayMs: 0,
    id: bronId,
    ingestieType: "html",
    interval: "*/15 * * * *",
    naam: `Hero ${bronId}`,
    rateLimitPerMinute: 600,
    retentionDays: 30,
    status: "ready",
    voorwaardenStatus: "toegestaan",
  });
  const scrapeRunId: ScrapeRunId = crypto.randomUUID();
  await database.insert(scrapeRun).values({ bronId, id: scrapeRunId });
  return { bronId, scrapeRunId };
};

describe("PostgresCurateStore dedup keys", () => {
  let postgresAvailable = false;
  // Two clients, one connection each: every `transaction()` on a client is a
  // real, separate Postgres session, so A and B below genuinely race.
  let clientA: ReturnType<typeof postgres> | undefined;
  let clientB: ReturnType<typeof postgres> | undefined;
  let databaseA: TestDatabase | undefined;
  let databaseB: TestDatabase | undefined;

  beforeAll(async () => {
    postgresAvailable = await isPostgresAvailable();
    if (!postgresAvailable) {
      if (testDatabaseRequired) {
        throw new Error("Required test database is unavailable");
      }
      return;
    }

    clientA = postgres(testDatabaseUrl, { max: 1 });
    clientB = postgres(testDatabaseUrl, { max: 1 });
    databaseA = drizzle(clientA, { schema });
    databaseB = drizzle(clientB, { schema });
    await migrate(databaseA, { migrationsFolder });
  });

  afterAll(async () => {
    await clientA?.end({ timeout: 5 });
    await clientB?.end({ timeout: 5 });
  });

  it("round-trips a generated dedup key through Postgres text", async () => {
    if (!postgresAvailable || !databaseA) {
      expect(postgresAvailable).toBe(false);
      return;
    }

    const store = new PostgresCurateStore(databaseA);
    const dedupKey = uniqueKey("Senior Java Developer");
    const created = await store.ensureDedupGroep({ dedupKey });

    try {
      const loaded = await store.findDedupGroepByKey(dedupKey);
      expect(loaded?.dedupGroepId).toBe(created.dedupGroepId);
      expect(loaded?.dedupKey).toBe(dedupKey);

      const again = await store.ensureDedupGroep({ dedupKey });
      expect(again.dedupGroepId).toBe(created.dedupGroepId);
      expect(await countGroups(databaseA, dedupKey)).toBe(1);
    } finally {
      await deleteGroups(databaseA, dedupKey);
    }
  });

  it("makes a second transaction wait for the first and adopt its group", async () => {
    if (!postgresAvailable || !databaseA || !databaseB) {
      expect(postgresAvailable).toBe(false);
      return;
    }
    const dedupKey = uniqueKey("Racing key");

    // Transaction A inserts the group and then holds its transaction open
    // (uncommitted) until the test releases it.
    const { promise: heldOpen, resolve: releaseA } =
      Promise.withResolvers<boolean>();
    const { promise: insertedByA, resolve: resolveInserted } =
      Promise.withResolvers<StoredDedupGroep>();
    const transactionA = databaseA.transaction(async (tx) => {
      const group = await new PostgresCurateStore(tx).ensureDedupGroep({
        dedupKey,
      });
      resolveInserted(group);
      await heldOpen;
      return group;
    });
    const groupA = await insertedByA;

    try {
      // Transaction B: before 0015 this find-then-insert saw no row (A is
      // uncommitted) and created a second group. Now the unique index makes
      // its insert block on A's uncommitted row.
      const transactionB = databaseB.transaction((tx) =>
        new PostgresCurateStore(tx).ensureDedupGroep({ dedupKey })
      );
      const outcome = await Promise.race([
        transactionB.then(() => "resolved" as const),
        Bun.sleep(BLOCKED_PROBE_MS).then(() => "blocked" as const),
      ]);
      expect(outcome).toBe("blocked");

      releaseA(true);
      await transactionA;
      const groupB = await transactionB;

      expect(groupB.dedupGroepId).toBe(groupA.dedupGroepId);
      expect(await countGroups(databaseA, dedupKey)).toBe(1);
    } finally {
      releaseA(true);
      await transactionA.catch(() => {});
      await deleteGroups(databaseA, dedupKey);
    }
  });

  it("lets the second transaction create the group when the first rolls back", async () => {
    if (!postgresAvailable || !databaseA || !databaseB) {
      expect(postgresAvailable).toBe(false);
      return;
    }
    const dedupKey = uniqueKey("Aborted key");

    const { promise: abortSignal, reject: rejectA } =
      Promise.withResolvers<never>();
    const abortA = (): void =>
      rejectA(new Error("forced rollback of transaction A"));
    const { promise: insertedByA, resolve: resolveInserted } =
      Promise.withResolvers<boolean>();
    const transactionA = databaseA.transaction(async (tx) => {
      await new PostgresCurateStore(tx).ensureDedupGroep({ dedupKey });
      resolveInserted(true);
      await abortSignal;
    });
    await insertedByA;

    try {
      const transactionB = databaseB.transaction((tx) =>
        new PostgresCurateStore(tx).ensureDedupGroep({ dedupKey })
      );
      abortA();
      await expect(transactionA).rejects.toThrow(
        "forced rollback of transaction A"
      );

      // A's row never became visible, so B's insert goes through instead of
      // conflicting — there must still be exactly one group.
      const groupB = await transactionB;
      const loaded = await new PostgresCurateStore(
        databaseA
      ).findDedupGroepByKey(dedupKey);
      expect(loaded?.dedupGroepId).toBe(groupB.dedupGroepId);
      expect(await countGroups(databaseA, dedupKey)).toBe(1);
    } finally {
      await deleteGroups(databaseA, dedupKey);
    }
  });

  it("links two concurrently curated listings with one key to one group", async () => {
    if (!postgresAvailable || !databaseA || !databaseB) {
      expect(postgresAvailable).toBe(false);
      return;
    }
    const { bronId, scrapeRunId } = await seedBronAndRun(databaseA);
    const titel = `Concurrent listing ${crypto.randomUUID()}`;
    const dedupKey = buildDedupKey({
      opdrachtgeverNaam: "Gemeente Amsterdam",
      startDatum: "2026-09-01",
      titel,
    });
    const observation = (bronReferentie: string) => ({
      bronId,
      draft: draft(bronReferentie, titel),
      observedAt: OBSERVED_AT,
      rawPayloadRef: `raw/hero/${bronReferentie}.html`,
      scrapeRunId,
    });

    try {
      const [first, second] = await Promise.all([
        curateObservation(new PostgresCurateStore(databaseA), observation("A")),
        curateObservation(new PostgresCurateStore(databaseB), observation("B")),
      ]);

      expect(first.status).toBe("curated");
      expect(second.status).toBe("curated");
      expect(first.dedupGroepId).toBeDefined();
      expect(second.dedupGroepId).toBe(first.dedupGroepId);
      expect(await countGroups(databaseA, dedupKey)).toBe(1);

      const linked = await databaseA
        .select({ dedupGroepId: aanvraag.dedupGroepId })
        .from(aanvraag)
        .where(eq(aanvraag.bronId, bronId));
      expect(linked).toEqual([
        { dedupGroepId: first.dedupGroepId ?? null },
        { dedupGroepId: first.dedupGroepId ?? null },
      ]);
    } finally {
      // ji_test is shared: leave nothing behind (versies cascade off aanvraag).
      await databaseA.delete(aanvraag).where(eq(aanvraag.bronId, bronId));
      await databaseA.delete(scrapeRun).where(eq(scrapeRun.id, scrapeRunId));
      await databaseA.delete(bron).where(eq(bron.id, bronId));
      await deleteGroups(databaseA, dedupKey);
    }
  });
});
