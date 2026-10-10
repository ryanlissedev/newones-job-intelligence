import { afterEach, describe, expect, it } from "bun:test";

import { SEARCH_INDEX_NAME } from "../types";
import { buildManticoreSearchRequest } from "./client";
import {
  describeManticoreTableViaEffect,
  FetchManticoreEffectClient,
} from "./client-effect";
import { ManticoreTimeoutError } from "./timeout-error";

const okSearchBody = {
  hits: { hits: [{ _id: "1", _score: 1 }], total: 1 },
};

const okShowTablesBody = [{ data: [{ Index: "jobs_active", Type: "rt" }] }];

// Bridging AbortSignal into a never-resolving fetch requires `new Promise`
// — same rationale as limits.spec.ts hangingFetch. Rejects with
// `signal.reason` exactly like a real fetch, so a merged signal that drops
// the TimeoutError reason fails this spec instead of passing by accident.
const hangingFetch = (
  _url: string | URL | Request,
  init?: RequestInit
): Promise<Response> =>
  // oxlint-disable-next-line promise/avoid-new -- bridges AbortSignal into fetch() rejection for hung Manticore
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    signal?.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });

type JsonStubBody =
  | typeof okSearchBody
  | typeof okShowTablesBody
  | {
      current_line: number;
      error: string;
      errors: boolean;
    };

const jsonFetch =
  (body: JsonStubBody, status = 200) =>
  (_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
    Promise.resolve(Response.json(body, { status }));

describe("FetchManticoreEffectClient", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("posts the search request once and returns the parsed payload", async () => {
    let calls = 0;
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    // SAFETY: stub only exercises the (url, init) call shape the client uses.
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      calls += 1;
      seenUrl = url;
      seenInit = init;
      return jsonFetch(okSearchBody)(url, init);
    }) as typeof fetch;

    const client = new FetchManticoreEffectClient("http://manticore.effect");
    const request = buildManticoreSearchRequest(
      SEARCH_INDEX_NAME,
      null,
      {},
      20,
      0
    );
    const payload = await client.request("/search", request);

    expect(calls).toBe(1);
    expect(seenUrl).toBe("http://manticore.effect/search");
    expect(seenInit?.method).toBe("POST");
    expect(seenInit?.body).toBe(JSON.stringify(request));
    expect(payload.hits?.hits).toEqual([{ _id: "1", _score: 1 }]);
  });

  it("surfaces a hung fetch as ManticoreTimeoutError", async () => {
    // SAFETY: hangingFetch matches fetch's call signature (url, init).
    globalThis.fetch = hangingFetch as typeof fetch;
    const client = new FetchManticoreEffectClient(
      "http://manticore.invalid",
      5
    );
    const request = buildManticoreSearchRequest(
      SEARCH_INDEX_NAME,
      null,
      {},
      20,
      0
    );
    await expect(client.request("/search", request)).rejects.toBeInstanceOf(
      ManticoreTimeoutError
    );
  });

  it("honours per-request timeoutMs over the client default", async () => {
    // SAFETY: hangingFetch matches fetch's call signature (url, init).
    globalThis.fetch = hangingFetch as typeof fetch;
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
  });

  it("returns the bulk JSON body on HTTP 500 instead of throwing", async () => {
    const failingBulk = {
      current_line: 1,
      error: "duplicate id",
      errors: true,
    };
    // SAFETY: stub only exercises the (url, init) call shape the client uses.
    globalThis.fetch = jsonFetch(failingBulk, 500) as typeof fetch;
    const client = new FetchManticoreEffectClient("http://manticore.bulk");
    const lines = [
      JSON.stringify({
        replace: { id: 1, index: "jobs_active" },
      }),
    ];
    const payload = await client.bulk(lines);
    expect(payload.errors).toBe(true);
    expect(payload.error).toBe("duplicate id");
    expect(payload.current_line).toBe(1);
  });

  it("cancels an in-flight request through the outer AbortSignal", async () => {
    const controller = new AbortController();
    const client = new FetchManticoreEffectClient(
      "http://manticore.cancel",
      5000,
      {
        fetchImpl: hangingFetch,
        signal: controller.signal,
      }
    );
    const request = client.request("/search", {
      index: "x",
      limit: 0,
      max_matches: 1,
      max_query_time: 1,
      offset: 0,
      sort: [],
      track_total_hits: true,
    });
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects when the outer AbortSignal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new FetchManticoreEffectClient(
      "http://manticore.cancel",
      5000,
      {
        fetchImpl: jsonFetch(okSearchBody),
        signal: controller.signal,
      }
    );
    await expect(
      client.request("/search", {
        index: "x",
        limit: 0,
        max_matches: 1,
        max_query_time: 1,
        offset: 0,
        sort: [],
        track_total_hits: true,
      })
    ).rejects.toBeTruthy();
  });
});

describe("describeManticoreTableViaEffect", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("reports a listed table as existing", async () => {
    // SAFETY: stub only exercises the (url, init) call shape the client uses.
    globalThis.fetch = jsonFetch(okShowTablesBody) as typeof fetch;
    const info = await describeManticoreTableViaEffect(
      "http://manticore.sql",
      "jobs_active"
    );
    expect(info).toEqual({ exists: true });
  });
});
