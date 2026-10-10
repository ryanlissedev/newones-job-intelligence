import { describe, expect, it } from "bun:test";

import { HttpStatusError } from "@ji/connectors/json-ld";
import {
  createWerkNlClient,
  createWerkNlConnector,
  WERK_NL_PAGE_SIZE,
} from "@ji/connectors/werk-nl";
import type {
  WerkNlClient,
  WerkNlSearchItem,
  WerkNlSearchResponse,
  WerkNlVacatureDetail,
} from "@ji/connectors/werk-nl";

const makeItem = (referenceNumber: number): WerkNlSearchItem => ({
  contractType: "Vast",
  key: `2001:L:${referenceNumber}`,
  leerbaan: false,
  maxHours: 40,
  minHours: 32,
  modified: "2026-09-18 00:00:00",
  organisation: "Test B.V.",
  profession: "Tester",
  referenceNumber,
  stageplaats: false,
  studyLevel: "MBO",
  vacatureTitle: `Vacature ${referenceNumber}`,
  workLocationCity: "AMSTERDAM",
  workLocationForeignCity: null,
  workLocationForeignCountry: null,
  workLocationType: "Vaste werklocatie",
});

const makeDetail = (referenceNumber: number): WerkNlVacatureDetail => ({
  referenceNumber,
  title: `Vacature ${referenceNumber}`,
});

interface PagedClient {
  calls: { page: number; shiftType: string }[];
  client: WerkNlClient;
}

const pagedClient = (shardTotals: Record<string, number>): PagedClient => {
  const calls: { page: number; shiftType: string }[] = [];
  return {
    calls,
    client: {
      fetchDetail: (referenceNumber) =>
        Promise.resolve(makeDetail(Number(referenceNumber))),
      fetchListing: (page, shiftType) => {
        calls.push({ page, shiftType });
        const total = shardTotals[shiftType] ?? 0;
        const start = (page - 1) * WERK_NL_PAGE_SIZE;
        const items =
          start >= total
            ? []
            : Array.from(
                {
                  length: Math.min(WERK_NL_PAGE_SIZE, total - start),
                },
                (_, index) => makeItem(start + index + 1)
              );
        const response: WerkNlSearchResponse = {
          facets: [],
          items,
          totalResults: total,
        };
        return Promise.resolve(response);
      },
    },
  };
};

describe("werk.nl connector", () => {
  it("binds the connector to the supplied bron id", () => {
    const connector = createWerkNlConnector({ bronId: "bron-test" });
    expect(connector.bronId).toBe("bron-test");
  });

  it("discovers fixture items with string bronReferenties", async () => {
    const connector = createWerkNlConnector({
      bronId: "bron-test",
      client: createWerkNlClient({ liveEnabled: false }),
      shardValues: ["1"],
    });
    const result = await connector.discover(null);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.bronReferentie).toBe("56790376");
    expect(result.items[0]?.bronReferentie).toBeTypeOf("string");
  });

  it("pages a shard then advances to the next shard", async () => {
    const { client, calls } = pagedClient({ "1": 21, "2": 3 });
    const connector = createWerkNlConnector({ bronId: "bron-test", client });

    const first = await connector.discover(null);
    expect(first.items).toHaveLength(WERK_NL_PAGE_SIZE);
    expect(first.hasMore).toBe(true);

    const second = await connector.discover(first.checkpoint);
    expect(second.items).toHaveLength(1);
    expect(second.hasMore).toBe(true);

    const third = await connector.discover(second.checkpoint);
    expect(third.items).toHaveLength(3);
    expect(third.hasMore).toBe(false);

    expect(calls.map((call) => `${call.shiftType}:${call.page}`)).toEqual([
      "1:1",
      "1:2",
      "2:1",
    ]);
  });

  it("resumes inside a shard from a checkpoint cursor", async () => {
    const { client, calls } = pagedClient({ "1": 45 });
    const connector = createWerkNlConnector({ bronId: "bron-test", client });
    const first = await connector.discover(null);
    const second = await connector.discover(first.checkpoint);
    const third = await connector.discover(second.checkpoint);
    expect(third.items).toHaveLength(5);
    expect(third.hasMore).toBe(true);
    const fourth = await connector.discover(third.checkpoint);
    expect(fourth.hasMore).toBe(false);
    expect(calls).toHaveLength(4);
  });

  it("reports truncated when pageLimitPerShard stops a shard early", async () => {
    const { client } = pagedClient({ "1": 100, "2": 40 });
    const connector = createWerkNlConnector({
      bronId: "bron-test",
      client,
      pageLimitPerShard: 1,
    });
    const first = await connector.discover(null);
    expect(first.hasMore).toBe(true);
    const second = await connector.discover(first.checkpoint);
    expect(second.hasMore).toBe(false);
    expect(second.truncated).toBe(true);
  });

  it("flags truncated when a shard ends on an anomalous empty page", async () => {
    const { client } = pagedClient({ "1": 40, "2": 0 });
    const inner = client.fetchListing;
    client.fetchListing = (page, shiftType) =>
      shiftType === "1" && page === 2
        ? Promise.resolve({ facets: [], items: [], totalResults: 40 })
        : inner(page, shiftType);
    const connector = createWerkNlConnector({ bronId: "bron-test", client });

    const first = await connector.discover(null);
    expect(first.hasMore).toBe(true);
    const second = await connector.discover(first.checkpoint);
    // Page 2 comes back empty while upstream still claims 2 pages: the shard
    // ends, but truncation propagates so the run never reads "complete".
    expect(second.items).toHaveLength(0);
    expect(second.hasMore).toBe(true);
    const third = await connector.discover(second.checkpoint);
    expect(third.hasMore).toBe(false);
    expect(third.truncated).toBe(true);
  });

  it("ends the sweep on a cursor past the last shard instead of recrawling", async () => {
    const { client, calls } = pagedClient({ "1": 40 });
    const connector = createWerkNlConnector({ bronId: "bron-test", client });
    const result = await connector.discover({
      cursor: 'werk-nl:{"s":5,"p":1}',
    });
    expect(result.hasMore).toBe(false);
    expect(result.items).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("serves fixture items once for the first shard only", async () => {
    const connector = createWerkNlConnector({
      bronId: "bron-test",
      client: createWerkNlClient({ liveEnabled: false }),
    });
    const first = await connector.discover(null);
    expect(first.items).toHaveLength(2);
    const second = await connector.discover(first.checkpoint);
    expect(second.items).toHaveLength(0);
    expect(second.hasMore).toBe(false);
  });

  it("rejects a detail that 404s — removed at source (CTP-608)", async () => {
    const client: WerkNlClient = {
      fetchDetail: () =>
        Promise.reject(
          new HttpStatusError({
            slug: "werk-nl",
            status: 404,
            url: "https://www.werk.nl/vacature/42",
          })
        ),
      fetchListing: (page) =>
        Promise.resolve({
          facets: [],
          items: page === 1 ? [makeItem(42)] : [],
          totalResults: 1,
        }),
    };
    const connector = createWerkNlConnector({
      bronId: "bron-test",
      client,
      shardValues: ["1"],
    });
    const { items } = await connector.discover(null);
    const [item] = items;
    if (!item) {
      throw new Error("expected one discover item");
    }
    const fetched = await connector.fetch(item);
    expect(fetched?.status).toBe("rejected");
  });

  it("rejects a detail that 410s — gone at source (CTP-608)", async () => {
    const client: WerkNlClient = {
      fetchDetail: () =>
        Promise.reject(
          new HttpStatusError({
            slug: "werk-nl",
            status: 410,
            url: "https://www.werk.nl/vacature/42",
          })
        ),
      fetchListing: (page) =>
        Promise.resolve({
          facets: [],
          items: page === 1 ? [makeItem(42)] : [],
          totalResults: 1,
        }),
    };
    const connector = createWerkNlConnector({
      bronId: "bron-test",
      client,
      shardValues: ["1"],
    });
    const { items } = await connector.discover(null);
    const [item] = items;
    if (!item) {
      throw new Error("expected one discover item");
    }
    const fetched = await connector.fetch(item);
    expect(fetched?.status).toBe("rejected");
  });

  it("propagates non-404 detail errors instead of rejecting them", async () => {
    const client: WerkNlClient = {
      fetchDetail: () =>
        Promise.reject(
          new HttpStatusError({
            slug: "werk-nl",
            status: 500,
            url: "https://www.werk.nl/vacature/42",
          })
        ),
      fetchListing: (page) =>
        Promise.resolve({
          facets: [],
          items: page === 1 ? [makeItem(42)] : [],
          totalResults: 1,
        }),
    };
    const connector = createWerkNlConnector({
      bronId: "bron-test",
      client,
      shardValues: ["1"],
    });
    const { items } = await connector.discover(null);
    const [item] = items;
    if (!item) {
      throw new Error("expected one discover item");
    }
    await expect(connector.fetch(item)).rejects.toThrow("status 500");
  });

  it("fetches a detail payload keyed by referenceNumber", async () => {
    const connector = createWerkNlConnector({
      bronId: "bron-test",
      client: createWerkNlClient({ liveEnabled: false }),
      shardValues: ["1"],
    });
    const discovered = await connector.discover(null);
    const [item] = discovered.items;
    if (!item) {
      throw new Error("expected one discover item");
    }
    const fetched = await connector.fetch(item);
    expect(fetched?.status).toBe("fetched");
    if (fetched?.status !== "fetched") {
      throw new Error("expected fetched result");
    }
    expect(fetched.bronReferentie).toBe("56790376");
    // SAFETY: the connector serialises WerkNlFetchedPayload; only the
    // referenceNumber shape is inspected here.
    const payload = JSON.parse(new TextDecoder().decode(fetched.body)) as {
      referenceNumber: unknown;
      detail: { title: string };
    };
    expect(payload.referenceNumber).toBe("56790376");
    expect(payload.detail.title).toBe("Verzorgende Thuiszorg");
  });
});
