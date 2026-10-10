import { describe, expect, it } from "bun:test";

import { parseBooleanQuery } from "@ji/domain";

import { SEARCH_INDEX_NAME } from "../types";
import { InMemorySearchVersionStore } from "../version";
import type { ManticoreHttpClient } from "./client";
import {
  buildManticoreSearchRequest,
  parseManticoreSearchResponse,
} from "./client";
import { buildQueryString } from "./emitter";
import { ManticoreSearchEngine } from "./engine";
import type {
  ManticoreBulkPayload,
  ManticoreRequestBody,
  ManticoreSearchPayload,
} from "./json";

const AE1_QUERY = '(Azure OR "platform engineer") NOT intern';

class RecordedManticoreClient implements ManticoreHttpClient {
  readonly bulkLines: string[][] = [];
  readonly requests: { body: ManticoreRequestBody; path: string }[] = [];
  private readonly responses: Record<string, ManticoreSearchPayload>;

  constructor(responses: Record<string, ManticoreSearchPayload>) {
    this.responses = responses;
  }

  bulk(lines: readonly string[]): Promise<ManticoreBulkPayload> {
    this.bulkLines.push([...lines]);
    return Promise.resolve({ errors: false });
  }

  request(
    path: string,
    body: ManticoreRequestBody
  ): Promise<ManticoreSearchPayload> {
    this.requests.push({ body, path });
    const queryPart = "query" in body ? (body.query ?? {}) : {};
    const key = `${path}:${JSON.stringify(queryPart)}`;
    const response = this.responses[key];
    if (!response) {
      throw new Error(`No recorded response for ${key}`);
    }

    return Promise.resolve(response);
  }
}

describe("Manticore golden queries", () => {
  it("records MATCH semantics for AE1 without mocking query emission", async () => {
    const parsed = parseBooleanQuery(AE1_QUERY);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error("Expected AE1 parse success");
    }

    const queryString = buildQueryString(parsed.ast);
    expect(queryString).toBe(
      '@(titel,beschrijving,opdrachtgever_naam) (Azure | "platform engineer") -intern'
    );

    const request = buildManticoreSearchRequest(
      SEARCH_INDEX_NAME,
      { query_string: queryString ?? "" },
      {},
      20,
      0
    );

    const client = new RecordedManticoreClient({
      [`/search:${JSON.stringify(request.query ?? {})}`]: {
        aggregations: {
          bron_id: { buckets: [{ doc_count: 1, key: "bron-1" }] },
          contracttype: { buckets: [{ doc_count: 1, key: "detachering" }] },
          locatie_land: { buckets: [{ doc_count: 1, key: "NL" }] },
          status: { buckets: [{ doc_count: 1, key: "active" }] },
        },
        hits: {
          hits: [{ _id: "hit-a", _score: 12 }],
          total: 1,
        },
      },
    });

    const engine = new ManticoreSearchEngine(
      client,
      new InMemorySearchVersionStore()
    );
    await engine.applyBatch({ appliedSequence: 1n, mutations: [] });

    const first = await engine.search({
      ast: parsed.ast,
      filters: { queryScope: "all" },
      limit: 20,
      offset: 0,
    });
    const second = await engine.search({
      ast: parsed.ast,
      filters: { queryScope: "all" },
      limit: 20,
      offset: 0,
    });

    expect(first.hits.map((hit) => hit.id)).toEqual(["hit-a"]);
    expect(second.hits.map((hit) => hit.id)).toEqual(["hit-a"]);
    const firstRequest = client.requests[0]?.body;
    if (!firstRequest || !("query" in firstRequest)) {
      throw new Error("Expected search request body");
    }
    expect(firstRequest.query).toEqual({
      query_string:
        '@(titel,beschrijving,opdrachtgever_naam) (Azure | "platform engineer") -intern',
    });
  });

  it("parses facet aggregations from recorded Manticore responses", () => {
    const parsed = parseManticoreSearchResponse({
      aggregations: {
        bron_id: { buckets: [{ doc_count: 2, key: "bron-1" }] },
        contracttype: { buckets: [{ doc_count: 2, key: "detachering" }] },
        locatie_land: { buckets: [{ doc_count: 2, key: "NL" }] },
        status: { buckets: [{ doc_count: 2, key: "active" }] },
      },
      hits: {
        hits: [{ _id: "doc-1", _score: 3 }],
        total: 1,
      },
    });

    expect(parsed.total).toBe(1);
    expect(parsed.facets.bron_id).toEqual([{ count: 2, value: "bron-1" }]);
  });
});
