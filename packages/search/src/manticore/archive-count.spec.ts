import { describe, expect, it } from "bun:test";
import { once } from "node:events";

import { InMemorySearchVersionStore } from "../version";
import type { ManticoreHttpClient, ManticoreRequestOptions } from "./client";
import { ARCHIVE_COUNT_TIMEOUT_MS } from "./client";
import { FetchManticoreEffectClient } from "./client-effect";
import { ManticoreSearchEngine } from "./engine";
import type {
  ManticoreBulkPayload,
  ManticoreRequestBody,
  ManticoreSearchPayload,
} from "./json";
import { ManticoreTimeoutError } from "./timeout-error";

type CountBehaviour = "hang" | "ok" | "reject";

/** Search requests succeed; the archive count (limit 0) behaves as scripted. */
const countScriptedClient = (behaviour: CountBehaviour) => {
  const countOptions: ManticoreRequestOptions[] = [];
  const client: ManticoreHttpClient = {
    bulk: (): Promise<ManticoreBulkPayload> =>
      Promise.resolve({ errors: false }),
    request: (
      _path: string,
      body: ManticoreRequestBody,
      options: ManticoreRequestOptions = {}
    ): Promise<ManticoreSearchPayload> => {
      const isCount = "limit" in body && body.limit === 0;
      if (!isCount) {
        return Promise.resolve({
          hits: { hits: [{ _source: { document_id: "doc-1" } }], total: 1 },
        });
      }
      countOptions.push(options);
      switch (behaviour) {
        case "ok": {
          return Promise.resolve({ hits: { hits: [], total: 7 } });
        }
        case "reject": {
          return Promise.reject(new Error("archive table exploded"));
        }
        default: {
          // Honour the budget the engine hands over, like the real client.
          return Bun.sleep(options.timeoutMs ?? 60_000).then(() => {
            throw new ManticoreTimeoutError("/search", options.timeoutMs ?? 0);
          });
        }
      }
    },
  };
  return { client, countOptions };
};

const hangUntilAborted = async (
  _input: string | URL | Request,
  init?: RequestInit
): Promise<Response> => {
  if (!init?.signal) {
    throw new Error("request must carry an AbortSignal");
  }
  await once(init.signal, "abort");
  throw new DOMException("timed out", "TimeoutError");
};

const search = (client: ManticoreHttpClient) =>
  new ManticoreSearchEngine(client, new InMemorySearchVersionStore()).search({
    ast: null,
    filters: {},
    limit: 10,
    offset: 0,
  });

describe("archive count degrades, never fails the search (RJC-383)", () => {
  it("count succeeds → archiveTotal is the number", async () => {
    const result = await search(countScriptedClient("ok").client);
    expect(result.hits.map((hit) => hit.id)).toEqual(["doc-1"]);
    expect(result.archiveTotal).toBe(7);
    expect(result.emptyReason).toBeUndefined();
  });

  it("count rejects → search resolves with archiveTotal null and emptyReason untouched", async () => {
    const result = await search(countScriptedClient("reject").client);
    expect(result.hits.map((hit) => hit.id)).toEqual(["doc-1"]);
    expect(result.total).toBe(1);
    expect(result.archiveTotal).toBeNull();
    expect(result.emptyReason).toBeUndefined();
  });

  it("count hangs → the engine's own budget cuts it and the search resolves within it", async () => {
    const { client, countOptions } = countScriptedClient("hang");
    const started = performance.now();
    const result = await search(client);
    const elapsed = performance.now() - started;
    expect(result.archiveTotal).toBeNull();
    expect(result.hits).toHaveLength(1);
    expect(countOptions).toEqual([{ timeoutMs: ARCHIVE_COUNT_TIMEOUT_MS }]);
    // Well inside the 8s search transport budget.
    expect(elapsed).toBeLessThan(ARCHIVE_COUNT_TIMEOUT_MS + 500);
  });

  it("scope all issues no count at all", async () => {
    const { client, countOptions } = countScriptedClient("reject");
    const result = await new ManticoreSearchEngine(
      client,
      new InMemorySearchVersionStore()
    ).search({ ast: null, filters: {}, limit: 10, offset: 0, scope: "all" });
    expect(result.archiveTotal).toBeUndefined();
    expect(countOptions).toEqual([]);
  });
});

describe("FetchManticoreEffectClient per-request timeout", () => {
  it("aborts a hanging fetch at the request's own timeoutMs, not the client default", async () => {
    const originalFetch = globalThis.fetch;
    // SAFETY: the test only exercises the (input, init) call shape the client uses; fetch's static members are never touched.
    globalThis.fetch = hangUntilAborted as typeof fetch;
    try {
      const client = new FetchManticoreEffectClient(
        "http://manticore.test",
        60_000
      );
      const started = performance.now();
      await expect(
        client.request(
          "/search",
          {
            index: "x",
            limit: 0,
            max_matches: 1,
            max_query_time: 1,
            offset: 0,
            sort: [],
            track_total_hits: true,
          },
          { timeoutMs: 20 }
        )
      ).rejects.toBeInstanceOf(ManticoreTimeoutError);
      expect(performance.now() - started).toBeLessThan(1000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
