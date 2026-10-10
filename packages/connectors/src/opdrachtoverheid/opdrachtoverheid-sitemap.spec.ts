/* oxlint-disable eslint/require-await, no-await-in-loop, anti-slop/require-safety-comment-for-type-assertion -- source fetch doubles stay readable; listingPayload reads back what this spec supplied. */
import { describe, expect, it } from "bun:test";

import { loadConnectorFixture } from "../fixtures/load";
import { createOpdrachtoverheidClient } from "./client";
import type { OpdrachtoverheidClient } from "./client";
import { createOpdrachtoverheidEffectClient } from "./client-effect";
import { createOpdrachtoverheidConnector } from "./connector";
import {
  extractOpdrachtoverheidSsrTender,
  parseOpdrachtoverheidDetailPage,
  parseOpdrachtoverheidSitemap,
} from "./ssr";
import type { OpdrachtoverheidSitemapEntry } from "./ssr";
import type {
  OpdrachtoverheidFetchedPayload,
  OpdrachtoverheidTender,
} from "./types";

const SITEMAP_FIXTURE = "opdrachtoverheid/sitemap.json";
/** Three organisations that the private `/search` snapshot never returned
 * (it is ~99% one municipality, see CTP-601). */
const DETAIL_FIXTURES = {
  "4E70E935-2B6C-422E-83C7-7A9E3A810A99":
    "opdrachtoverheid/detail-rijkswaterstaat.json",
  "CDBDC0AD-E314-43D9-B1DC-30ABF7BD8BA2":
    "opdrachtoverheid/detail-alliander.json",
  "FF7A63BE-A728-4AAF-8681-E669A7723068":
    "opdrachtoverheid/detail-gemeente-rotterdam.json",
} as const;

const fixtureClientOptions = {
  detailFixturePaths: DETAIL_FIXTURES,
  liveEnabled: false,
  sitemapFixturePath: SITEMAP_FIXTURE,
} as const;

const entry = (
  organisatieSlug: string,
  webKey: string
): OpdrachtoverheidSitemapEntry => ({
  detailUrl: `https://www.opdrachtoverheid.nl/inhuuropdracht/${organisatieSlug}/titel/${webKey}`,
  organisatieSlug,
  webKey,
});

const ssrTender = (id: string, org: string): OpdrachtoverheidTender => ({
  tender_buying_organization: org,
  tender_id: id,
  tender_name: `Tender ${id}`,
  web_key: `WK-${id}`,
});

describe("Opdrachtoverheid sitemap parsing", () => {
  it("extracts only /inhuuropdracht/ entries with organisation slug and web_key", async () => {
    const fixture = await loadConnectorFixture<string>(SITEMAP_FIXTURE);
    const entries = parseOpdrachtoverheidSitemap(fixture.payload);

    expect(entries.map((item) => item.organisatieSlug)).toEqual([
      "alliander",
      "gemeente-rotterdam",
      "rijkswaterstaat",
    ]);
    expect(entries.map((item) => item.webKey)).toEqual([
      "CDBDC0AD-E314-43D9-B1DC-30ABF7BD8BA2",
      "FF7A63BE-A728-4AAF-8681-E669A7723068",
      "4E70E935-2B6C-422E-83C7-7A9E3A810A99",
    ]);
    expect(fixture.payload).toContain("/artikelen");
  });

  it("deduplicates web_keys and ignores malformed detail paths", () => {
    const xml = `<urlset>
      <url><loc>https://www.opdrachtoverheid.nl/inhuuropdracht/org-a/titel/KEY-1</loc></url>
      <url><loc>https://www.opdrachtoverheid.nl/inhuuropdracht/org-a/titel-2/KEY-1</loc></url>
      <url><loc>https://www.opdrachtoverheid.nl/inhuuropdracht/org-b/</loc></url>
      <url><loc>https://www.opdrachtoverheid.nl/inhuuropdracht/org-c/titel/KEY-2/extra</loc></url>
      <url><loc>not a url</loc></url>
      <url><loc>https://www.opdrachtoverheid.nl/organisaties/org-a</loc></url>
    </urlset>`;
    expect(parseOpdrachtoverheidSitemap(xml)).toEqual([
      entry("org-a", "KEY-1"),
    ]);
  });
});

describe("Opdrachtoverheid SSR detail parsing", () => {
  it("reads the tender record from #__NUXT_DATA__ and the JobPosting JSON-LD", async () => {
    const fixture = await loadConnectorFixture<string>(
      DETAIL_FIXTURES["FF7A63BE-A728-4AAF-8681-E669A7723068"]
    );
    const detailUrl =
      "https://www.opdrachtoverheid.nl/inhuuropdracht/gemeente-rotterdam/expert-objectgebonden-arbeidsomstandigheden-cluster-sb/FF7A63BE-A728-4AAF-8681-E669A7723068";
    const page = parseOpdrachtoverheidDetailPage(fixture.payload, detailUrl);

    expect(page.tender).toMatchObject({
      opdracht_overheid_url: detailUrl,
      tender_buying_organization: "Gemeente Rotterdam",
      tender_id: "mercell_gem_roterdam_0083881",
      tender_max_hours: 32,
      tender_maximum_tariff: 127,
      tender_min_hours: 24,
      tender_status: "open",
      web_key: "FF7A63BE-A728-4AAF-8681-E669A7723068",
    });
    expect(page.jobPosting).toMatchObject({
      "@type": "JobPosting",
      title: "Expert Objectgebonden Arbeidsomstandigheden - cluster SB",
    });
  });

  it("returns null when the page has no Nuxt payload or no vacancy", () => {
    expect(extractOpdrachtoverheidSsrTender("<html></html>")).toBeNull();
    const noVacancy = `<script type="application/json" id="__NUXT_DATA__">${JSON.stringify(
      [{ pinia: 1 }, { vacancyStore: 2 }, { vacancies: 3 }, []]
    )}</script>`;
    expect(extractOpdrachtoverheidSsrTender(noVacancy)).toBeNull();
    const broken = `<script type="application/json" id="__NUXT_DATA__">{not json</script>`;
    expect(extractOpdrachtoverheidSsrTender(broken)).toBeNull();
  });

  it("follows Ref/Reactive wrappers and -1 (undefined) slots", () => {
    const html = `<script type="application/json" id="__NUXT_DATA__">${JSON.stringify(
      [
        { pinia: 1 },
        ["Reactive", 2],
        { vacancyStore: 3 },
        ["Ref", 4],
        { vacancies: 5 },
        [6],
        { exclusive: -1, tender_id: 7, tender_name: 8, web_key: 9 },
        "id-1",
        "Naam",
        "WK-1",
      ]
    )}</script>`;
    expect(extractOpdrachtoverheidSsrTender(html)).toEqual({
      exclusive: undefined,
      tender_id: "id-1",
      tender_name: "Naam",
      web_key: "WK-1",
    });
  });
});

describe("Opdrachtoverheid market-wide discovery", () => {
  it("discovers non-Amstelveen organisations from the sitemap fixtures and enriches fetch()", async () => {
    const connector = createOpdrachtoverheidConnector({
      bronId: "bron-opdrachtoverheid-sitemap",
      client: createOpdrachtoverheidClient(fixtureClientOptions),
      sitemapBatchSize: 3,
    });

    const discovered = await connector.discover(null);
    expect(discovered.hasMore).toBe(false);
    expect(discovered.truncated).toBe(false);
    expect(discovered.checkpoint).toEqual({ cursor: "sitemap:3" });
    const tenders = discovered.items.map(
      (item) => (item.listingPayload as OpdrachtoverheidFetchedPayload).tender
    );
    expect(tenders.map((tender) => tender.tender_buying_organization)).toEqual([
      "Alliander",
      "Gemeente Rotterdam",
      "Rijkswaterstaat",
    ]);
    expect(discovered.items.map((item) => item.bronReferentie)).toEqual([
      "striive_HFALL001594-3_392363",
      "mercell_gem_roterdam_0083881",
      "circle8_rijkswaterstaat_VNR-85296",
    ]);
    // DEC-008: the SSR record carries ~47 keys; only the whitelist survives.
    for (const tender of tenders) {
      expect(tender).not.toHaveProperty("similarity_score");
      expect(tender).not.toHaveProperty("tender_categories");
      expect(tender).not.toHaveProperty("transient_favourite_user");
      expect(tender.vacancies_location ?? {}).not.toHaveProperty("latitude");
    }

    const [first] = discovered.items;
    if (!first) {
      throw new Error("expected a discovered item");
    }
    const fetched = await connector.fetch(first);
    if (fetched?.status !== "fetched") {
      throw new Error("expected fetched result");
    }
    const payload = JSON.parse(
      new TextDecoder().decode(fetched.body)
    ) as OpdrachtoverheidFetchedPayload;
    expect(payload.tender.tender_buying_organization).toBe("Alliander");
    expect(payload.jobPosting).toMatchObject({ title: "Planner C" });
    expect(new TextDecoder().decode(fetched.body)).not.toContain("teamStore");
  });

  it("walks the sitemap in batches and reuses the snapshot across checkpoints", async () => {
    const entries = [
      entry("org-a", "A"),
      entry("org-b", "B"),
      entry("org-c", "C"),
    ];
    let sitemapFetches = 0;
    const detailFetches: string[] = [];
    const client: OpdrachtoverheidClient = {
      fetchDetail: async ({ webKey }) => {
        detailFetches.push(webKey);
        return { jobPosting: null, tender: ssrTender(webKey, `Org ${webKey}`) };
      },
      fetchListing: () => Promise.reject(new Error("must not be called")),
      fetchSitemap: async () => {
        sitemapFetches += 1;
        return entries;
      },
    };
    const connector = createOpdrachtoverheidConnector({
      bronId: "bron-opdrachtoverheid-batches",
      client,
      sitemapBatchSize: 2,
    });

    const first = await connector.discover(null);
    expect(first.items.map((item) => item.bronReferentie)).toEqual(["A", "B"]);
    expect(first.hasMore).toBe(true);
    expect(first.checkpoint).toEqual({ cursor: "sitemap:2" });

    const second = await connector.discover(first.checkpoint);
    expect(second.items.map((item) => item.bronReferentie)).toEqual(["C"]);
    expect(second.hasMore).toBe(false);
    expect(second.checkpoint).toEqual({ cursor: "sitemap:3" });

    expect(sitemapFetches).toBe(1);
    expect(detailFetches).toEqual(["A", "B", "C"]);
    const [firstItem] = first.items;
    if (!firstItem) {
      throw new Error("expected first sitemap item");
    }
    await connector.fetch(firstItem);
    expect(detailFetches).toEqual(["A", "B", "C"]);

    // A stale private-API checkpoint starts a fresh sitemap snapshot.
    const restarted = await connector.discover({ page: 9 });
    expect(restarted.checkpoint).toEqual({ cursor: "sitemap:2" });
    expect(sitemapFetches).toBe(2);
  });

  it("fails a detail page job without advancing its durable checkpoint", async () => {
    let fail = true;
    const fetched: string[] = [];
    const client: OpdrachtoverheidClient = {
      fetchDetail: async ({ webKey }) => {
        fetched.push(webKey);
        if (webKey === "BROKEN" && fail) {
          throw new Error("HTTP 500");
        }
        return { jobPosting: null, tender: ssrTender(webKey, "Org") };
      },
      fetchListing: () => Promise.reject(new Error("must not be called")),
      fetchSitemap: async () => [
        entry("org", "OK"),
        entry("org", "BROKEN"),
        entry("org", "AFTER"),
      ],
    };
    const connector = createOpdrachtoverheidConnector({
      bronId: "bron-opdrachtoverheid-partial",
      client,
      sitemapBatchSize: 2,
    });

    await expect(connector.discover(null)).rejects.toThrow("HTTP 500");
    fail = false;
    const retried = await connector.discover(null);
    expect(retried.items.map((item) => item.bronReferentie)).toEqual([
      "OK",
      "BROKEN",
    ]);
    expect(retried.checkpoint).toEqual({ cursor: "sitemap:2" });
    expect(retried.hasMore).toBe(true);
    expect(fetched).toEqual(["OK", "BROKEN", "OK", "BROKEN"]);
  });

  it("skips a structurally empty detail and flags the scan incomplete instead of retrying it", async () => {
    const fetched: string[] = [];
    const connector = createOpdrachtoverheidConnector({
      bronId: "bron-opdrachtoverheid-empty-detail",
      client: {
        fetchDetail: async ({ webKey }) => {
          fetched.push(webKey);
          return webKey === "EMPTY"
            ? { jobPosting: null, tender: null }
            : { jobPosting: null, tender: ssrTender(webKey, "Org") };
        },
        fetchListing: () => Promise.reject(new Error("must not be called")),
        fetchSitemap: async () => [entry("org", "OK"), entry("org", "EMPTY")],
      },
      sitemapBatchSize: 2,
    });

    const result = await connector.discover(null);

    expect(result.items.map((item) => item.bronReferentie)).toEqual(["OK"]);
    expect(result.truncated).toBe(true);
    expect(result.checkpoint).toEqual({ cursor: "sitemap:2" });
    expect(result.hasMore).toBe(false);
    expect(fetched).toEqual(["OK", "EMPTY"]);
  });

  it("falls back to the private listing API when the sitemap fails or is empty", async () => {
    const listingTender = ssrTender("LISTING", "Gemeente Amstelveen");
    const makeClient = (
      fetchSitemap: OpdrachtoverheidClient["fetchSitemap"]
    ): OpdrachtoverheidClient => ({
      fetchDetail: async () => ({ jobPosting: null, tender: null }),
      fetchListing: async () => ({ hasMore: true, items: [listingTender] }),
      fetchSitemap,
    });

    const failed = await createOpdrachtoverheidConnector({
      bronId: "bron-opdrachtoverheid-fallback",
      client: makeClient(() => Promise.reject(new Error("HTTP 503"))),
    }).discover(null);
    expect(failed.items.map((item) => item.bronReferentie)).toEqual([
      "LISTING",
    ]);
    expect(failed.checkpoint).toEqual({ page: 1 });
    expect(failed.truncated).toBe(true);

    const empty = await createOpdrachtoverheidConnector({
      bronId: "bron-opdrachtoverheid-fallback-empty",
      client: makeClient(async () => []),
    }).discover(null);
    expect(empty.items.map((item) => item.bronReferentie)).toEqual(["LISTING"]);
  });

  it("keeps the private listing path when no sitemap fixture is configured", async () => {
    const result = await createOpdrachtoverheidConnector({
      bronId: "bron-opdrachtoverheid-default-fixture",
      client: createOpdrachtoverheidClient({ liveEnabled: false }),
    }).discover(null);
    expect(result.checkpoint).toEqual({ page: 1 });
    expect(result.items.length).toBeGreaterThan(0);
  });
});

describe("Opdrachtoverheid sitemap live client", () => {
  it("fetches the sitemap and detail pages from the public site", async () => {
    const requested: string[] = [];
    const sitemapFixture = await loadConnectorFixture<string>(SITEMAP_FIXTURE);
    const detailFixture = await loadConnectorFixture<string>(
      DETAIL_FIXTURES["CDBDC0AD-E314-43D9-B1DC-30ABF7BD8BA2"]
    );
    const fetchImpl = Object.assign(
      async (input: string | URL | Request) => {
        const url = String(input);
        requested.push(url);
        if (url.endsWith("/sitemap.xml")) {
          return new Response(sitemapFixture.payload, {
            headers: { "Content-Type": "application/xml" },
          });
        }
        return new Response(detailFixture.payload, {
          headers: { "Content-Type": "text/html" },
        });
      },
      { preconnect: () => {} }
    );

    for (const client of [
      createOpdrachtoverheidClient({
        fetchImpl,
        liveEnabled: true,
        siteBaseUrl: "https://site.test",
      }),
      createOpdrachtoverheidEffectClient({
        fetchImpl,
        liveEnabled: true,
        siteBaseUrl: "https://site.test",
      }),
    ]) {
      requested.length = 0;
      const entries = await client.fetchSitemap();
      expect(requested).toEqual(["https://site.test/sitemap.xml"]);
      expect(entries).toHaveLength(3);
      const [alliander] = entries;
      if (!alliander) {
        throw new Error("expected a sitemap entry");
      }
      const page = await client.fetchDetail(alliander);
      expect(requested[1]).toBe(alliander.detailUrl);
      expect(page.tender?.tender_buying_organization).toBe("Alliander");
      expect(page.jobPosting).toMatchObject({ title: "Planner C" });
    }
  });

  it("treats hard-gone detail pages as delisted in both clients", async () => {
    for (const status of [404, 410]) {
      const fetchImpl = Object.assign(
        async () => new Response("gone", { status }),
        { preconnect: () => {} }
      );
      for (const client of [
        createOpdrachtoverheidClient({ fetchImpl, liveEnabled: true }),
        createOpdrachtoverheidEffectClient({ fetchImpl, liveEnabled: true }),
      ]) {
        expect(await client.fetchDetail(entry("gone", "GONE"))).toEqual({
          jobPosting: null,
          tender: null,
        });
      }
    }
  });

  it("rejects a non-OK sitemap response so the connector can fall back", async () => {
    const fetchImpl = Object.assign(
      async () => new Response("nope", { status: 503 }),
      { preconnect: () => {} }
    );
    const client = createOpdrachtoverheidClient({
      fetchImpl,
      liveEnabled: true,
    });
    await expect(client.fetchSitemap()).rejects.toThrow(/status 503/u);
    const effectClient = createOpdrachtoverheidEffectClient({
      fetchImpl,
      liveEnabled: true,
    });
    await expect(effectClient.fetchSitemap()).rejects.toThrow();
  });

  it("returns empty results in fixture mode without registered fixtures", async () => {
    const client = createOpdrachtoverheidEffectClient({ liveEnabled: false });
    expect(await client.fetchSitemap()).toEqual([]);
    expect(await client.fetchDetail(entry("org", "X"))).toEqual({
      jobPosting: null,
      tender: null,
    });
  });
});
