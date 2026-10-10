import { describe, expect, it } from "bun:test";

import {
  CrawlDelayLimiter,
  InMemoryObjectStore,
  InMemoryObservationRecorder,
  InMemoryRunLifecycleStore,
  runConnector,
} from "@ji/connectors";

import {
  createHarveyNashClient,
  harveyNashBronReferentie,
  harveyNashEindklant,
  resolveHarveyNashDetailUrl,
} from "./client";
import type { HarveyNashClient } from "./client";
import {
  createHarveyNashConnector,
  HARVEYNASH_MAX_DISCOVER_PAGES,
} from "./connector";
import type { HarveyNashFetchedPayload, HarveyNashSearchItem } from "./types";

const retryPolicy = {
  initialDelayMs: 0,
  jitter: (delayMs: number) => delayMs,
  maxAttempts: 1,
  maxDelayMs: 0,
  multiplier: 1,
};

describe("Harvey Nash listing helpers", () => {
  it("prefers the Bullhorn job id over the BBBH reference for bronReferentie", () => {
    expect(
      harveyNashBronReferentie({ external_reference: "BBBH1", id: "42" })
    ).toBe("42");
    expect(harveyNashBronReferentie({ external_reference: "BBBH1" })).toBe(
      "BBBH1"
    );
    expect(harveyNashBronReferentie({})).toBe("");
  });

  it("reads the eindklant from the real Clients category shape", () => {
    expect(
      harveyNashEindklant({
        categories: [{ name: "Clients", values: [{ name: "Politie" }] }],
      })
    ).toBe("Politie");
    expect(harveyNashEindklant({})).toBeUndefined();
    // Real capture 2026-08-31: not every posting carries a Clients category.
    expect(
      harveyNashEindklant({
        categories: [{ name: "Functie categorie", values: [{ name: "IT" }] }],
      })
    ).toBeUndefined();
  });

  it("resolves the detail url from a real url_slug against the base url", () => {
    expect(resolveHarveyNashDetailUrl("298852-Endpoints-specialist-")).toBe(
      "https://www.harveynash.nl/vacatures/298852-Endpoints-specialist-"
    );
    expect(resolveHarveyNashDetailUrl()).toBeUndefined();
  });
});

const WHITESPACE_DETAIL_HTML = `<!doctype html><html lang="nl"><head>
<script type="application/ld+json">{"@type":"JobPosting","title":"Whitespace Role"}</script>
</head><body>
<div class="job-informations">
  <div>
    <div class="post-info-title extra-class">
      Locatie:
    </div>

    <div
      class="foo post-info-content bar"
      data-testid="locatie"
    >
      <span>Amsterdam</span>
    </div>
  </div>
  <div>
    <div class="post-info-title">Salaris:</div>
    <div class="post-info-content">Max tarief 90 all-in</div>
  </div>
</div>
</body></html>`;

/** SAFETY: only the (url) => Promise<Response> shape client.ts actually
 * calls is exercised in these tests; Bun's `typeof fetch` also requires a
 * `preconnect` static that a test double has no use for, so it's stubbed
 * here once rather than asserted away at each call site. */
const stubFetch = (html: string): typeof fetch =>
  Object.assign(() => Promise.resolve(new Response(html)), {
    preconnect: () => {
      // no-op: test double doesn't need real preconnect behaviour
    },
  }) as typeof fetch;

describe("Harvey Nash detail parsing tolerates markup variation", () => {
  it("parses post-info pairs across whitespace, newlines, extra classes and extra attributes", async () => {
    const client = createHarveyNashClient({
      fetchImpl: stubFetch(WHITESPACE_DETAIL_HTML),
      liveEnabled: true,
    });
    const fragment = await client.fetchDetail(
      "any-id",
      "https://www.harveynash.nl/vacatures/any-id"
    );
    expect(fragment.facts.locatie).toBe("Amsterdam");
    expect(fragment.facts.richttarief).toBe("Max tarief 90 all-in");
  });
});

describe("Harvey Nash connector", () => {
  it("ingests the real listing fixture with found/new/changed/rejected/error metrics", async () => {
    const bronId = "bron-harveynash-fixture";
    const result = await runConnector({
      bronId,
      bronSlug: "harveynash",
      checkpoint: null,
      connector: createHarveyNashConnector({
        bronId,
        client: createHarveyNashClient({ liveEnabled: false }),
      }),
      limiter: new CrawlDelayLimiter({ crawlDelayMs: 0 }),
      objectStore: new InMemoryObjectStore(),
      observationRecorder: new InMemoryObservationRecorder(),
      rawRetentionDays: 90,
      retryPolicy,
      runKind: "test",
      runLifecycleStore: new InMemoryRunLifecycleStore(),
      scrapeRunId: "run-hn-1",
      startedAt: new Date("2026-08-31T11:20:00.000Z"),
    });

    expect(result.metrics).toMatchObject({
      changed: 0,
      error: 0,
      found: 1,
      new: 1,
      rejected: 0,
    });
  });

  it("parses the real SSR detail page into a typed payload for the fetch target", async () => {
    const bronId = "bron-harveynash-detail";
    const connector = createHarveyNashConnector({
      bronId,
      client: createHarveyNashClient({ liveEnabled: false }),
    });
    const discovered = await connector.discover(null);
    const [target] = discovered.items;
    if (!target) {
      throw new Error("expected the fixture job in discovered items");
    }
    expect(target.bronReferentie).toBe("452d25a3-ae7d-4ee6-9ceb-3c696332799f");
    const fetched = await connector.fetch(target);
    expect(fetched?.status).toBe("fetched");
    if (fetched?.status !== "fetched") {
      throw new Error("expected fetched result");
    }
    // SAFETY: the connector serialises HarveyNashFetchedPayload; only the
    // detail shape asserted below is inspected here.
    const payload = JSON.parse(
      new TextDecoder().decode(fetched.body)
    ) as HarveyNashFetchedPayload;

    expect(payload.detail.jobId).toBe("452d25a3-ae7d-4ee6-9ceb-3c696332799f");
    expect(payload.detail.reference).toBe("BBBH121494_1788161094");
    expect(payload.detail.eindklant).toBe("Politie");
    expect(payload.detail.facts.locatie).toBe("Bunnik , Utrecht");
    expect(payload.detail.facts.richttarief).toBe(
      "Max tarief 106.50 euro all-in exclusief btw"
    );
    expect(payload.detail.facts.jobRef).toBe("BBBH121494_1788161094");
    expect(payload.detail.facts.deadline).toBe("04-09 om 09:00");
    expect(payload.detail.facts.uren).toBe("36");
    expect(payload.detail.facts.start).toContain("01-11-2026");
    expect(payload.detail.jsonLd.datePosted).toBe("2026-08-31T07:24:55.419Z");
    expect(payload.detail.jsonLd.validThrough).toBe("2026-09-07T23:59:59.999Z");
    expect(payload.detail.jsonLd.description).toContain(
      "Voor onze eindklant Politie"
    );
    expect(payload.detail.jsonLd).not.toHaveProperty("baseSalary");
    expect(payload.detail.url).toBe(
      "https://www.harveynash.nl/vacatures/298852-Endpoints-specialist-"
    );
  });

  it("rejects a listing row missing a detail url slug", async () => {
    const bronId = "bron-harveynash-missing-url";
    const client: HarveyNashClient = {
      fetchDetail: () => {
        throw new Error("fetchDetail should not be called");
      },
      fetchListing: () =>
        Promise.resolve({
          results: [
            {
              job: {
                external_reference: "BBBH999",
                id: "hn-no-url",
                title: "Missing Url Role",
              } satisfies HarveyNashSearchItem,
            },
          ],
          total_size: 1,
        }),
    };
    const connector = createHarveyNashConnector({ bronId, client });
    const discovered = await connector.discover(null);
    const [item] = discovered.items;
    if (!item) {
      throw new Error("expected one discover item");
    }
    const fetched = await connector.fetch(item);
    expect(fetched?.status).toBe("rejected");
  });

  it("replays fixture ingest without duplicate source records", async () => {
    const bronId = "bron-harveynash-replay";
    const recorder = new InMemoryObservationRecorder();
    const objectStore = new InMemoryObjectStore();
    const connector = createHarveyNashConnector({
      bronId,
      client: createHarveyNashClient({ liveEnabled: false }),
    });
    const sharedInput = {
      bronId,
      bronSlug: "harveynash" as const,
      checkpoint: null,
      connector,
      limiter: new CrawlDelayLimiter({ crawlDelayMs: 0 }),
      objectStore,
      observationRecorder: recorder,
      rawRetentionDays: 90,
      retryPolicy,
      runKind: "test" as const,
      runLifecycleStore: new InMemoryRunLifecycleStore(),
    };

    await runConnector({ ...sharedInput, scrapeRunId: "run-hn-replay-1" });
    await runConnector({ ...sharedInput, scrapeRunId: "run-hn-replay-2" });

    expect(recorder.records).toHaveLength(1);
    expect(
      new Set(recorder.records.map((record) => record.bronReferentie)).size
    ).toBe(1);
  });

  it("advances through listing pages until total_size is exhausted", async () => {
    const jobs: HarveyNashSearchItem[] = [
      { id: "HN-1", title: "One" },
      { id: "HN-2", title: "Two" },
      { id: "HN-3", title: "Three" },
      { id: "HN-4", title: "Four" },
    ];
    const client: HarveyNashClient = {
      fetchDetail: () => {
        throw new Error("fetchDetail should not be called during discover");
      },
      fetchListing: (page) => {
        if (page === 0) {
          return Promise.resolve({
            results: jobs.slice(0, 2).map((job) => ({ job })),
            total_size: 4,
          });
        }
        if (page === 1) {
          return Promise.resolve({
            results: jobs.slice(2, 4).map((job) => ({ job })),
            total_size: 4,
          });
        }
        return Promise.resolve({ results: [], total_size: 4 });
      },
    };
    const connector = createHarveyNashConnector({
      bronId: "bron-test",
      client,
    });
    const first = await connector.discover(null);
    expect(first.hasMore).toBe(true);
    expect(first.items).toHaveLength(2);

    const second = await connector.discover(first.checkpoint);
    expect(second.hasMore).toBe(false);
    expect(second.truncated).toBe(false);
    expect(second.items).toHaveLength(2);
  });

  it("reports truncated when the page cap stops the walk while total_size says there is more (RJC-397)", async () => {
    const client: HarveyNashClient = {
      fetchDetail: () => {
        throw new Error("fetchDetail should not be called during discover");
      },
      fetchListing: (page) =>
        Promise.resolve({
          results: [{ job: { id: `HN-CAP-${page}`, title: "Cap" } }],
          total_size: HARVEYNASH_MAX_DISCOVER_PAGES * 10,
        }),
    };
    const connector = createHarveyNashConnector({
      bronId: "bron-harveynash-cap",
      client,
    });

    const beforeCap = await connector.discover({
      page: HARVEYNASH_MAX_DISCOVER_PAGES - 2,
      pageSize: 1,
    });
    expect(beforeCap.hasMore).toBe(true);
    expect(beforeCap.truncated).toBe(false);

    const atCap = await connector.discover({
      page: HARVEYNASH_MAX_DISCOVER_PAGES - 1,
      pageSize: 1,
    });
    expect(atCap.hasMore).toBe(false);
    expect(atCap.truncated).toBe(true);
  });
});
