import { afterEach, describe, expect, it } from "bun:test";

import { SEARCH_INDEX_NAME } from "../types";
import {
  buildManticoreSearchRequest,
  ManticoreTimeoutError,
  parseManticoreSearchResponse,
} from "./client";
import { FetchManticoreEffectClient } from "./client-effect";

// Simulates a Manticore process that never responds: the returned promise
// only settles when the caller's AbortSignal fires, exactly like a real hung
// fetch would once the runtime aborts it. Bridging the event-based
// AbortSignal into a promise requires `new Promise` here — there is no
// existing promise to await instead, since the whole point is to emulate
// one that never resolves on its own.
const hangingFetch = (_url: string, init?: RequestInit): Promise<Response> =>
  // oxlint-disable-next-line promise/avoid-new -- bridges the event-based AbortSignal into the fetch() rejection a real hung request would produce
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    signal?.addEventListener("abort", () => reject(signal.reason));
  });

const fastFetch = (_url: string, _init?: RequestInit): Promise<Response> =>
  Promise.resolve(
    Response.json({
      hits: { hits: [{ _id: "doc-1", _score: 1 }], total: 1 },
    })
  );

// RJC-380: Manticore search queries previously had no upper bound on cost
// (no max_matches / max_query_time) and no way to abort a hung fetch. These
// specs cover the three claims from that fix: bounds are present on every
// built request, a timed-out fetch surfaces as a distinguishable error
// rather than looking like an empty result, and a normal (fast, healthy)
// query is unaffected by the new transport plumbing.
describe("Manticore query bounds (RJC-380)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("carries max_matches and max_query_time on every built search request", () => {
    const request = buildManticoreSearchRequest(
      SEARCH_INDEX_NAME,
      null,
      {},
      20,
      0
    );

    expect(request.max_matches).toBeGreaterThan(0);
    expect(request.max_query_time).toBeGreaterThan(0);
    // Bounds must be able to satisfy the request's own limit/offset, or
    // legitimate pagination would silently come back empty.
    expect(request.max_matches).toBeGreaterThanOrEqual(
      request.limit + request.offset
    );
  });

  it("surfaces a hung fetch as ManticoreTimeoutError, not an empty result", async () => {
    // SAFETY: hangingFetch matches fetch's call signature (url, init) and
    // return type (Promise<Response>); it never needs the rest of the
    // global fetch overload set this test doesn't exercise.
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

    let caught: unknown;
    try {
      await client.request("/search", request);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ManticoreTimeoutError);
    // Guard against the failure mode this test exists to catch: a timeout
    // must never be mistaken for "zero hits found".
    expect(caught).not.toEqual({ hits: [], total: 0 });
  });

  it("flags a query that hit max_query_time so 0 hits isn't read as a real empty result", () => {
    const response = parseManticoreSearchResponse({
      hits: { hits: [], total: 0 },
      timed_out: true,
    });

    expect(response.total).toBe(0);
    // Must not be indistinguishable from "empty_index" or a genuine
    // zero-match query — those are handled by engine.ts, but only if the
    // client surfaces a reason at all.
    expect(response.emptyReason).toBe("query_timeout");
  });

  it("leaves a normal, fast query unaffected", async () => {
    // SAFETY: fastFetch matches fetch's call signature (url, init) and
    // return type (Promise<Response>); it never needs the rest of the
    // global fetch overload set this test doesn't exercise.
    globalThis.fetch = fastFetch as typeof fetch;

    const client = new FetchManticoreEffectClient("http://manticore.local");
    const request = buildManticoreSearchRequest(
      SEARCH_INDEX_NAME,
      null,
      {},
      20,
      0
    );

    const payload = await client.request("/search", request);
    expect(payload.hits?.total).toBe(1);
  });
});
