import { beforeAll, describe, expect, it } from "bun:test";

import { InMemorySearchEngine } from "../in-memory-engine";
import type { SearchDocument, SearchFilters, SearchSort } from "../types";
import { InMemorySearchVersionStore } from "../version";
import type { ManticoreSearchEngine } from "./engine";
import {
  assertLiveTestTablesReady,
  cleanupLiveDocuments,
  createLiveTestEngine,
  requireLiveManticoreUrl,
} from "./live-test-hygiene";

// Live check of the RJC-378 ordering contract against a real Manticore
// (needs the locatie + sluitingsdatum attributes, see tools/manticore/
// manticore.conf). Skipped unless MANTICORE_URL is set, like live.spec.ts.
const manticoreUrl = requireLiveManticoreUrl(
  process.env.MANTICORE_URL,
  process.env.MANTICORE_REQUIRE_LIVE === "1"
);

const onlyTies = (list: string[]) => list.filter((id) => id.startsWith("tie-"));

// Fixed clock (RJC-383): the Sept-2026 deadlines below must stay in the
// active partition however late this spec runs.
const clock = () => new Date("2026-08-30T12:00:00.000Z");
const LIVE_TEST_INDEX_NAME = "aanvragen_test_sort";

describe.skipIf(!manticoreUrl)(
  "Manticore sort/filter live integration (RJC-378)",
  () => {
    beforeAll(() =>
      assertLiveTestTablesReady(manticoreUrl, LIVE_TEST_INDEX_NAME)
    );
    it("orders each sort key natively with missing values last and stable ids", async () => {
      if (!manticoreUrl) {
        throw new Error("Live test was not skipped without MANTICORE_URL");
      }
      const engine = createLiveTestEngine(
        manticoreUrl,
        new InMemorySearchVersionStore(),
        LIVE_TEST_INDEX_NAME,
        clock
      );
      const inMemory = new InMemorySearchEngine(undefined, clock);
      const runToken = `sortlive${crypto.randomUUID().replaceAll("-", "")}`;
      const prefix = `sort-live-${crypto.randomUUID()}`;
      const base = (
        suffix: string,
        overrides: Partial<SearchDocument>
      ): SearchDocument => ({
        beschrijving: `Sort fixture ${runToken}`,
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
        tariefEenheid: "uur",
        tariefMax: 100,
        tariefMin: 80,
        titel: "Sort fixture",
        urenPerWeekMax: null,
        urenPerWeekMin: null,
        werkvorm: null,
        ...overrides,
      });
      const documents = [
        base("newest", {
          publicatiedatum: new Date("2026-08-20T00:00:00Z"),
          tariefEenheid: "uur",
        }),
        base("rich", { tariefEenheid: "uur", tariefMax: 150 }),
        base("norate", {
          tariefEenheid: null,
          tariefMax: null,
          tariefMin: null,
        }),
        base("soon", { sluitingsdatum: new Date("2026-09-05T00:00:00Z") }),
        base("later", { sluitingsdatum: new Date("2026-09-20T00:00:00Z") }),
        base("ams", { locatie: "Amsterdam" }),
        // Identical sort keys: only the tiebreak orders these, and it must be
        // the same tiebreak (hashed document id) in both engines.
        base("tie-1", {}),
        base("tie-2", {}),
        base("tie-3", {}),
      ];
      const { parseBooleanQuery } = await import("@ji/domain");
      const parsed = parseBooleanQuery(runToken);
      if (!parsed.ok) {
        throw new Error("run token must parse");
      }
      try {
        for (const item of documents) {
          // oxlint-disable-next-line no-await-in-loop -- sequential replaces keep the fixture ordered
          await engine.upsertDocument(item);
          // oxlint-disable-next-line no-await-in-loop -- same order into the test double
          await inMemory.upsertDocument(item);
        }
        const idsFrom = async (
          target: InMemorySearchEngine | ManticoreSearchEngine,
          sort: SearchSort,
          filters: SearchFilters = {}
        ) => {
          const result = await target.search({
            ast: parsed.ast,
            filters,
            limit: 10,
            offset: 0,
            sort,
          });
          return result.hits.map((hit) => hit.id.slice(prefix.length + 1));
        };
        const ids = (sort: SearchSort, filters: SearchFilters = {}) =>
          idsFrom(engine, sort, filters);

        const byNewest = await ids("newest");
        expect(byNewest[0]).toBe("newest");
        const byRate = await ids("rate-high");
        expect(byRate[0]).toBe("rich");
        expect(byRate.at(-1)).toBe("norate");
        const byDeadline = await ids("closing-soon");
        expect(byDeadline.slice(0, 2)).toEqual(["soon", "later"]);
        expect(await ids("newest", { locatie: ["Amsterdam"] })).toEqual([
          "ams",
        ]);
        // Range filter proven live, not only by request shape.
        expect(await ids("rate-high", { tariefMin: 140 })).toEqual(["rich"]);

        for (const sort of ["newest", "rate-high", "closing-soon"] as const) {
          // oxlint-disable-next-line no-await-in-loop -- one comparison per sort key
          const live = onlyTies(await ids(sort));
          // oxlint-disable-next-line no-await-in-loop -- one comparison per sort key
          const local = onlyTies(await idsFrom(inMemory, sort));
          expect(live).toHaveLength(3);
          expect(local).toEqual(live);
        }

        const paged = await engine.search({
          ast: parsed.ast,
          filters: {},
          limit: 4,
          offset: 8,
          sort: "newest",
        });
        expect(paged.total).toBe(documents.length);
        expect(paged.hits).toHaveLength(1);
        expect(paged.facets.locatie).toContainEqual({
          count: 1,
          value: "Amsterdam",
        });
      } finally {
        await cleanupLiveDocuments(
          engine,
          documents.map((item) => item.id)
        );
      }
    });

    it("omits unknown locations from the live facet and location filter", async () => {
      if (!manticoreUrl) {
        throw new Error("Live test was not skipped without MANTICORE_URL");
      }
      const engine = createLiveTestEngine(
        manticoreUrl,
        new InMemorySearchVersionStore(),
        LIVE_TEST_INDEX_NAME,
        clock
      );
      const runToken = `locationlive${crypto.randomUUID().replaceAll("-", "")}`;
      const prefix = `location-live-${crypto.randomUUID()}`;
      const documents: SearchDocument[] = [
        {
          beschrijving: runToken,
          bronId: "bron-live",
          contracttype: "detachering",
          eindklantNaam: null,
          id: `${prefix}-unknown`,
          laatstGezienOp: new Date("2026-08-01T00:00:00.000Z"),
          locatie: null,
          locatieLand: null,
          opdrachtgeverNaam: null,
          provincie: null,
          publicatiedatum: null,
          skills: [],
          status: "active",
          tariefEenheid: null,
          tariefMax: 100,
          tariefMin: 80,
          titel: "Unknown location",
          urenPerWeekMax: null,
          urenPerWeekMin: null,
          werkvorm: null,
        },
        {
          beschrijving: runToken,
          bronId: "bron-live",
          contracttype: "detachering",
          eindklantNaam: null,
          id: `${prefix}-nl`,
          laatstGezienOp: new Date("2026-08-01T00:00:00.000Z"),
          locatie: "Amsterdam",
          locatieLand: "NL",
          opdrachtgeverNaam: null,
          provincie: null,
          publicatiedatum: null,
          skills: [],
          status: "active",
          tariefEenheid: null,
          tariefMax: 100,
          tariefMin: 80,
          titel: "Dutch location",
          urenPerWeekMax: null,
          urenPerWeekMin: null,
          werkvorm: null,
        },
        {
          beschrijving: runToken,
          bronId: "bron-live",
          contracttype: "detachering",
          eindklantNaam: null,
          id: `${prefix}-be`,
          laatstGezienOp: new Date("2026-08-01T00:00:00.000Z"),
          locatie: "Brussel",
          locatieLand: "BE",
          opdrachtgeverNaam: null,
          provincie: null,
          publicatiedatum: null,
          skills: [],
          status: "active",
          tariefEenheid: null,
          tariefMax: 100,
          tariefMin: 80,
          titel: "Belgian location",
          urenPerWeekMax: null,
          urenPerWeekMin: null,
          werkvorm: null,
        },
      ];
      const { parseBooleanQuery } = await import("@ji/domain");
      const parsed = parseBooleanQuery(runToken);
      if (!parsed.ok) {
        throw new Error("run token must parse");
      }

      try {
        for (const document of documents) {
          // oxlint-disable-next-line no-await-in-loop -- sequential writes keep live fixture setup deterministic
          await engine.upsertDocument(document);
        }
        const result = await engine.search({
          ast: parsed.ast,
          filters: {},
          limit: 10,
          offset: 0,
        });
        expect(result.total).toBe(3);
        expect(result.facets.locatie).toHaveLength(2);
        expect(result.facets.locatie).toContainEqual({
          count: 1,
          value: "Amsterdam",
        });
        expect(result.facets.locatie).toContainEqual({
          count: 1,
          value: "Brussel",
        });
        expect(result.facets.locatie).not.toContainEqual({
          count: 1,
          value: "",
        });
        expect(result.facets.locatie_land).toContainEqual({
          count: 1,
          value: "NL",
        });
        expect(result.facets.locatie_land).toContainEqual({
          count: 1,
          value: "BE",
        });
        expect(result.facets.locatie_land).not.toContainEqual({
          count: 1,
          value: "",
        });

        const nlDisplayLocation = await engine.search({
          ast: parsed.ast,
          filters: { locatie: ["NL"] },
          limit: 10,
          offset: 0,
        });
        expect(nlDisplayLocation.total).toBe(0);

        const nlCountry = await engine.search({
          ast: parsed.ast,
          filters: { locatieLand: ["NL"] },
          limit: 10,
          offset: 0,
        });
        expect(nlCountry.total).toBe(1);
      } finally {
        await cleanupLiveDocuments(
          engine,
          documents.map((document) => document.id)
        );
      }
    });
  }
);
