import { describe, expect, it } from "bun:test";

import {
  CrawlDelayLimiter,
  InMemoryObjectStore,
  InMemoryObservationRecorder,
  InMemoryRunLifecycleStore,
  loadConnectorFixture,
  runConnector,
} from "@ji/connectors";

import {
  buildProunityRawHtml,
  createProunityClient,
  extractProunityJobSitemapUrls,
  extractProunityReferentie,
  parseProunityDetail,
  parseProunityJobSitemap,
} from "./client";
import type { ProunityClient } from "./client";
import { createProunityConnector } from "./connector";
import { hashProunityListingItem } from "./hash";
import type { ProunityListingItem } from "./types";

const retryPolicy = {
  initialDelayMs: 0,
  jitter: (delayMs: number) => delayMs,
  maxAttempts: 1,
  maxDelayMs: 0,
  multiplier: 1,
};

const UUID_FRONTEND = "2d7d21bd-840e-46e9-b43c-1e00dee5140e";
const UUID_DATASCIENTIST = "0e8d62af-0955-4915-86f1-5c4fc2fdf74c";
const UUID_HISTORICAL = "3469b088-d2f6-45cb-81cd-1b98c9558417";

const DETAIL_HTML = `
<article id="post-14810" class="post pji_job">
  <h2 class="entry-title fusion-post-title">Frontend Web Developer (K10127)</h2>
  <div class="post-content">
    <span class="putag">2 months</span>
    <div class="job__infobar">
      <span class="">12/10/2026 - 31/12/2026</span>
      <span class="">Belgium</span>
    </div>
    <div class="job">
      <div class="">
        <h5>Requirements</h5>
        <h6 class=""><b>Roles</h6>
        <div class="tags"><ul>
          <li><b>Application Developer</b> <span class="tag2 tag-Confirmed">Confirmed</span></li>
        </ul></div>
        <h6 class=""><b>Languages</h6>
        <div class="tags"><ul>
          <li><b>English</b> <span class="tag2 tag-Active knowledge">Active knowledge</span></li>
          <li><b>Dutch</b> <span class="tag2 tag-Active knowledge">Active knowledge</span></li>
        </ul></div>
        <h6 class=""><b>Skills</h6>
        <div class="tags"><ul>
          <li><b>GIT</b> <span class="tag2 tag-Confirmed">Confirmed</span></li>
          <li><b>Angular</b> <span class="tag2 tag-Confirmed">Confirmed</span></li>
        </ul></div>
        <a href="https://platform.pro-unity.com/Login/JobPosts/2d7d21bd-840e-46e9-b43c-1e00dee5140e/frontend-web-developer-k10127" class="sebtn job__signin" target="_blank">Sign in to apply</a>
      </div>
      <div class="">
        <h5>Description</h5>
        <div class="richtext"><p><strong>Frontend Web Developer</strong><br />Police F&#233;d&#233;rale</p></div>
      </div>
    </div>
  </div>
</article>
`;

describe("ProUnity sitemap parsing", () => {
  it("selects only pji_job children from the real recorded sitemap index", async () => {
    const fixture = await loadConnectorFixture<string>(
      "prounity/listing-page-0.json"
    );
    const children = extractProunityJobSitemapUrls(fixture.payload);
    expect(children).toEqual([
      "https://www.pro-unity.com/pji_job-sitemap.xml",
      "https://www.pro-unity.com/pji_job-sitemap2.xml",
      "https://www.pro-unity.com/pji_job-sitemap3.xml",
      "https://www.pro-unity.com/pji_job-sitemap4.xml",
      "https://www.pro-unity.com/pji_job-sitemap5.xml",
    ]);
  });

  it("parses CDATA-wrapped <loc>/<lastmod> entries of the trimmed child sitemap", async () => {
    const fixture = await loadConnectorFixture<string>(
      "prounity/sitemap-pji-job.json"
    );
    const items = parseProunityJobSitemap(fixture.payload);
    expect(items).toEqual([
      {
        lastmod: "2026-09-17T12:24:01+00:00",
        url: `https://www.pro-unity.com/job/${UUID_FRONTEND}/`,
        uuid: UUID_FRONTEND,
      },
      {
        lastmod: "2026-09-17T12:20:32+00:00",
        url: `https://www.pro-unity.com/job/${UUID_DATASCIENTIST}/`,
        uuid: UUID_DATASCIENTIST,
      },
    ]);
  });
});

describe("ProUnity detail parsing", () => {
  it("extracts titel, duur, periode, land, requirement sections and apply url", async () => {
    const detail = await parseProunityDetail(DETAIL_HTML, UUID_FRONTEND);
    expect(detail).toMatchObject({
      applyUrl:
        "https://platform.pro-unity.com/Login/JobPosts/2d7d21bd-840e-46e9-b43c-1e00dee5140e/frontend-web-developer-k10127",
      duur: "2 months",
      land: "Belgium",
      periode: "12/10/2026 - 31/12/2026",
      referentie: "K10127",
      roles: [{ naam: "Application Developer", status: "Confirmed" }],
      skills: [
        { naam: "GIT", status: "Confirmed" },
        { naam: "Angular", status: "Confirmed" },
      ],
      talen: [
        { naam: "English", status: "Active knowledge" },
        { naam: "Dutch", status: "Active knowledge" },
      ],
      titel: "Frontend Web Developer (K10127)",
      uuid: UUID_FRONTEND,
    });
  });

  it("extracts the (K…) reference from the title", () => {
    expect(extractProunityReferentie("Data Scientist (K10126)")).toBe("K10126");
    expect(extractProunityReferentie("No reference here")).toBeUndefined();
  });
});

describe("ProUnity real fixtures (recorded 2026-09-18)", () => {
  it("parses the open Frontend Web Developer capture", async () => {
    const fixture = await loadConnectorFixture<string>(
      `prounity/detail-${UUID_FRONTEND}.json`
    );
    const detail = await parseProunityDetail(fixture.payload, UUID_FRONTEND);
    expect(detail.titel).toBe("Frontend Web Developer (K10127)");
    expect(detail.referentie).toBe("K10127");
    expect(detail.duur).toBe("2 months");
    expect(detail.periode).toBe("12/10/2026 - 31/12/2026");
    expect(detail.land).toBe("Belgium");
    expect(detail.roles).toEqual([
      { naam: "Application Developer", status: "Confirmed" },
    ]);
    expect(detail.talen.map((tag) => tag.naam)).toEqual([
      "English",
      "Dutch",
      "French",
    ]);
    expect(detail.skills.length).toBeGreaterThan(10);
    expect(detail.applyUrl).toContain(
      `platform.pro-unity.com/Login/JobPosts/${UUID_FRONTEND}/`
    );
  });

  it("parses the historical 2023 capture: no putag duur, past periode, no closed marker", async () => {
    const fixture = await loadConnectorFixture<string>(
      `prounity/detail-${UUID_HISTORICAL}.json`
    );
    const detail = await parseProunityDetail(fixture.payload, UUID_HISTORICAL);
    expect(detail.titel).toBe("Chef de projet (clé 203) (K07518)");
    expect(detail.referentie).toBe("K07518");
    expect(detail.duur).toBeUndefined();
    expect(detail.periode).toBe("01/12/2023 - 31/12/2023");
    expect(detail.land).toBe("Belgium");
  });

  it("DEC-008: raw.html keeps only the richtext description (no scripts, no apply CTA)", async () => {
    const fixture = await loadConnectorFixture<string>(
      `prounity/detail-${UUID_FRONTEND}.json`
    );
    const rawHtml = buildProunityRawHtml(fixture.payload);
    expect(rawHtml).toContain("Frontend Web Developer");
    expect(rawHtml).toContain("Police Fédérale");
    expect(rawHtml).not.toContain("<script");
    expect(rawHtml).not.toContain("job__signin");
    expect(rawHtml).not.toContain("job__infobar");
  });

  it("fixture client resolves a recorded detail by uuid and rejects an unknown one", async () => {
    const client = createProunityClient({ liveEnabled: false });
    const html = await client.fetchDetailHtml(UUID_FRONTEND);
    expect(html).toContain("Frontend Web Developer");
    await expect(client.fetchDetailHtml("missing-uuid")).rejects.toThrow(
      "Missing ProUnity detail fixture"
    );
  });
});

const fixtureConnector = (bronId: string) =>
  createProunityConnector({
    bronId,
    client: createProunityClient({ liveEnabled: false }),
  });

describe("ProUnity connector", () => {
  it("ingests listing + detail fixtures with found/new metrics", async () => {
    const bronId = "bron-prounity-fixture";
    const result = await runConnector({
      bronId,
      bronSlug: "prounity",
      checkpoint: null,
      connector: fixtureConnector(bronId),
      limiter: new CrawlDelayLimiter({ crawlDelayMs: 0 }),
      objectStore: new InMemoryObjectStore(),
      observationRecorder: new InMemoryObservationRecorder(),
      rawRetentionDays: 90,
      retryPolicy,
      runKind: "test",
      runLifecycleStore: new InMemoryRunLifecycleStore(),
      scrapeRunId: "run-pu-1",
      startedAt: new Date("2026-09-18T06:10:00.000Z"),
    });

    expect(result.metrics.found).toBe(2);
    expect(result.metrics.new).toBe(2);
    expect(result.metrics.error).toBe(0);
    expect(result.metrics.rejected).toBe(0);
  });

  it("replays fixture ingest without duplicate source records", async () => {
    const bronId = "bron-prounity-replay";
    const recorder = new InMemoryObservationRecorder();
    const connector = fixtureConnector(bronId);
    const sharedInput = {
      bronId,
      bronSlug: "prounity" as const,
      checkpoint: null,
      connector,
      limiter: new CrawlDelayLimiter({ crawlDelayMs: 0 }),
      objectStore: new InMemoryObjectStore(),
      observationRecorder: recorder,
      rawRetentionDays: 90,
      retryPolicy,
      runKind: "test" as const,
      runLifecycleStore: new InMemoryRunLifecycleStore(),
    };

    await runConnector({ ...sharedInput, scrapeRunId: "run-pu-replay-1" });
    await runConnector({ ...sharedInput, scrapeRunId: "run-pu-replay-2" });

    expect(recorder.records.length).toBeGreaterThan(0);
    expect(
      new Set(recorder.records.map((record) => record.bronReferentie)).size
    ).toBe(recorder.records.length);
  });

  it("skips the detail fetch when the stored listing hash matches", async () => {
    const bronId = "bron-prounity-known-hash";
    const items: ProunityListingItem[] = [
      {
        lastmod: "2026-09-17T12:24:01+00:00",
        url: `https://www.pro-unity.com/job/${UUID_FRONTEND}/`,
        uuid: UUID_FRONTEND,
      },
    ];
    const client: ProunityClient = {
      fetchDetailHtml: () =>
        Promise.reject(new Error("fetchDetailHtml should not be called")),
      fetchListing: () => Promise.resolve(items),
    };
    const [item] = items;
    if (!item) {
      throw new Error("Expected a fixture listing item");
    }
    const knownHash = await hashProunityListingItem(item);
    const connector = createProunityConnector({
      bronId,
      client,
      knownHashes: { get: () => Promise.resolve(knownHash) },
    });
    const discovery = await connector.discover(null);
    const [discoveredItem] = discovery.items;
    if (!discoveredItem) {
      throw new Error("Expected a discovered item");
    }
    const fetched = await connector.fetch(discoveredItem);
    expect(fetched).toBeNull();
  });

  it("rejects a detail page with an empty/missing titel instead of ingesting it", async () => {
    const bronId = "bron-prounity-malformed";
    const items: ProunityListingItem[] = [
      {
        url: "https://www.pro-unity.com/job/00000000-0000-0000-0000-000000000001/",
        uuid: "00000000-0000-0000-0000-000000000001",
      },
    ];
    const client: ProunityClient = {
      fetchDetailHtml: () =>
        Promise.resolve(
          '<article class="post pji_job"><h2 class="entry-title fusion-post-title"></h2></article>'
        ),
      fetchListing: () => Promise.resolve(items),
    };
    const connector = createProunityConnector({ bronId, client });
    const discovery = await connector.discover(null);
    const [discoveredItem] = discovery.items;
    if (!discoveredItem) {
      throw new Error("Expected a discovered item");
    }
    const fetched = await connector.fetch(discoveredItem);
    expect(fetched).toMatchObject({
      reason: "detail page missing titel",
      status: "rejected",
    });
  });
});
