import { describe, expect, it } from "bun:test";

import { emptySearchFacets, SEARCH_WINDOW_LIMIT } from "@ji/search";
import type { SearchDocument } from "@ji/search";

import {
  createSearchAanvragenHandler,
  searchAanvragenInputSchema,
} from "./handlers";
import { permissionsForRole } from "./roles";
import { createTestSliceARegistry } from "./test-fixtures";

const recruiterPrincipal = {
  kind: "user" as const,
  permissions: permissionsForRole("recruiter"),
  subjectId: "recruiter-1",
};

const seedDocument = (index: number): SearchDocument => ({
  beschrijving: "Azure platform engineer",
  bronId: "00000000-0000-4000-8000-000000000001",
  contracttype: "detachering",
  eindklantNaam: null,
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  laatstGezienOp: new Date(Date.UTC(2026, 7, 1 + index)),
  locatieLand: "NL",
  opdrachtgeverNaam: null,
  provincie: null,
  publicatiedatum: new Date(Date.UTC(2026, 7, 1 + index)),
  skills: [],
  status: "active",
  tariefEenheid: null,
  tariefMax: 100 + index,
  tariefMin: 80,
  titel: `Azure engineer ${index}`,
  urenPerWeekMax: null,
  urenPerWeekMin: null,
  werkvorm: null,
});

// RJC-378: the API owns sort, filter and pagination; the client receives the
// true total plus the retrievable window instead of a fixed 100-hit slice.
describe("search_aanvragen paging contract (RJC-378)", () => {
  it("accepts sort and any page inside the window, rejects offset + limit past it", () => {
    expect(
      searchAanvragenInputSchema.safeParse({
        limit: 8,
        offset: SEARCH_WINDOW_LIMIT - 8,
        query: "Azure",
        sort: "closing-soon",
      }).success
    ).toBe(true);
    expect(
      searchAanvragenInputSchema.safeParse({
        limit: 8,
        offset: SEARCH_WINDOW_LIMIT - 7,
        query: "Azure",
      }).success
    ).toBe(false);
    expect(
      searchAanvragenInputSchema.safeParse({ query: "Azure", sort: "random" })
        .success
    ).toBe(false);
    expect(
      searchAanvragenInputSchema.safeParse({
        filters: { locatie: ["NL"] },
        query: "Azure",
      }).success
    ).toBe(true);
  });

  it("returns one engine-sorted page with the true total and window", async () => {
    const bundle = createTestSliceARegistry();
    for (let index = 0; index < 12; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- ordered seeding
      await bundle.deps.engine.upsertDocument(seedDocument(index));
    }
    const handler = createSearchAanvragenHandler(bundle.deps);

    const firstPage = await handler({
      limit: 8,
      offset: 0,
      query: "Azure",
      sort: "newest",
    });
    const secondPage = await handler({
      limit: 8,
      offset: 8,
      query: "Azure",
      sort: "newest",
    });

    if (!(firstPage.ok && secondPage.ok)) {
      throw new Error("expected successful searches");
    }
    expect(firstPage.value.total).toBe(12);
    expect(firstPage.value.incomplete).toBe(false);
    expect(firstPage.value.windowLimit).toBe(SEARCH_WINDOW_LIMIT);
    expect(firstPage.value.ids).toHaveLength(8);
    // newest first: index 11 has the latest publicatiedatum
    expect(firstPage.value.ids[0]).toBe(seedDocument(11).id);
    expect(secondPage.value.ids).toHaveLength(4);
    expect(secondPage.value.ids.at(-1)).toBe(seedDocument(0).id);
    expect(firstPage.value.facets.locatie).toEqual([
      { count: 12, value: "NL" },
    ]);
  });

  it("returns browse results for whitespace while malformed nonempty syntax still fails", async () => {
    const bundle = createTestSliceARegistry();
    await bundle.deps.engine.upsertDocument(seedDocument(0));

    await Promise.all(
      (["rest", "mcp"] as const).map(async (transport) => {
        const operation =
          transport === "rest"
            ? "POST /v1/aanvragen/search"
            : "search_aanvragen";
        const invoke = bundle.registry.createInvoker({
          capabilityId: "search_aanvragen",
          operation,
          transport,
        });
        const browse = await invoke(
          { filters: { locatieLand: ["NL"] }, query: "   " },
          { principal: recruiterPrincipal, requestId: `browse-${transport}` }
        );
        expect(browse.ok).toBe(true);
        if (browse.ok) {
          expect(browse.value).toMatchObject({
            incomplete: false,
            total: 1,
          });
        }

        const invalid = await invoke(
          { query: "Azure AND" },
          { principal: recruiterPrincipal, requestId: `invalid-${transport}` }
        );
        expect(invalid.ok).toBe(false);
        if (!invalid.ok) {
          expect(invalid.error.code).toBe("SYNTAX_ERROR");
        }
      })
    );
  });

  it("keeps incomplete timeout state explicit with zero and partial hits", async () => {
    await Promise.all(
      [0, 1].map(async (hitCount) => {
        const bundle = createTestSliceARegistry();
        bundle.deps.engine.search = (params) =>
          Promise.resolve({
            archiveTotal: null,
            emptyReason: "query_timeout",
            facets: emptySearchFacets(),
            hits: hitCount === 0 ? [] : [{ id: seedDocument(0).id, weight: 1 }],
            incomplete: true,
            indexVersion: 0,
            scope: params.scope ?? "active",
            total: hitCount,
            windowLimit: SEARCH_WINDOW_LIMIT,
          });

        const result = await createSearchAanvragenHandler(bundle.deps)({
          query: "Azure",
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value.incomplete).toBe(true);
          expect(result.value.emptyReason).toBe("query_timeout");
          expect(result.value.ids).toHaveLength(hitCount);
        }
      })
    );
  });
});
