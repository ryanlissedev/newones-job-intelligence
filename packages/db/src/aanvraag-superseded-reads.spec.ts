import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";

import type { BronId, ScrapeRunId } from "@ji/domain";
import { planOutboxBatch } from "@ji/search";
import type { OutboxEventRecord } from "@ji/search";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import {
  PostgresAanvraagStore,
  PostgresSearchDocumentLoader,
} from "./aanvraag-stores";
import { PostgresBronOverlapReader } from "./bron-overlap";
import { PostgresEnrichmentStore } from "./enrichment-store";
import * as schema from "./schema";
import { aanvraag, bron, scrapeRun } from "./schema";

const migratorUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
const databaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;
const migrationsFolder = path.join(import.meta.dir, "migrations");

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

const NOW = new Date("2026-10-11T06:00:00.000Z");
const ignoreNotice = (): void => undefined;

const outboxEventFor = (
  aggregateId: string,
  eventType: string,
  sequenceNumber: bigint
): OutboxEventRecord => ({
  aggregateId,
  aggregateType: "aanvraag",
  eventType,
  id: crypto.randomUUID(),
  payload: {},
  sequenceNumber,
});

describe
  .skipIf(!postgresAvailable)
  .serial("read paths skip superseded aanvragen (0033)", () => {
    let client: ReturnType<typeof postgres>;
    let database: ReturnType<typeof drizzle<typeof schema>>;
    const bronId: BronId = crypto.randomUUID();
    const runId: ScrapeRunId = crypto.randomUUID();
    // kept <- superseded <- chained (two hops), plus an unrelated live row
    const keptId = crypto.randomUUID();
    const supersededId = crypto.randomUUID();
    const chainedId = crypto.randomUUID();
    const otherId = crypto.randomUUID();
    const allIds = [keptId, supersededId, chainedId, otherId];

    beforeAll(async () => {
      client = postgres(migratorUrl, { max: 1, onnotice: ignoreNotice });
      await migrate(drizzle(client), { migrationsFolder });
      database = drizzle(client, { schema });
      await database.insert(bron).values({
        actief: false,
        categorie: "msp_broker",
        id: bronId,
        naam: `Superseded reads ${bronId}`,
        status: "ready",
        voorwaardenStatus: "toegestaan",
      });
      await database.insert(scrapeRun).values({ bronId, id: runId });
      await database.insert(aanvraag).values(
        allIds.map((id, index) => ({
          beschrijving: "beschrijving",
          bronId,
          bronReferentie: `ref-${index}-${id}`,
          bronUrl: "https://example.test/vacature/1",
          contentHash: `hash-${id}`,
          eersteGezienOp: NOW,
          extractieMethode: "html_parser",
          id,
          laatstGezienOp: NOW,
          // incomplete on purpose: every row is an enrichment candidate unless superseded
          locatieTekst: null,
          rawPayloadRef: `raw/${id}.html`,
          scrapeRunId: runId,
          status: "active",
          titel: `titel ${index}`,
        }))
      );
      await client`UPDATE curated.aanvraag
                      SET superseded_by = ${keptId}, superseded_at = now(), superseded_reason = 'dup-url-v1'
                    WHERE id = ${supersededId}`;
      await client`UPDATE curated.aanvraag
                      SET superseded_by = ${supersededId}, superseded_at = now(), superseded_reason = 'dup-url-v1'
                    WHERE id = ${chainedId}`;
    });

    afterAll(async () => {
      await database.delete(aanvraag).where(inArray(aanvraag.id, allIds));
      await client`DELETE FROM curated.scrape_run WHERE id = ${runId}`;
      await client`DELETE FROM curated.bron WHERE id = ${bronId}`;
      await client.end({ timeout: 5 });
    });

    it("detail by a superseded id resolves to the kept row (one hop and a chain)", async () => {
      const store = new PostgresAanvraagStore(database);
      const kept = await store.getById(keptId);
      const viaSuperseded = await store.getById(supersededId);
      const viaChain = await store.getById(chainedId);
      expect(kept?.id).toBe(keptId);
      expect(viaSuperseded?.id).toBe(keptId);
      expect(viaChain?.id).toBe(keptId);
      expect(await store.getById(crypto.randomUUID())).toBeNull();
    });

    it("batch reads (list hydration, compare, export selections) resolve and list the kept row once", async () => {
      const store = new PostgresAanvraagStore(database);
      const records = await store.getByIds([
        supersededId,
        otherId,
        keptId,
        chainedId,
      ]);
      expect(records.map((record) => record.id)).toEqual([keptId, otherId]);
    });

    it("the search loader never loads a superseded row, single or bulk", async () => {
      const loader = new PostgresSearchDocumentLoader(database);
      expect(await loader.loadByAggregateId(supersededId)).toBeNull();
      const keptDocument = await loader.loadByAggregateId(keptId);
      expect(keptDocument?.id).toBe(keptId);
      const bulk = await loader.loadManyByAggregateIds(allIds);
      expect([...bulk.keys()].toSorted()).toEqual([keptId, otherId].toSorted());
    });

    it("the projector drops upserts for a superseded row and applies its delete", async () => {
      const loader = new PostgresSearchDocumentLoader(database);
      const upsertOnly = await planOutboxBatch({
        events: [
          outboxEventFor(supersededId, "aanvraag.gewijzigd", 1n),
          outboxEventFor(keptId, "aanvraag.gewijzigd", 2n),
        ],
        loadDocuments: (ids) => loader.loadManyByAggregateIds(ids),
        now: NOW,
      });
      expect(
        upsertOnly.mutations.map((mutation) =>
          mutation.kind === "upsert" ? mutation.document.id : mutation.id
        )
      ).toEqual([keptId]);

      // What the mark scripts enqueue: the superseded row leaves the index.
      const withDelete = await planOutboxBatch({
        events: [
          outboxEventFor(supersededId, "aanvraag.gewijzigd", 3n),
          outboxEventFor(supersededId, "aanvraag.verwijderd", 4n),
        ],
        loadDocuments: (ids) => loader.loadManyByAggregateIds(ids),
        now: NOW,
      });
      expect(withDelete.mutations).toEqual([
        expect.objectContaining({ id: supersededId, kind: "delete" }),
      ]);
    });

    it("enrichment never picks a superseded row", async () => {
      const enrichment = new PostgresEnrichmentStore(database);
      expect(await enrichment.listIncompleteById(supersededId)).toBeNull();
      expect(await enrichment.listIncompleteById(chainedId)).toBeNull();
      const keptCandidate = await enrichment.listIncompleteById(keptId);
      expect(keptCandidate?.id).toBe(keptId);
    });

    it("bron overlap stats count live rows only", async () => {
      const overlap = await new PostgresBronOverlapReader(
        database
      ).bronOverlap();
      const ours = overlap.perBron.find((entry) => entry.bronId === bronId);
      expect(ours?.totalAanvragen).toBe(2);
    });
  });
