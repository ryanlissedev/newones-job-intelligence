import { afterEach, describe, expect, it } from "bun:test";

import { JOB_INTELLIGENCE_USER_AGENT } from "@ji/connectors";

import { SOURCES } from "./index";

const BROWSER_LIKE = /Mozilla\/\d|Chrome\/\d|AppleWebKit|Safari\/\d|Gecko\//u;
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * Runtime guard: every registered source, switched live, issues its first
 * request (listing, and detail where a synthetic item reaches the network)
 * with the shared honest User-Agent — never the runtime
 * default (`Bun/x.y`), never a browser string, never a Cookie. Responses are
 * stubbed (no network); the connector is expected to fail on the stub body,
 * only the outgoing headers matter.
 */
describe("every source sends the shared User-Agent on live discover and fetch", () => {
  for (const source of Object.values(SOURCES)) {
    it(`${source.slug}`, async () => {
      const seen: Headers[] = [];
      globalThis.fetch = Object.assign(
        (input: string | URL | Request, init?: RequestInit) => {
          seen.push(
            new Headers(
              init?.headers ??
                (input instanceof Request ? input.headers : undefined)
            )
          );
          return Promise.resolve(
            new Response("{}", {
              headers: { "content-type": "application/json" },
              status: 200,
            })
          );
        },
        { preconnect: () => {} }
      );
      const previous = process.env[source.liveEnv];
      process.env[source.liveEnv] = "1";
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 5000);
      try {
        const connector = source.createConnector({
          bronId: source.bronId,
          live: true,
          runKind: "test",
        });
        await connector.discover(null, abort.signal).catch(() => null);
        // Detail path: a synthetic item; connectors that need a real listing
        // payload reject before any request, the rest must still send the UA.
        await connector
          .fetch(
            {
              bronReferentie: "ua-guard-1",
              contentHash: "0",
              listingPayload: {},
            },
            abort.signal
          )
          .catch(() => null);
      } finally {
        clearTimeout(timer);
        if (previous === undefined) {
          Reflect.deleteProperty(process.env, source.liveEnv);
        } else {
          process.env[source.liveEnv] = previous;
        }
      }
      expect(seen.length).toBeGreaterThan(0);
      for (const headers of seen) {
        expect(headers.get("User-Agent")).toBe(JOB_INTELLIGENCE_USER_AGENT);
        expect(headers.get("User-Agent") ?? "").not.toMatch(BROWSER_LIKE);
        expect(headers.get("Cookie")).toBeNull();
      }
    });
  }
});
