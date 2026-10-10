import { beforeAll, describe, expect, it } from "bun:test";

import { parseBooleanQuery } from "@ji/domain";

import type { SearchDocument } from "../types";
import { InMemorySearchVersionStore } from "../version";
import {
  assertLiveTestTablesReady,
  cleanupLiveDocuments,
  createLiveTestEngine,
  requireLiveManticoreUrl,
} from "./live-test-hygiene";

// Live /bulk round-trip against a real Manticore (RJC-389). Skipped unless
// MANTICORE_URL is set, like live.spec.ts and sort-live.spec.ts.
const manticoreUrl = requireLiveManticoreUrl(
  process.env.MANTICORE_URL,
  process.env.MANTICORE_REQUIRE_LIVE === "1"
);
const LIVE_TEST_INDEX_NAME = "aanvragen_test_bulk";

describe.skipIf(!manticoreUrl)(
  "Manticore /bulk live integration (RJC-389)",
  () => {
    beforeAll(() =>
      assertLiveTestTablesReady(manticoreUrl, LIVE_TEST_INDEX_NAME)
    );
    it("applies three replaces and one delete in a single bulk request", async () => {
      if (!manticoreUrl) {
        throw new Error("Live test was not skipped without MANTICORE_URL");
      }
      const store = new InMemorySearchVersionStore();
      const engine = createLiveTestEngine(
        manticoreUrl,
        store,
        LIVE_TEST_INDEX_NAME
      );
      const runToken = `bulklive${crypto.randomUUID().replaceAll("-", "")}`;
      const parsed = parseBooleanQuery(runToken);
      if (!parsed.ok) {
        throw new Error("run token must parse");
      }
      const prefix = `bulk-live-${crypto.randomUUID()}`;
      const doc = (suffix: string): SearchDocument => ({
        beschrijving: `Bulk fixture ${runToken}`,
        bronId: "bron-live",
        contracttype: "detachering",
        eindklantNaam: null,
        id: `${prefix}-${suffix}`,
        laatstGezienOp: new Date("2026-08-01T00:00:00.000Z"),
        locatieLand: "NL",
        opdrachtgeverNaam: null,
        provincie: null,
        publicatiedatum: null,
        skills: [],
        status: "active",
        tariefEenheid: null,
        tariefMax: 100,
        tariefMin: 80,
        titel: "Bulk fixture",
        urenPerWeekMax: null,
        urenPerWeekMin: null,
        werkvorm: null,
      });
      const ids = ["a", "b", "c", "d"].map((suffix) => `${prefix}-${suffix}`);
      try {
        // Seed the doc the bulk will delete.
        await engine.upsertDocument(doc("d"));

        const result = await engine.applyBatch({
          appliedSequence: 4n,
          mutations: [
            { document: doc("a"), kind: "upsert", sequenceNumber: 1n },
            { document: doc("b"), kind: "upsert", sequenceNumber: 2n },
            { document: doc("c"), kind: "upsert", sequenceNumber: 3n },
            { id: `${prefix}-d`, kind: "delete", sequenceNumber: 4n },
          ],
        });
        expect(result.failures).toEqual([]);
        expect(result.unapplied).toEqual([]);
        expect(result.appliedSequence).toBe(4n);

        const found = await engine.search({
          ast: parsed.ast,
          filters: {},
          limit: 10,
          offset: 0,
        });
        const foundIds = found.hits.map((hit) => hit.id).toSorted();
        expect(foundIds).toEqual(ids.slice(0, 3).toSorted());
      } finally {
        await cleanupLiveDocuments(engine, ids);
      }
    });

    it("moves a document from active to archive in one bulk and searches it per scope (RJC-383)", async () => {
      if (!manticoreUrl) {
        throw new Error("Live test was not skipped without MANTICORE_URL");
      }
      const store = new InMemorySearchVersionStore();
      const engine = createLiveTestEngine(
        manticoreUrl,
        store,
        LIVE_TEST_INDEX_NAME
      );
      const runToken = `movelive${crypto.randomUUID().replaceAll("-", "")}`;
      const parsed = parseBooleanQuery(runToken);
      if (!parsed.ok) {
        throw new Error("run token must parse");
      }
      const id = `move-live-${crypto.randomUUID()}`;
      const document: SearchDocument = {
        beschrijving: `Move fixture ${runToken}`,
        bronId: "bron-live",
        contracttype: "detachering",
        eindklantNaam: null,
        id,
        laatstGezienOp: new Date("2026-08-01T00:00:00.000Z"),
        locatieLand: "NL",
        opdrachtgeverNaam: null,
        provincie: null,
        publicatiedatum: null,
        skills: [],
        status: "active",
        tariefEenheid: null,
        tariefMax: 100,
        tariefMin: 80,
        titel: "Move fixture",
        urenPerWeekMax: null,
        urenPerWeekMin: null,
        werkvorm: null,
      };
      const search = (scope: "active" | "all") =>
        engine.search({
          ast: parsed.ast,
          filters: {},
          limit: 10,
          offset: 0,
          scope,
        });
      try {
        await engine.applyBatch({
          appliedSequence: 1n,
          mutations: [
            {
              document,
              kind: "upsert",
              partition: "active",
              sequenceNumber: 1n,
            },
          ],
        });
        const before = await search("active");
        expect(before.hits.map((hit) => hit.id)).toEqual([id]);
        expect(before.archiveTotal).toBe(0);

        const moved = await engine.applyBatch({
          appliedSequence: 2n,
          mutations: [
            {
              document: { ...document, status: "closed" },
              kind: "upsert",
              partition: "archive",
              previousPartition: "active",
              sequenceNumber: 2n,
            },
          ],
        });
        expect(moved.failures).toEqual([]);
        expect(moved.unapplied).toEqual([]);

        const active = await search("active");
        expect(active.hits).toEqual([]);
        expect(active.total).toBe(0);
        expect(active.archiveTotal).toBe(1);
        const all = await search("all");
        expect(all.hits.map((hit) => hit.id)).toEqual([id]);
        expect(all.total).toBe(1);
        expect(all.facets.status).toEqual([{ count: 1, value: "closed" }]);
      } finally {
        await cleanupLiveDocuments(engine, [id]);
      }
    });
  }
);
