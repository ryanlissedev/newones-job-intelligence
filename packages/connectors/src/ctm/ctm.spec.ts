import { describe, expect, it } from "bun:test";

import {
  CrawlDelayLimiter,
  createCtmConnector,
  InMemoryObjectStore,
  InMemoryObservationRecorder,
  InMemoryRunLifecycleStore,
  runConnector,
} from "@ji/connectors";

import {
  createCtmClient,
  extractCtmAanvraagnummer,
  parseCtmFeed,
} from "./client";
import type { CtmClient } from "./client";
import { hashCtmListingItem } from "./hash";
import type { CtmEntry } from "./types";

const retryPolicy = {
  initialDelayMs: 0,
  jitter: (delayMs: number) => delayMs,
  maxAttempts: 1,
  maxDelayMs: 0,
  multiplier: 1,
};

/** Trimmed, sanitised sample of the real CTM/EU-Supply Atom feed (captured 2026-08-30). */
const SAMPLE_FEED_XML = `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title type="text">EU-Supply current opportunities</title><id>https://eu.eu-supply.com/rss/rss.ashx?type=transactions</id><updated>2026-08-30T22:04:57Z</updated><entry><id>https://eu.eu-supply.com/app/rfq/rwlentrance_s.asp?PID=460057&amp;PP=transactions.asp&amp;B=CTMSOLUTION&amp;PS=1</id><title type="text">Openbare Europese aanbesteding voor onderhoud blusmiddelen en noodverlichting</title><published>2026-08-26T04:34:00+02:00</published><author><name>Anculus B.V.</name></author><link href="https://eu.eu-supply.com/app/rfq/rwlentrance_s.asp?PID=460057&amp;PP=transactions.asp&amp;B=CTMSOLUTION&amp;PS=1" /><content type="text/xml"><publication xmlns="http://www.eu-supply.com/Rss/Publications"><publishedTime>2026-08-26T04:34:00</publishedTime><etq>2026-10-13T11:00:00</etq><sentToOjeu>false</sentToOjeu><authority name="Anculus B.V." address1="Anderlechtstraat 15" address2="5628 WB " address3="Eindhoven" /><contactPerson firstName="" middleName="" lastName="" email=""><phone countryCode="" areaCode="" munber="" /></contactPerson><cpvCodes><cpvCode code="35111320-4" name="Portable fire-extinguishers" /><cpvCode code="50700000-2" name="Repair and maintenance services of building installations" /></cpvCodes><processTemplate>02 - Openbare procedure</processTemplate></publication></content></entry><entry><id>https://eu.eu-supply.com/app/rfq/rwlentrance_s.asp?PID=459469&amp;PP=transactions.asp&amp;B=CTMSOLUTION&amp;PS=1</id><title type="text">Stichting OSG Twente - raamovereenkomst touringcarvervoer</title><published>2026-08-11T02:19:00+02:00</published><author><name>Anculus B.V.</name></author><link href="https://eu.eu-supply.com/app/rfq/rwlentrance_s.asp?PID=459469&amp;PP=transactions.asp&amp;B=CTMSOLUTION&amp;PS=1" /><content type="text/xml"><publication xmlns="http://www.eu-supply.com/Rss/Publications"><publishedTime>2026-08-11T02:19:00</publishedTime><etq>2026-09-21T11:00:00</etq><sentToOjeu>false</sentToOjeu><authority name="Anculus B.V." address1="Anderlechtstraat 15" address2="5628 WB " address3="Eindhoven" /><contactPerson firstName="" middleName="" lastName="" email=""><phone countryCode="" areaCode="" munber="" /></contactPerson><cpvCodes><cpvCode code="34121000-1" name="Buses and coaches" /></cpvCodes><processTemplate>02 - Openbare procedure</processTemplate></publication></content></entry></feed>`;

describe("CTM feed parser", () => {
  it("parses Atom entries into typed CTM entries", () => {
    const listing = parseCtmFeed(SAMPLE_FEED_XML);

    expect(listing.entries).toHaveLength(2);
    expect(listing.updatedAt).toBe("2026-08-30T22:04:57Z");
    expect(listing.entries[0]).toMatchObject({
      aanvraagnummer: "460057",
      organisatie: "Anculus B.V.",
      procedure: "02 - Openbare procedure",
      sluitingstijd: "2026-10-13T11:00:00",
      titel:
        "Openbare Europese aanbesteding voor onderhoud blusmiddelen en noodverlichting",
    });
    expect(listing.entries[0]?.cpv).toEqual([
      { code: "35111320-4", name: "Portable fire-extinguishers" },
      {
        code: "50700000-2",
        name: "Repair and maintenance services of building installations",
      },
    ]);
  });

  it("parses a populated <contactPerson> into entry.contactpersonen (CTP-610)", () => {
    const xml = SAMPLE_FEED_XML.replace(
      '<contactPerson firstName="" middleName="" lastName="" email=""><phone countryCode="" areaCode="" munber="" /></contactPerson>',
      '<contactPerson firstName="A." middleName="" lastName="de Vries" email="redacted@example.invalid"><phone countryCode="+31" areaCode="20" munber="0000000" /></contactPerson>'
    );
    const listing = parseCtmFeed(xml);
    expect(listing.entries[0]?.contactpersonen).toEqual([
      {
        email: "redacted@example.invalid",
        naam: "A. de Vries",
        telefoon: "+31200000000",
      },
    ]);
    // The second entry keeps the all-empty contactPerson element -> absent.
    expect(listing.entries[1]?.contactpersonen).toBeUndefined();
  });

  it("extracts the PID as the stable aanvraagnummer, falling back to the raw id", () => {
    expect(
      extractCtmAanvraagnummer(
        "https://eu.eu-supply.com/app/rfq/rwlentrance_s.asp?PID=460057&PP=transactions.asp"
      )
    ).toBe("460057");
    expect(extractCtmAanvraagnummer("urn:no-pid-here")).toBe("urn:no-pid-here");
  });

  it("throws on malformed XML instead of silently returning an empty page", () => {
    expect(() => parseCtmFeed("<feed><entry><title>unterminated")).toThrow();
  });

  it("skips entries missing a required id or title rather than throwing", () => {
    const feedWithGap = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><updated>2026-08-30T22:04:57Z</updated><entry><title type="text">No id here</title></entry></feed>`;
    expect(parseCtmFeed(feedWithGap).entries).toHaveLength(0);
  });

  it("keeps a purely numeric title and etq as strings instead of coercing to numbers", () => {
    const feedWithNumericFields = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><updated>2026-08-30T22:04:57Z</updated><entry><id>https://eu.eu-supply.com/x?PID=1</id><title type="text">2026</title><content type="text/xml"><publication xmlns="http://www.eu-supply.com/Rss/Publications"><etq>20261013</etq></publication></content></entry></feed>`;
    const [entry] = parseCtmFeed(feedWithNumericFields).entries;
    expect(entry?.titel).toBe("2026");
    expect(entry?.sluitingstijd).toBe("20261013");
  });
});

describe("CTM connector", () => {
  it("ingests feed fixtures with found/new/changed/rejected/error metrics", async () => {
    const bronId = "bron-ctm-fixture";
    const result = await runConnector({
      bronId,
      bronSlug: "ctm",
      checkpoint: null,
      connector: createCtmConnector({
        bronId,
        client: createCtmClient({ liveEnabled: false }),
      }),
      limiter: new CrawlDelayLimiter({ crawlDelayMs: 0 }),
      objectStore: new InMemoryObjectStore(),
      observationRecorder: new InMemoryObservationRecorder(),
      rawRetentionDays: 90,
      retryPolicy,
      runKind: "test",
      runLifecycleStore: new InMemoryRunLifecycleStore(),
      scrapeRunId: "run-ctm-1",
      startedAt: new Date("2026-08-30T22:10:00.000Z"),
    });

    expect(result.metrics).toMatchObject({
      changed: 0,
      error: 0,
      found: 5,
      new: 5,
      rejected: 0,
    });
  });

  it("replays fixture ingest without duplicate source records", async () => {
    const bronId = "bron-ctm-replay";
    const recorder = new InMemoryObservationRecorder();
    const objectStore = new InMemoryObjectStore();
    const connector = createCtmConnector({
      bronId,
      client: createCtmClient({ liveEnabled: false }),
    });
    const sharedInput = {
      bronId,
      bronSlug: "ctm" as const,
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

    await runConnector({ ...sharedInput, scrapeRunId: "run-ctm-replay-1" });
    await runConnector({ ...sharedInput, scrapeRunId: "run-ctm-replay-2" });

    expect(recorder.records).toHaveLength(5);
    expect(
      new Set(recorder.records.map((record) => record.bronReferentie)).size
    ).toBe(5);
  });

  it("reports the feed as a single, non-paginated window (hasMore: false)", async () => {
    const bronId = "bron-ctm-window";
    const connector = createCtmConnector({
      bronId,
      client: createCtmClient({ liveEnabled: false }),
    });

    const result = await connector.discover(null);
    expect(result.hasMore).toBe(false);
    expect(result.items).toHaveLength(5);
    expect(result.checkpoint.cursor).toBe("2026-08-30T22:04:57Z");
  });

  it("rejects listing payloads missing a required field", async () => {
    const bronId = "bron-ctm-rejected";
    const client: CtmClient = {
      fetchListing: () =>
        Promise.resolve({
          entries: [
            {
              aanvraagnummer: "",
              link: "https://eu.eu-supply.com/x",
              titel: "Untitled",
            } satisfies CtmEntry,
          ],
        }),
    };
    const connector = createCtmConnector({ bronId, client });
    const discovered = await connector.discover(null);
    const [item] = discovered.items;
    if (!item) {
      throw new Error("expected discover() to return one item");
    }
    const fetched = await connector.fetch({
      ...item,
      listingPayload: { link: "https://eu.eu-supply.com/x", titel: "" },
    });

    expect(fetched).toMatchObject({ status: "rejected" });
  });
});

describe("CTM listing hash coverage (RJC-357 / RJC-401)", () => {
  const baseEntry: CtmEntry = {
    aanvraagnummer: "460057",
    link: "https://eu.eu-supply.com/app/rfq/rwlentrance_s.asp?PID=460057",
    titel: "Openbare Europese aanbesteding",
  };

  it("changes when the link changes, so a moved bronUrl can never be skipped past", async () => {
    const moved = await hashCtmListingItem({
      ...baseEntry,
      link: "https://eu.eu-supply.com/app/rfq/rwlentrance_s.asp?PID=999999",
    });
    expect(moved).not.toBe(await hashCtmListingItem(baseEntry));
  });

  it("covers every CtmEntry field the normaliser can read", async () => {
    const variants: Partial<CtmEntry>[] = [
      { aanvraagnummer: "999" },
      {
        contactpersonen: [
          { email: "redacted@example.invalid", naam: "A. de Vries" },
        ],
      },
      { cpv: [{ code: "35111320-4", name: "Portable fire-extinguishers" }] },
      { link: "https://example.test/other" },
      { organisatie: "Andere Organisatie" },
      { procedure: "01 - Niet-openbare procedure" },
      { publicatiedatum: "2026-08-27T00:00:00" },
      { referentie: "REF-1" },
      { sluitingstijd: "2026-12-01T11:00:00" },
      { titel: "Andere titel" },
    ];
    const base = await hashCtmListingItem(baseEntry);
    for (const variant of variants) {
      // oxlint-disable-next-line no-await-in-loop -- sequential hash comparisons keep the failure message per-field
      const changed = await hashCtmListingItem({ ...baseEntry, ...variant });
      expect(changed).not.toBe(base);
    }
  });
});
