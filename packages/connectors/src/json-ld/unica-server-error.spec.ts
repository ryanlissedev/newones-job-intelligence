import { describe, expect, it } from "bun:test";

import {
  CrawlDelayLimiter,
  InMemoryObjectStore,
  InMemoryObservationRecorder,
  InMemoryRunLifecycleStore,
  runConnector,
} from "@ji/connectors";

import { loadConnectorFixture } from "../fixtures/load";
import { createJsonLdClient } from "./client";
import { unicaConfig } from "./configs/unica";
import { createJsonLdConnector } from "./connector";
import type { JsonLdConnectorConfig } from "./types";

const UNICA_BRON_ID = "00000000-0000-4000-8000-00000000001f";
const SITEMAP_URL = "https://www.werkenbijunica.nl/sitemap.xml";
const HEALTHY_URL =
  "https://www.werkenbijunica.nl/vacatures/accountmanager-venray-aqkcmj2yd4e-nszi";
const FLAKY_URL =
  "https://www.werkenbijunica.nl/vacatures/energie-manager-moordrecht-aqkwugvvvcgghbf0";
// The URL that answered HTTP 500 on every request on 6 Oct 2026.
const BROKEN_URL =
  "https://www.werkenbijunica.nl/vacatures/technisch-administratief-medewerker-goes-amstgehjgo1zm6l";

const sitemap = (urls: readonly string[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls
    .map((url) => `<url><loc>${url}</loc></url>`)
    .join("")}</urlset>`;

const SERVER_ERROR_PAGE =
  "<!DOCTYPE html><html><head><title>Server Error</title></head><body>500 | Server Error</body></html>";

/** The client takes `typeof fetch`; a stub only needs the call signature. */
const asFetch = (
  respond: (input: Request | string | URL) => Promise<Response>
): typeof fetch => Object.assign(respond, { preconnect: fetch.preconnect });

const detailHtml = async (relativePath: string): Promise<string> => {
  const fixture = await loadConnectorFixture<string>(relativePath);
  return fixture.payload;
};

interface UpstreamScript {
  readonly urls: readonly string[];
  /** Per detail URL: how many leading requests answer 500 (Infinity = always). */
  readonly failuresBefore200: Readonly<Record<string, number>>;
}

const scriptedUpstream = async (script: UpstreamScript) => {
  const bodies = new Map([
    [
      FLAKY_URL,
      await detailHtml("unica/detail-energie-manager-moordrecht.json"),
    ],
    [HEALTHY_URL, await detailHtml("unica/detail-accountmanager-venray.json")],
  ]);
  const requests: string[] = [];
  const respond = (input: Request | string | URL): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push(url);
    if (url === SITEMAP_URL) {
      return Promise.resolve(new Response(sitemap(script.urls)));
    }
    const failures = script.failuresBefore200[url] ?? 0;
    const seen = requests.filter((requested) => requested === url).length;
    if (seen <= failures) {
      return Promise.resolve(new Response(SERVER_ERROR_PAGE, { status: 500 }));
    }
    const body = bodies.get(url);
    return Promise.resolve(
      body === undefined
        ? new Response("not found", { status: 404 })
        : new Response(body, { headers: { "content-type": "text/html" } })
    );
  };
  return { fetchImpl: asFetch(respond), requests };
};

const noBackoff = (
  overrides: Partial<
    NonNullable<JsonLdConnectorConfig["detailServerErrorPolicy"]>
  > = {}
): JsonLdConnectorConfig => ({
  ...unicaConfig,
  detailServerErrorPolicy: {
    attempts: 3,
    initialDelayMs: 0,
    maxRejectedPerRun: 10,
    ...overrides,
  },
});

const runUnica = async (
  config: JsonLdConnectorConfig,
  script: UpstreamScript
) => {
  const upstream = await scriptedUpstream(script);
  const run = runConnector({
    bronId: UNICA_BRON_ID,
    bronSlug: "unica",
    checkpoint: null,
    connector: createJsonLdConnector({
      bronId: UNICA_BRON_ID,
      client: createJsonLdClient({
        config,
        fetchImpl: upstream.fetchImpl,
        liveEnabled: true,
      }),
      config,
    }),
    limiter: new CrawlDelayLimiter({ crawlDelayMs: 0 }),
    objectStore: new InMemoryObjectStore(),
    observationRecorder: new InMemoryObservationRecorder(),
    rawRetentionDays: 90,
    retryPolicy: {
      initialDelayMs: 0,
      jitter: (delayMs: number) => delayMs,
      maxAttempts: 1,
      maxDelayMs: 0,
      multiplier: 1,
    },
    runKind: "test",
    runLifecycleStore: new InMemoryRunLifecycleStore(),
    scrapeRunId: "run-unica-5xx",
    startedAt: new Date("2026-10-06T08:00:00.000Z"),
  });
  return { requests: upstream.requests, run };
};

describe("Unica detail pages answering HTTP 5xx", () => {
  it("retries a transient 500 with backoff and keeps the vacancy", async () => {
    const { requests, run } = await runUnica(noBackoff(), {
      failuresBefore200: { [FLAKY_URL]: 2 },
      urls: [HEALTHY_URL, FLAKY_URL],
    });
    const result = await run;
    expect(result.metrics).toMatchObject({ new: 2, rejected: 0 });
    expect(requests.filter((url) => url === FLAKY_URL)).toHaveLength(3);
  });

  it("rejects a page that keeps answering 500 instead of failing the run", async () => {
    const { requests, run } = await runUnica(noBackoff(), {
      failuresBefore200: { [BROKEN_URL]: Number.POSITIVE_INFINITY },
      urls: [HEALTHY_URL, BROKEN_URL, FLAKY_URL],
    });
    const result = await run;
    expect(result.completeness).toEqual({ complete: true });
    expect(result.metrics).toMatchObject({ found: 3, new: 2, rejected: 1 });
    expect(requests.filter((url) => url === BROKEN_URL)).toHaveLength(3);
    // Still listed by the source, so missed-poll reconciliation keeps it.
    expect(result.observedBronReferenties).toContain(
      "vacatures/technisch-administratief-medewerker-goes-amstgehjgo1zm6l"
    );
  });

  it("fails the run once more pages fail than an outage ceiling allows", async () => {
    const { run } = await runUnica(noBackoff({ maxRejectedPerRun: 1 }), {
      failuresBefore200: {
        [BROKEN_URL]: Number.POSITIVE_INFINITY,
        [FLAKY_URL]: Number.POSITIVE_INFINITY,
      },
      urls: [BROKEN_URL, FLAKY_URL, HEALTHY_URL],
    });
    // The run-level ConnectorRunFailure the poller logged for Unica.
    await expect(run).rejects.toThrow("Connector fetch failed");
  });

  it("still fails the run when the sitemap itself answers 500", async () => {
    const config = noBackoff();
    const client = createJsonLdClient({
      config,
      fetchImpl: asFetch(() =>
        Promise.resolve(new Response(SERVER_ERROR_PAGE, { status: 500 }))
      ),
      liveEnabled: true,
    });
    await expect(client.fetchListing()).rejects.toThrow("status 500");
  });

  it("ships Unica with 1 s / 2 s backoff and a 10-page outage ceiling", () => {
    expect(unicaConfig.detailServerErrorPolicy).toEqual({
      attempts: 3,
      initialDelayMs: 1000,
      maxRejectedPerRun: 10,
    });
  });
});
