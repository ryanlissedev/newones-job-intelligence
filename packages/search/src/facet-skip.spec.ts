import { describe, expect, it } from "bun:test";

import { SearchAdapter } from "./adapter";
import { InMemorySearchEngine } from "./in-memory-engine";
import type {
  ManticoreHttpClient,
  ManticoreRequestOptions,
} from "./manticore/client";
import { ManticoreSearchEngine } from "./manticore/engine";
import type {
  ManticoreBulkPayload,
  ManticoreRequestBody,
  ManticoreSearchPayload,
} from "./manticore/json";
import type { EngineSearchParams, SearchDocument, SearchEngine } from "./types";
import { InMemorySearchVersionStore } from "./version";

const document = (id: string, bronId: string): SearchDocument => ({
  beschrijving: "Azure platform engineer",
  bronId,
  contracttype: "detachering",
  eindklantNaam: null,
  id,
  laatstGezienOp: new Date("2026-10-01T00:00:00.000Z"),
  locatieLand: "NL",
  opdrachtgeverNaam: null,
  provincie: null,
  publicatiedatum: null,
  skills: [],
  status: "active",
  tariefEenheid: null,
  tariefMax: null,
  tariefMin: null,
  titel: `Platform engineer ${id}`,
  urenPerWeekMax: null,
  urenPerWeekMin: null,
  werkvorm: null,
});

const recordingEngine = (
  engine: InMemorySearchEngine,
  calls: EngineSearchParams[]
): SearchEngine => ({
  applyBatch: (batch) => engine.applyBatch(batch),
  deleteDocument: (id) => engine.deleteDocument(id),
  getAppliedVersion: () => engine.getAppliedVersion(),
  search: (params) => {
    calls.push(params);
    return engine.search(params);
  },
  upsertDocument: (doc) => engine.upsertDocument(doc),
});

describe("facet cache skips engine aggregations", () => {
  it("asks for facets on a facet-cache miss and skips them on a hit", async () => {
    const engine = new InMemorySearchEngine();
    await engine.upsertDocument(document("doc-a", "bron-1"));
    await engine.upsertDocument(document("doc-b", "bron-2"));
    await engine.applyBatch({ appliedSequence: 1n, mutations: [] });
    const calls: EngineSearchParams[] = [];
    const adapter = new SearchAdapter({
      engine: recordingEngine(engine, calls),
    });

    // Same query and filters, different page: a result-cache miss that
    // shares the facet key.
    const firstPage = await adapter.search({ limit: 1, query: "Azure" });
    const secondPage = await adapter.search({
      limit: 1,
      offset: 1,
      query: "Azure",
    });

    expect(calls.map((call) => call.facets)).toEqual([true, false]);
    if (!(firstPage.ok && secondPage.ok)) {
      throw new Error("Expected successful searches");
    }
    expect(firstPage.facets.bron_id).toHaveLength(2);
    expect(secondPage.facets).toEqual(firstPage.facets);
    expect(secondPage.hits).not.toEqual(firstPage.hits);
  });

  it("the in-memory engine returns empty facets when they are skipped", async () => {
    const engine = new InMemorySearchEngine();
    await engine.upsertDocument(document("doc-a", "bron-1"));
    await engine.applyBatch({ appliedSequence: 1n, mutations: [] });

    const result = await engine.search({
      ast: null,
      facets: false,
      filters: {},
      limit: 10,
      offset: 0,
    });

    expect(result.total).toBe(1);
    expect(result.facets.bron_id).toEqual([]);
  });
});

const capture = () => {
  const bodies: ManticoreRequestBody[] = [];
  const client: ManticoreHttpClient = {
    bulk: (): Promise<ManticoreBulkPayload> =>
      Promise.resolve({ errors: false }),
    request: (
      _path: string,
      body: ManticoreRequestBody,
      _options: ManticoreRequestOptions = {}
    ): Promise<ManticoreSearchPayload> => {
      bodies.push(body);
      return Promise.resolve({ hits: { hits: [], total: 0 } });
    },
  };
  return { bodies, client };
};

describe("Manticore engine facet skip", () => {
  const searchBodies = async (facets?: boolean) => {
    const { bodies, client } = capture();
    await new ManticoreSearchEngine(
      client,
      new InMemorySearchVersionStore()
    ).search({ ast: null, facets, filters: {}, limit: 10, offset: 0 });
    // The archive count (limit 0) never carries aggregations; the hit
    // request is the one with a page size.
    return bodies.filter((body) => "limit" in body && body.limit !== 0);
  };

  it("sends the terms aggregations by default", async () => {
    const [hitRequest] = await searchBodies();
    expect(hitRequest).toBeDefined();
    expect(hitRequest && "aggs" in hitRequest).toBe(true);
  });

  it("drops the aggregations when facets are not wanted", async () => {
    const [hitRequest] = await searchBodies(false);
    expect(hitRequest).toBeDefined();
    expect(hitRequest && "aggs" in hitRequest).toBe(false);
  });
});
