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
  buildNeedstaffingRawHtml,
  createNeedstaffingClient,
  decodeNeedstaffingEntities,
  extractNeedstaffingCompetenties,
  extractNeedstaffingContactpersonen,
  extractNeedstaffingId,
  extractNeedstaffingReferentie,
  parseNeedstaffingDetail,
  parseNeedstaffingListing,
  parseNeedstaffingTariefBand,
  splitNeedstaffingLocatie,
} from "./client";
import type { NeedstaffingClient } from "./client";
import { createNeedstaffingConnector } from "./connector";
import { hashNeedstaffingListingItem } from "./hash";
import type { NeedstaffingListingItem } from "./types";
import { NEEDSTAFFING_MAX_LISTING_PAGES } from "./types";

const retryPolicy = {
  initialDelayMs: 0,
  jitter: (delayMs: number) => delayMs,
  maxAttempts: 1,
  maxDelayMs: 0,
  multiplier: 1,
};

const LISTING_HTML = `
<div class="vacancies-overview-item">
  <a href="/Opdrachten/15521">
    <div class="vacancies-overview-item-card">
      <div class="vacancies-overview-item-logo">
        <img src="logo.png" alt="Belastingdienst">
      </div>
      <div class="vacancies-overview-item-summary">
        <div><h2>Senior Scrummaster 2026-IBS-0370B</h2></div>
      </div>
      <div class="vacancies-overview-item-information">
        <div class="vacancies-overview-item-information-item">
          <img src="location.svg" alt="Locatie"><p>Apeldoorn</p>
        </div>
        <div class="vacancies-overview-item-information-item">
          <p>Genegeerde tekst zonder icoon</p>
        </div>
        <div class="vacancies-overview-item-information-item">
          <img src="duration.svg" alt="Verwacht aantal uren per week"><p>36</p>
        </div>
        <div class="vacancies-overview-item-information-item">
          <img src="money.svg" alt="Verwachte compensatie"><p>&#x20AC;95,00 - &#x20AC;100,00</p>
        </div>
        <div class="vacancies-overview-item-information-item">
          <img src="start.svg" alt="Verwachte startdatum"><p><span data-date-utc="1790553600000">28-09-2026</span></p>
        </div>
        <div class="vacancies-overview-item-information-item">
          <img src="deadline.svg" alt="Deadline voor reageren"><p><span data-date-utc="1788876000000">08-09-2026</span> <span data-time-utc="1788876000000">14:00</span></p>
        </div>
      </div>
    </div>
  </a>
</div>
<div class="vacancies-overview-item">
  <a href="/Opdrachten/15520">
    <div class="vacancies-overview-item-card">
      <div class="vacancies-overview-item-logo">
        <img src="logo.png" alt="Belastingdienst">
      </div>
      <div class="vacancies-overview-item-summary">
        <div><h2>Operationeel Database Ontwikkelaar 2026-BZB-0457</h2></div>
      </div>
      <div class="vacancies-overview-item-information">
        <div class="vacancies-overview-item-information-item">
          <img src="location.svg" alt="Locatie"><p>Den Haag</p>
        </div>
      </div>
    </div>
  </a>
</div>
`;

const DETAIL_HTML = `
<div class="page-header page-header-vacancy">
  <div class="container">
    <h1>Operationeel Database Ontwikkelaar 2026-BZB-0457</h1>
    <div class="page-header-vacancy-details">
      <div class="page-header-vacancy-details-item">
        <img src="location.svg" alt="Locatie"><p>Den Haag</p>
      </div>
      <div class="page-header-vacancy-details-item">
        <img src="duration.svg" alt="Verwacht aantal uren per week"><p>36</p>
      </div>
      <div class="page-header-vacancy-details-item">
        <img src="money.svg" alt="Verwachte compensatie"><p>&#x20AC;98-102</p>
      </div>
      <div class="page-header-vacancy-details-item">
        <img src="start.svg" alt="Verwachte startdatum"><p><span data-date-utc="1790380800000">26-09-2026</span></p>
      </div>
      <div class="page-header-vacancy-details-item">
        <img src="deadline.svg" alt="Deadline voor reageren"><p><span data-date-utc="1788778800000">07-09-2026</span> <span data-time-utc="1788778800000">11:00</span></p>
      </div>
    </div>
  </div>
</div>
<div class="container">
  <div class="vacancy">
    <div class="vacancy-text">
      <p><b>Opdrachtomschrijving</b></p>Rolomschrijving voor database ontwikkelaar.
      <script>trackPageView();</script>
      <a href="https://needstaffing.esdnext.com/app/opdrachten/vacatures/15520/RESPOND" class="btn">Reageer nu</a>
    </div>
    <div class="vacancy-contact-info">
      <p>Test Recruiter</p>
      <a href="mailto:recruiter@example.invalid">recruiter@example.invalid</a>
    </div>
  </div>
</div>
`;

describe("Needstaffing HTML parsing", () => {
  it("extracts id from an opdracht href", () => {
    expect(extractNeedstaffingId("/Opdrachten/15520")).toBe("15520");
  });

  it("extracts the reference code from a listing title", () => {
    expect(
      extractNeedstaffingReferentie("Senior Scrummaster 2026-IBS-0370B")
    ).toBe("2026-IBS-0370B");
  });

  it("parses a euro-comma tarief band", () => {
    expect(parseNeedstaffingTariefBand("€95,00 - €100,00")).toEqual({
      max: "100.00",
      min: "95.00",
    });
  });

  it("parses a compact tarief band with one euro sign", () => {
    expect(parseNeedstaffingTariefBand("€98-102")).toEqual({
      max: "102",
      min: "98",
    });
  });

  it("parses slash-separated all-in rates with comma-dash suffixes", () => {
    expect(
      parseNeedstaffingTariefBand("€80,- / €95,- per uur all-in ex.btw")
    ).toEqual({ max: "95", min: "80" });
  });

  it("parses listing cards into items with dates as epoch strings, and does not leak a field into an info-item with no recognised icon", async () => {
    const listing = await parseNeedstaffingListing(LISTING_HTML);
    expect(listing.items).toHaveLength(2);
    // `locatie` and `uren` below sandwich an info-item with no <img alt> at
    // all (see LISTING_HTML) — if pendingField went stale, `locatie` would
    // absorb "Genegeerde tekst zonder icoon" and/or `uren` would go missing.
    expect(listing.items[0]).toMatchObject({
      deadline: "1788876000000",
      id: "15521",
      locatie: "Apeldoorn",
      opdrachtgeverNaam: "Belastingdienst",
      start: "1790553600000",
      tarief: "€95,00 - €100,00",
      titel: "Senior Scrummaster 2026-IBS-0370B",
      uren: "36",
    });
    expect(listing.hasNextPage).toBe(false);
  });

  it("parses the detail page into typed fields and derives tarief min/max", async () => {
    const detail = await parseNeedstaffingDetail(DETAIL_HTML, "15520");
    expect(detail).toMatchObject({
      deadline: "1788778800000",
      id: "15520",
      locatie: "Den Haag",
      referentie: "2026-BZB-0457",
      start: "1790380800000",
      tariefMax: "102",
      tariefMin: "98",
      titel: "Operationeel Database Ontwikkelaar 2026-BZB-0457",
      uren: "36",
    });
  });

  it("extracts the .vacancy-contact-info block as a contact channel (CTP-610)", async () => {
    const detail = await parseNeedstaffingDetail(DETAIL_HTML, "15520");
    expect(detail.contactpersonen).toEqual([
      {
        email: "recruiter@example.invalid",
        naam: "Test Recruiter",
        telefoon: null,
      },
    ]);
  });

  it("returns undefined contactpersonen when the page carries no contact block", () => {
    expect(
      extractNeedstaffingContactpersonen("<div><p>gewone tekst</p></div>")
    ).toBeUndefined();
  });

  it("keeps a tel-only contact block (no name paragraph)", () => {
    const html = `<div class="vacancy-contact-info">
      <a href="tel:+31000000000">Bel ons</a>
    </div>`;
    expect(extractNeedstaffingContactpersonen(html)).toEqual([
      { email: null, naam: null, telefoon: "+31000000000" },
    ]);
  });

  it("decodes &amp; and &nbsp; entities in typed fields (opdrachtgeverNaam, locatie)", async () => {
    const html = `
<div class="vacancies-overview-item">
  <a href="/Opdrachten/99999">
    <div class="vacancies-overview-item-card">
      <div class="vacancies-overview-item-logo">
        <img src="logo.png" alt="Belastingdienst &amp; Douane">
      </div>
      <div class="vacancies-overview-item-summary">
        <div><h2>Test Rol 2026-XYZ-0001</h2></div>
      </div>
      <div class="vacancies-overview-item-information">
        <div class="vacancies-overview-item-information-item">
          <img src="location.svg" alt="Locatie"><p>Den&nbsp;Haag</p>
        </div>
      </div>
    </div>
  </a>
</div>`;
    const listing = await parseNeedstaffingListing(html);
    expect(listing.items[0]).toMatchObject({
      locatie: "Den Haag",
      opdrachtgeverNaam: "Belastingdienst & Douane",
    });
  });
});

/** Complete page recorded 2026-09-16 with tools/fixtures/record.ts; every
 * row has its own detail recording (NEEDSTAFFING_DETAIL_FIXTURES). */
const LIVE_LISTING_FIXTURE = "needstaffing/listing-live-2026-09-16.json";

describe("Needstaffing real fixtures", () => {
  it("parses the real recorded listing fixture, including periode and pagination", async () => {
    const fixture = await loadConnectorFixture<string>(
      "needstaffing/listing-page-0.json"
    );
    const listing = await parseNeedstaffingListing(fixture.payload);
    expect(listing.hasNextPage).toBe(true);
    expect(listing.items[0]).toMatchObject({
      id: "15520",
      periode: "4 maanden",
    });
  });

  it("parses the 2026-09-16 live listing recording: full page, pagination, werkvorm split", async () => {
    const fixture = await loadConnectorFixture<string>(LIVE_LISTING_FIXTURE);
    const listing = await parseNeedstaffingListing(fixture.payload);
    expect(listing.hasNextPage).toBe(true);
    expect(listing.items).toHaveLength(20);
    expect(listing.items[0]).toMatchObject({
      id: "15574",
      periode: "3 maanden (met optie tot verlenging)",
    });
    // Joborder 15599 carries a real werkvorm split at the listing level too
    // ("Den Haag/Hybride"), and is the row the detail specs below parse.
    expect(listing.items.find((item) => item.id === "15599")).toMatchObject({
      id: "15599",
      locatie: "Den Haag",
      werkvorm: "Hybride",
    });
  });

  it("resolves joborder 15599's detail fetch to its own live capture (fixture-mode default client)", async () => {
    const client = createNeedstaffingClient({ liveEnabled: false });
    const detailHtml = await client.fetchDetailHtml("15599");
    expect(detailHtml).toContain("Business Analist");
    expect(detailHtml).not.toContain("vacancy-contact-info");
  });

  it("parses the live detail capture (2026-09-16, joborder 15599): werkvorm split from Locatie, uren with unit suffix, competenties list", async () => {
    const fixture = await loadConnectorFixture<string>(
      "needstaffing/detail-15599.json"
    );
    const detail = await parseNeedstaffingDetail(fixture.payload, "15599");
    expect(detail).toMatchObject({
      competenties: [
        "Eigenaarschap",
        "Overtuigingskracht",
        "Inhoudelijke scherpte",
        "Analytisch sterk",
        "Hands-on en praktisch ingesteld",
        "Een echte doener",
        "Goede teamspeler",
        "Communicatief vaardig",
        "Proactief",
        "Zelfstandig",
        "Nuchter en no-nonsense",
        "Snel kunnen schakelen",
        "In staat om een organisatie snel te doorgronden",
      ],
      locatie: "Den Haag",
      periode: "12 maanden",
      uren: "36u",
      werkvorm: "Hybride",
    });
  });

  it("DEC-008: the live detail capture has no recruiter name/phone/email", async () => {
    const fixture = await loadConnectorFixture<string>(
      "needstaffing/detail-15599.json"
    );
    // Shape-only assertions -- asserting the real recruiter's name/number/
    // email here would put the exact PII this test exists to keep out
    // directly into the spec source (advisor review). The sanitized
    // contact block is gone entirely, no mobile-shaped number remains, and
    // no mailto survives at all on this capture.
    expect(fixture.payload).not.toContain("vacancy-contact-info");
    expect(fixture.payload).not.toMatch(/\b06\d{8}\b/u);
    expect(fixture.payload).not.toMatch(/mailto:(?!info@needstaffing\.nl)/u);
  });

  it("DEC-008: raw.html from the real detail fixture keeps only the description text (no script, no RESPOND CTA, no contact info)", async () => {
    const fixture = await loadConnectorFixture<string>(
      "needstaffing/detail-15520.json"
    );
    const rawHtml = buildNeedstaffingRawHtml(fixture.payload);
    expect(rawHtml).toContain("Opdrachtomschrijving");
    expect(rawHtml).not.toContain("<script");
    expect(rawHtml).not.toContain("/RESPOND");
    expect(rawHtml).not.toContain("vacancy-contact-info");
  });
});

describe("decodeNeedstaffingEntities (RJC-374 guard, wired through this source)", () => {
  it("leaves an out-of-range numeric entity untouched instead of throwing", () => {
    expect(() => decodeNeedstaffingEntities("&#1114112;")).not.toThrow();
    expect(decodeNeedstaffingEntities("&#1114112;")).toBe("&#1114112;");
  });

  it("leaves a lone-surrogate numeric entity untouched instead of throwing", () => {
    expect(() => decodeNeedstaffingEntities("&#xD800;")).not.toThrow();
    expect(decodeNeedstaffingEntities("&#xD800;")).toBe("&#xD800;");
  });

  it("still decodes a real entity confirmed live in Needstaffing text nodes", () => {
    expect(decodeNeedstaffingEntities("&#x20AC;500 per dag")).toBe(
      "€500 per dag"
    );
  });
});

describe("Needstaffing connector", () => {
  it("ingests listing + detail fixtures with found/new/changed/rejected/error metrics", async () => {
    const bronId = "bron-needstaffing-fixture";
    const result = await runConnector({
      bronId,
      bronSlug: "needstaffing",
      checkpoint: null,
      connector: createNeedstaffingConnector({
        bronId,
        client: createNeedstaffingClient({ liveEnabled: false }),
      }),
      limiter: new CrawlDelayLimiter({ crawlDelayMs: 0 }),
      objectStore: new InMemoryObjectStore(),
      observationRecorder: new InMemoryObservationRecorder(),
      rawRetentionDays: 90,
      retryPolicy,
      runKind: "test",
      runLifecycleStore: new InMemoryRunLifecycleStore(),
      scrapeRunId: "run-ns-1",
      startedAt: new Date("2026-08-31T10:15:00.000Z"),
    });

    expect(result.metrics.found).toBeGreaterThan(0);
    expect(result.metrics.new).toBe(result.metrics.found);
    expect(result.metrics.error).toBe(0);
    expect(result.metrics.rejected).toBe(0);
  });

  it("replays fixture ingest without duplicate source records", async () => {
    const bronId = "bron-needstaffing-replay";
    const recorder = new InMemoryObservationRecorder();
    const objectStore = new InMemoryObjectStore();
    const connector = createNeedstaffingConnector({
      bronId,
      client: createNeedstaffingClient({ liveEnabled: false }),
    });
    const sharedInput = {
      bronId,
      bronSlug: "needstaffing" as const,
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

    await runConnector({ ...sharedInput, scrapeRunId: "run-ns-replay-1" });
    await runConnector({ ...sharedInput, scrapeRunId: "run-ns-replay-2" });

    expect(recorder.records.length).toBeGreaterThan(0);
    expect(
      new Set(recorder.records.map((record) => record.bronReferentie)).size
    ).toBe(recorder.records.length);
  });

  it("skips detail fetches for listing rows whose hash is already known", async () => {
    const bronId = "bron-needstaffing-known-hash";
    const items: NeedstaffingListingItem[] = [
      { id: "15520", titel: "Senior Java Developer" },
    ];
    const client: NeedstaffingClient = {
      fetchDetailHtml: () =>
        Promise.reject(new Error("fetchDetailHtml should not be called")),
      fetchListing: (page) =>
        Promise.resolve(
          page === 0
            ? { hasNextPage: false, items }
            : { hasNextPage: false, items: [] }
        ),
    };
    const [item] = items;
    if (!item) {
      throw new Error("Expected a fixture listing item");
    }
    const knownHash = await hashNeedstaffingListingItem(item);
    const knownHashes = {
      get: (_bronId: string, bronReferentie: string) =>
        Promise.resolve(bronReferentie === "15520" ? knownHash : null),
    };
    const connector = createNeedstaffingConnector({
      bronId,
      client,
      knownHashes,
    });
    const discovery = await connector.discover(null);
    expect(discovery.items).toHaveLength(1);
    const [discoveredItem] = discovery.items;
    if (!discoveredItem) {
      throw new Error("Expected a discovered item");
    }
    const fetched = await connector.fetch(discoveredItem);
    expect(fetched).toBeNull();
  });

  it("re-hashes a listing row when only werkvorm changes (CTP-517 review)", async () => {
    const base: NeedstaffingListingItem = {
      id: "15900",
      locatie: "Den Haag",
      titel: "Interim Projectleider",
      werkvorm: "Hybride",
    };
    const changed: NeedstaffingListingItem = { ...base, werkvorm: "Remote" };
    const baseHash = await hashNeedstaffingListingItem(base);
    const changedHash = await hashNeedstaffingListingItem(changed);
    expect(changedHash).not.toBe(baseHash);
  });

  it("rejects a detail page with an empty/missing titel instead of ingesting it", async () => {
    const bronId = "bron-needstaffing-malformed";
    const items: NeedstaffingListingItem[] = [
      { id: "40000", titel: "Placeholder Titel" },
    ];
    const client: NeedstaffingClient = {
      fetchDetailHtml: () =>
        Promise.resolve(
          '<div class="page-header page-header-vacancy"><div class="container"><h1></h1></div></div>'
        ),
      fetchListing: (page) =>
        Promise.resolve(
          page === 0
            ? { hasNextPage: false, items }
            : { hasNextPage: false, items: [] }
        ),
    };
    const connector = createNeedstaffingConnector({ bronId, client });
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

describe("needstaffing page cap (RJC-397)", () => {
  const cappedClient: NeedstaffingClient = {
    fetchDetailHtml: () => Promise.reject(new Error("not used")),
    fetchListing: () =>
      Promise.resolve({
        hasNextPage: true,
        items: [{ id: "NS-CAP", titel: "Cap" }],
      }),
  };

  it("reports truncated when the page cap stops the walk while the site still has a next page", async () => {
    const connector = createNeedstaffingConnector({
      bronId: "bron-needstaffing-cap",
      client: cappedClient,
    });
    const beforeCap = await connector.discover({
      page: NEEDSTAFFING_MAX_LISTING_PAGES - 2,
    });
    expect(beforeCap.hasMore).toBe(true);
    expect(beforeCap.truncated).toBe(false);

    const atCap = await connector.discover({
      page: NEEDSTAFFING_MAX_LISTING_PAGES - 1,
    });
    expect(atCap.hasMore).toBe(false);
    expect(atCap.truncated).toBe(true);
  });

  it("reports an exhausted walk as not truncated", async () => {
    const connector = createNeedstaffingConnector({
      bronId: "bron-needstaffing-end",
      client: {
        ...cappedClient,
        fetchListing: () => Promise.resolve({ hasNextPage: false, items: [] }),
      },
    });
    const last = await connector.discover(null);
    expect(last.hasMore).toBe(false);
    expect(last.truncated).toBe(false);
  });
});

describe("splitNeedstaffingLocatie — real Locatie field shapes (captured 2026-09-15)", () => {
  it("splits a slash-delimited werkvorm", () => {
    expect(splitNeedstaffingLocatie("Leeuwarden/Hybride")).toEqual({
      locatie: "Leeuwarden",
      werkvorm: "Hybride",
    });
  });

  it("splits a trailing-parenthetical werkvorm", () => {
    expect(splitNeedstaffingLocatie("Maasland (volledig op locatie)")).toEqual({
      locatie: "Maasland",
      werkvorm: "volledig op locatie",
    });
    expect(
      splitNeedstaffingLocatie("Huis ter Heide (2 dagen op locatie)")
    ).toEqual({
      locatie: "Huis ter Heide",
      werkvorm: "2 dagen op locatie",
    });
  });

  it("leaves a plain city with no werkvorm marker untouched", () => {
    expect(splitNeedstaffingLocatie("Den Haag")).toEqual({
      locatie: "Den Haag",
      werkvorm: undefined,
    });
  });

  it("does not read a second slash-separated city as werkvorm (advisor review)", () => {
    expect(splitNeedstaffingLocatie("Utrecht/Amersfoort")).toEqual({
      locatie: "Utrecht/Amersfoort",
      werkvorm: undefined,
    });
  });

  it("does not read a parenthetical district as werkvorm (advisor review)", () => {
    expect(splitNeedstaffingLocatie("Amsterdam (Zuidas)")).toEqual({
      locatie: "Amsterdam (Zuidas)",
      werkvorm: undefined,
    });
  });

  it("returns undefined for both when locatie is absent", () => {
    expect(splitNeedstaffingLocatie()).toEqual({
      locatie: undefined,
      werkvorm: undefined,
    });
  });
});

describe("extractNeedstaffingCompetenties", () => {
  it("reads the Competenties list items as plain skill strings", () => {
    const html =
      "<h2>Eisen</h2><ul><li>Niet dit</li></ul><h2>Competenties</h2><ul><li>Samenwerken</li><li>Overtuigingskracht</li></ul>";
    expect(extractNeedstaffingCompetenties(html)).toEqual([
      "Samenwerken",
      "Overtuigingskracht",
    ]);
  });

  it("returns an empty array when there is no Competenties section", () => {
    expect(
      extractNeedstaffingCompetenties("<h2>Eisen</h2><ul><li>HBO</li></ul>")
    ).toEqual([]);
  });
});
