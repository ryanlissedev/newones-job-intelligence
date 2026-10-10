import { describe, expect, it } from "bun:test";

import {
  CrawlDelayLimiter,
  InMemoryObjectStore,
  InMemoryObservationRecorder,
  InMemoryRunLifecycleStore,
  runConnector,
} from "@ji/connectors";

import {
  createFlinterClient,
  decodeFlinterEntities,
  extractFlinterSlug,
  extractFlinterUrenPerWeek,
  isFlinterLooptijdDuration,
  isFlinterPermanentVacancy,
  parseFlinterDetail,
  parseFlinterListing,
} from "./client";
import type { FlinterClient } from "./client";
import { createFlinterConnector } from "./connector";
import { hashFlinterListingItem } from "./hash";
import type { FlinterListingItem } from "./types";

const retryPolicy = {
  initialDelayMs: 0,
  jitter: (delayMs: number) => delayMs,
  maxAttempts: 1,
  maxDelayMs: 0,
  multiplier: 1,
};

const LISTING_HTML = `
<div class="vacancies-index-container">
  <div class="vacancies-index-wrapper">
    <div class="vacancy-item">
      <h2>Vergunningverlener Agrarisch </h2>
      <div class="vacancy-content">
        <ul>
          <li><svg><path/></svg>Assen</li>
          <li><svg><path/></svg>1 jr</li>
          <li><svg><path/></svg>Omgevingsdienst Drenthe</li>
        </ul>
        <a href="https://www.flinter.nl/opdrachten/vergunningverlener-agrarisch">Lees meer</a>
      </div>
    </div>
    <div class="vacancy-item">
      <h2>Bedrijfsjurist</h2>
      <div class="vacancy-content">
        <ul>
          <li><svg><path/></svg>Gouda</li>
          <li><svg><path/></svg>&gt;1 jr</li>
          <li><svg><path/></svg>Oasen</li>
        </ul>
        <a href="https://www.flinter.nl/opdrachten/bedrijfsjurist">Lees meer</a>
      </div>
    </div>
  </div>
</div>
`;

const ASSIGNMENT_DETAIL_HTML = `
<div class="block-hero-content"><svg><path/></svg><h2>Vergunningverlener Agrarisch </h2></div>
<div class="vacancy-show-job-description">
  <h2>Omgevingsdienst Drenthe</h2>
  <div><p>Flinter zoekt namens Omgevingsdienst Drenthe een Vergunningverlener Agrarisch.</p></div>
</div>
<div class="vacancy-show-function-description">
  <div><p>Praktische zaken:</p><ul><li>Startdatum z.s.m.</li><li>Duur opdracht: 1 jaar (deta-vast is besprekbaar)</li><li>36 uur p/w</li><li>Schaal 10</li></ul></div>
</div>
<aside class="vacancy-show-aside">
  <div class="vacancy-show-aside-content no-image">
    <span>Neem contact op met:</span>
    <h2>Bastiaan van Wijk</h2>
    <div class="vacancy-show-aside-contact">
      <a href="mailto:broker@mail.flinter.nl">broker@mail.flinter.nl</a>
      <a href="tel:+31630236289">+31630236289</a>
    </div>
  </div>
</aside>
`;

const PERMANENT_VACANCY_DETAIL_HTML = `
<div class="block-hero-content"><svg><path/></svg><h2>Bedrijfsjurist</h2></div>
<div class="vacancy-show-job-description">
  <h2>Oasen</h2>
  <div><p>Bedrijfsjurist | 32-40 uur | Gouda</p><p>Wat bieden wij?</p><ul><li><p>Een dienstverband van 32 tot 40 uur per week.</p></li><li><p>Een salaris tussen &euro; 4.238,- en &euro; 6.635,- bruto per maand (o.b.v. 40 uur), afhankelijk van opleiding en ervaring (schaal 10 of 11 CAO Waterbedrijven).</p></li></ul></div>
</div>
<div class="vacancy-show-function-description">
  <div></div>
</div>
`;

describe("parseFlinterListing", () => {
  it("parses each card's title, slug and positional locatie/looptijd/eindklant (regression: today's field order)", () => {
    const items = parseFlinterListing(LISTING_HTML);
    expect(items).toEqual([
      {
        locatiePlaats: "Assen",
        looptijdTekst: "1 jr",
        looptijdValid: true,
        opdrachtgeverNaam: "Omgevingsdienst Drenthe",
        slug: "vergunningverlener-agrarisch",
        titel: "Vergunningverlener Agrarisch",
      },
      {
        locatiePlaats: "Gouda",
        looptijdTekst: ">1 jr",
        looptijdValid: true,
        opdrachtgeverNaam: "Oasen",
        slug: "bedrijfsjurist",
        titel: "Bedrijfsjurist",
      },
    ]);
  });

  it("returns an empty list for a page with no vacancy cards", () => {
    expect(parseFlinterListing("<div>no cards here</div>")).toEqual([]);
  });
});

describe("isFlinterLooptijdDuration (RJC-375 field-order guard)", () => {
  it("accepts the real observed duration formats and plausible neighbours", () => {
    expect(isFlinterLooptijdDuration("1 jr")).toBe(true);
    expect(isFlinterLooptijdDuration(">1 jr")).toBe(true);
    expect(isFlinterLooptijdDuration("6 mnd")).toBe(true);
    expect(isFlinterLooptijdDuration("<3 mnd")).toBe(true);
    expect(isFlinterLooptijdDuration("2,5 jaar")).toBe(true);
    expect(isFlinterLooptijdDuration("12 weken")).toBe(true);
  });

  it("rejects free text with no duration format at all", () => {
    expect(isFlinterLooptijdDuration("Rotterdam")).toBe(false);
    expect(isFlinterLooptijdDuration("Gemeente Rotterdam")).toBe(false);
    expect(isFlinterLooptijdDuration("Flexibele opdracht")).toBe(false);
    expect(isFlinterLooptijdDuration()).toBe(false);
  });
});

describe("parseFlinterListing field-order guard (RJC-375)", () => {
  const REORDERED_TO_FIRST_HTML = `
<div class="vacancy-item">
  <h2>Interim Controller</h2>
  <div class="vacancy-content">
    <ul>
      <li><svg><path/></svg>1 jr</li>
      <li><svg><path/></svg>Rotterdam</li>
      <li><svg><path/></svg>Gemeente Rotterdam</li>
    </ul>
    <a href="https://www.flinter.nl/opdrachten/interim-controller">Lees meer</a>
  </div>
</div>
`;

  const REORDERED_TO_LAST_HTML = `
<div class="vacancy-item">
  <h2>Interim Controller</h2>
  <div class="vacancy-content">
    <ul>
      <li><svg><path/></svg>Rotterdam</li>
      <li><svg><path/></svg>Gemeente Rotterdam</li>
      <li><svg><path/></svg>1 jr</li>
    </ul>
    <a href="https://www.flinter.nl/opdrachten/interim-controller">Lees meer</a>
  </div>
</div>
`;

  const NO_DURATION_MIDDLE_ROW_HTML = `
<div class="vacancy-item">
  <h2>Interim Controller</h2>
  <div class="vacancy-content">
    <ul>
      <li><svg><path/></svg>Rotterdam</li>
      <li><svg><path/></svg>Flexibele opdracht</li>
      <li><svg><path/></svg>Gemeente Rotterdam</li>
    </ul>
    <a href="https://www.flinter.nl/opdrachten/interim-controller">Lees meer</a>
  </div>
</div>
`;

  it("flags looptijdValid false when looptijd has moved to the first position", () => {
    const [item] = parseFlinterListing(REORDERED_TO_FIRST_HTML);
    expect(item?.looptijdValid).toBe(false);
  });

  it("flags looptijdValid false when looptijd has moved to the last position", () => {
    const [item] = parseFlinterListing(REORDERED_TO_LAST_HTML);
    expect(item?.looptijdValid).toBe(false);
  });

  it("flags looptijdValid false when the middle row is free text with no duration at all", () => {
    const [item] = parseFlinterListing(NO_DURATION_MIDDLE_ROW_HTML);
    expect(item?.looptijdValid).toBe(false);
  });
});

describe("extractFlinterSlug", () => {
  it("extracts the last path segment as the slug", () => {
    expect(
      extractFlinterSlug("https://www.flinter.nl/opdrachten/bedrijfsjurist")
    ).toBe("bedrijfsjurist");
    expect(extractFlinterSlug("/opdrachten/interim-teamleider")).toBe(
      "interim-teamleider"
    );
  });

  it("returns undefined for an unparseable href", () => {
    expect(extractFlinterSlug("")).toBeUndefined();
  });
});

describe("extractFlinterUrenPerWeek", () => {
  it("extracts a single unambiguous hours-per-week phrase", () => {
    expect(extractFlinterUrenPerWeek("36 uur p/w")).toBe("36");
    expect(extractFlinterUrenPerWeek("Inzet: 24 uur per week")).toBe("24");
  });

  it("resolves to undefined (UNKNOWN) for an ambiguous range instead of guessing an endpoint", () => {
    expect(
      extractFlinterUrenPerWeek("Inzet: 18-20 uur per week")
    ).toBeUndefined();
    expect(
      extractFlinterUrenPerWeek("Een dienstverband van 32 tot 40 uur per week.")
    ).toBeUndefined();
  });

  it("resolves to undefined when no hours phrase is present at all", () => {
    expect(extractFlinterUrenPerWeek("Schaal 10")).toBeUndefined();
  });
});

describe("isFlinterPermanentVacancy", () => {
  it("flags a salaried dienstverband + bruto-per-maand posting as permanent", () => {
    expect(
      isFlinterPermanentVacancy(
        "Een dienstverband van 32 tot 40 uur per week. Een salaris tussen 4238 en 6635 bruto per maand."
      )
    ).toBe(true);
  });

  it("does not flag a real assignment (Duur opdracht, Schaal, no dienstverband/salaris)", () => {
    expect(
      isFlinterPermanentVacancy(
        "Praktische zaken: Startdatum z.s.m. Duur opdracht: 1 jaar. 36 uur p/w. Schaal 10."
      )
    ).toBe(false);
  });
});

describe("parseFlinterDetail", () => {
  it("parses titel and beschrijving, and never surfaces the recruiter contact block", () => {
    const detail = parseFlinterDetail(
      ASSIGNMENT_DETAIL_HTML,
      "vergunningverlener-agrarisch"
    );
    expect(detail.titel).toBe("Vergunningverlener Agrarisch");
    expect(detail.isPermanentVacancy).toBe(false);
    expect(detail.urenPerWeek).toBe("36");
    expect(detail.beschrijvingHtml).toContain("Vergunningverlener Agrarisch");
    expect(detail.beschrijvingHtml).not.toContain("Bastiaan van Wijk");
    expect(detail.beschrijvingHtml).not.toContain("broker@mail.flinter.nl");
    expect(detail.beschrijvingHtml).not.toContain("+31630236289");
  });

  it("flags a permanent-employment posting and leaves uren_per_week UNKNOWN for its ambiguous range", () => {
    const detail = parseFlinterDetail(
      PERMANENT_VACANCY_DETAIL_HTML,
      "bedrijfsjurist"
    );
    expect(detail.isPermanentVacancy).toBe(true);
    expect(detail.urenPerWeek).toBeUndefined();
  });
});

describe("decodeFlinterEntities (RJC-374 guard, wired through this source)", () => {
  it("leaves an out-of-range numeric entity untouched instead of throwing", () => {
    expect(() => decodeFlinterEntities("&#1114112;")).not.toThrow();
    expect(decodeFlinterEntities("&#1114112;")).toBe("&#1114112;");
  });

  it("leaves a lone-surrogate numeric entity untouched instead of throwing", () => {
    expect(() => decodeFlinterEntities("&#xD800;")).not.toThrow();
    expect(decodeFlinterEntities("&#xD800;")).toBe("&#xD800;");
  });

  it("still decodes real entities confirmed live in Flinter listing text", () => {
    expect(decodeFlinterEntities("Recht &amp; Bestuur")).toBe(
      "Recht & Bestuur"
    );
    expect(decodeFlinterEntities("&#039;t Gooi")).toBe("'t Gooi");
  });
});

describe("Flinter connector", () => {
  it("ingests the real fixture listing (1 assignment, 1 permanent vacancy) with the permanent one rejected", async () => {
    const bronId = "bron-flinter-fixture";
    const result = await runConnector({
      bronId,
      bronSlug: "flinter",
      checkpoint: null,
      connector: createFlinterConnector({
        bronId,
        client: createFlinterClient({ liveEnabled: false }),
      }),
      limiter: new CrawlDelayLimiter({ crawlDelayMs: 0 }),
      objectStore: new InMemoryObjectStore(),
      observationRecorder: new InMemoryObservationRecorder(),
      rawRetentionDays: 90,
      retryPolicy,
      runKind: "test",
      runLifecycleStore: new InMemoryRunLifecycleStore(),
      scrapeRunId: "run-flinter-1",
      startedAt: new Date("2026-08-31T13:31:09.000Z"),
    });

    expect(result.metrics.found).toBe(2);
    expect(result.metrics.new).toBe(1);
    expect(result.metrics.rejected).toBe(1);
    expect(result.metrics.error).toBe(0);
  });

  it("replays fixture ingest without duplicate source records", async () => {
    const bronId = "bron-flinter-replay";
    const recorder = new InMemoryObservationRecorder();
    const objectStore = new InMemoryObjectStore();
    const connector = createFlinterConnector({
      bronId,
      client: createFlinterClient({ liveEnabled: false }),
    });
    const sharedInput = {
      bronId,
      bronSlug: "flinter" as const,
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

    await runConnector({ ...sharedInput, scrapeRunId: "run-flinter-replay-1" });
    await runConnector({ ...sharedInput, scrapeRunId: "run-flinter-replay-2" });

    expect(recorder.records.length).toBeGreaterThan(0);
    expect(
      new Set(recorder.records.map((record) => record.bronReferentie)).size
    ).toBe(recorder.records.length);
  });

  it("skips detail fetches for listing rows whose hash is already known", async () => {
    const bronId = "bron-flinter-known-hash";
    const items: FlinterListingItem[] = [
      { slug: "interim-teamleider", titel: "Interim-teamleider" },
    ];
    const client: FlinterClient = {
      fetchDetailHtml: () =>
        Promise.reject(new Error("fetchDetailHtml should not be called")),
      fetchListing: () => Promise.resolve(items),
    };
    const [item] = items;
    if (!item) {
      throw new Error("Expected a fixture listing item");
    }
    const knownHash = await hashFlinterListingItem(item);
    const knownHashes = {
      get: (_bronId: string, bronReferentie: string) =>
        Promise.resolve(
          bronReferentie === "interim-teamleider" ? knownHash : null
        ),
    };
    const connector = createFlinterConnector({ bronId, client, knownHashes });
    const discovery = await connector.discover(null);
    expect(discovery.items).toHaveLength(1);
    expect(discovery.hasMore).toBe(false);
    const [discoveredItem] = discovery.items;
    if (!discoveredItem) {
      throw new Error("Expected a discovered item");
    }
    const fetched = await connector.fetch(discoveredItem);
    expect(fetched).toBeNull();
  });

  it("rejects a detail page with an empty/missing titel instead of ingesting it", async () => {
    const bronId = "bron-flinter-malformed";
    const items: FlinterListingItem[] = [
      { slug: "placeholder", titel: "Placeholder Titel" },
    ];
    const client: FlinterClient = {
      fetchDetailHtml: () =>
        Promise.resolve(
          '<div class="block-hero-content"><h2></h2></div><div class="vacancy-show-job-description"></div>'
        ),
      fetchListing: () => Promise.resolve(items),
    };
    const connector = createFlinterConnector({ bronId, client });
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

  it("rejects a card whose field order changed instead of silently swapping locatie/opdrachtgever, with an explicit reason", async () => {
    const bronId = "bron-flinter-field-order-guard";
    const items: FlinterListingItem[] = [
      {
        locatiePlaats: "1 jr",
        looptijdTekst: "Rotterdam",
        looptijdValid: false,
        opdrachtgeverNaam: "Gemeente Rotterdam",
        slug: "interim-controller",
        titel: "Interim Controller",
      },
    ];
    const client: FlinterClient = {
      fetchDetailHtml: () =>
        Promise.reject(
          new Error(
            "fetchDetailHtml should not be called for a field-order-rejected card"
          )
        ),
      fetchListing: () => Promise.resolve(items),
    };
    const connector = createFlinterConnector({ bronId, client });
    const discovery = await connector.discover(null);
    const [discoveredItem] = discovery.items;
    if (!discoveredItem) {
      throw new Error("Expected a discovered item");
    }
    const fetched = await connector.fetch(discoveredItem);
    expect(fetched).toMatchObject({
      reason:
        "listing field order guard: middle icon row does not match the expected looptijd duration format -- locatie/looptijd/opdrachtgever field order may have changed",
      status: "rejected",
    });
    expect(fetched).not.toHaveProperty("body");
  });

  it("rejects a permanent-employment vacancy instead of ingesting it as an aanvraag", async () => {
    const bronId = "bron-flinter-permanent";
    const items: FlinterListingItem[] = [
      { slug: "bedrijfsjurist", titel: "Bedrijfsjurist" },
    ];
    const client: FlinterClient = {
      fetchDetailHtml: () => Promise.resolve(PERMANENT_VACANCY_DETAIL_HTML),
      fetchListing: () => Promise.resolve(items),
    };
    const connector = createFlinterConnector({ bronId, client });
    const discovery = await connector.discover(null);
    const [discoveredItem] = discovery.items;
    if (!discoveredItem) {
      throw new Error("Expected a discovered item");
    }
    const fetched = await connector.fetch(discoveredItem);
    expect(fetched).toMatchObject({
      reason:
        "permanent-employment vacancy (dienstverband + bruto salaris), not a temporary assignment",
      status: "rejected",
    });
  });
});
