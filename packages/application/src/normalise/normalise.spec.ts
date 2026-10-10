import { describe, expect, it } from "bun:test";

import {
  curateObservation,
  InMemoryCurateStore,
  processObservation,
  splitDedupGroep,
} from "@ji/application/identity";
import {
  buildDedupKey,
  normaliseInhuurdeskObservation,
  normalizeDedupText,
  parseTariefFromText,
  parseTenderNedPayload,
  validateNormalisedDraft,
} from "@ji/application/normalise";
import { hashContent, loadConnectorFixture } from "@ji/connectors";
import type { InhuurdeskFetchedPayload } from "@ji/connectors/inhuurdesk";
import type { NeedstaffingFetchedPayload } from "@ji/connectors/needstaffing";
import type {
  OpdrachtoverheidFetchedPayload,
  OpdrachtoverheidListingResponse,
} from "@ji/connectors/opdrachtoverheid";
import type { TenderNedFetchedPayload } from "@ji/connectors/tenderned";
import { UNKNOWN } from "@ji/domain";

import { parseNeedstaffingPayload } from "./needstaffing";
import { parseOpdrachtoverheidPayload } from "./opdrachtoverheid";

const TENDER_NED_HASH = "sha256-test";

const buildTenderNedPayload = (ids: {
  kenmerk: number | string | null;
  publicatieId: number | string;
}): TenderNedFetchedPayload => {
  const rawDetail = [
    '{"aanbestedingNaam":"Platform engineer Azure DAS"',
    '"aankondigingCode":{"code":"AAO"}',
    `"kenmerk":${JSON.stringify(ids.kenmerk)}`,
    '"numberOfDaysBeforeAanmeldenInschrijven":14',
    '"opdrachtBeschrijving":"Volledige detailbeschrijving."',
    '"opdrachtgeverNaam":"Gemeente Amsterdam"',
    '"publicatieDatum":"2026-08-28T12:15:00+02:00"',
    `"publicatieId":${JSON.stringify(ids.publicatieId)}}`,
  ].join(",");
  // SAFETY: parsing raw JSON reproduces live TenderNed responses, where ids
  // arrive as numbers despite the declared string types.
  const detail = JSON.parse(rawDetail) as TenderNedFetchedPayload["detail"];
  return {
    detail,
    listing: detail,
    publicatieId: String(ids.publicatieId),
  };
};

const buildInhuurdeskBody = (description: string): Uint8Array => {
  const payload: InhuurdeskFetchedPayload = {
    assignment: {
      clientName: "Alliander",
      content: description,
      id: "ih-ae6-001",
      location: "Duiven",
      startDate: "2026-09-01T00:00:00",
      title: "Senior Java Developer",
    },
  };
  return new TextEncoder().encode(JSON.stringify(payload));
};

describe("normalise", () => {
  it("passes the observation instant to the TenderNed normaliser (CTP-531)", async () => {
    const store = new InMemoryCurateStore();
    const observedAt = new Date("2026-09-01T12:00:00.000Z");
    const body = new TextEncoder().encode(
      JSON.stringify(
        buildTenderNedPayload({ kenmerk: "TN-531", publicatieId: "pub-531" })
      )
    );

    const result = await processObservation(store, {
      body,
      bronId: "bron-tenderned-531",
      bronSlug: "tenderned",
      contentHash: TENDER_NED_HASH,
      observedAt,
      rawPayloadRef: "raw/tenderned-531.json",
      scrapeRunId: "run-tenderned-531",
    });

    expect(result.status).toBe("curated");
    expect(store.aanvragen[0]?.sluitingsdatum).toEqual(
      new Date("2026-09-15T12:00:00.000Z")
    );
  });

  it("builds an unambiguous Postgres-safe dedup key", () => {
    const dedupKey = buildDedupKey({
      opdrachtgeverNaam: "Gemeente\u001F Amsterdam",
      startDatum: "2026-09-01",
      titel: "Senior\u001F Developer",
    });

    expect(dedupKey).toBe(
      "senior developer\u001Fgemeente amsterdam\u001F2026-09-01"
    );
    expect(dedupKey).not.toContain("\u0000");
  });

  it("keeps a unit separator distinct from no separator", () => {
    expect(normalizeDedupText("foo\u001Fbar")).not.toBe(
      normalizeDedupText("foobar")
    );
  });

  it("covers AE6: unstructured tarief stays in beschrijving with unknown structured fields", async () => {
    const body = buildInhuurdeskBody(
      "<p>Rolomschrijving zonder tariefstructuur.</p><p>Tarief wordt in overleg bepaald.</p>"
    );
    const contentHash = await hashContent(body);
    const draft = normaliseInhuurdeskObservation(body, contentHash);

    expect(draft.tarief.max).toBe(UNKNOWN);
    expect(draft.tarief.min).toBe(UNKNOWN);
    expect(draft.beschrijving.value).toContain(
      "Tarief wordt in overleg bepaald"
    );
  });

  it("parses a single clear max tarief from HTML text", () => {
    const parsed = parseTariefFromText(
      "Max tarief €110 incl msp fee per uur voor deze rol."
    );
    expect(parsed.max).toBe("110");
    expect(parsed.eenheid).toBe("uur");
  });

  it("quarantines schema-invalid observations", async () => {
    const store = new InMemoryCurateStore();
    const payload: InhuurdeskFetchedPayload = {
      assignment: {
        clientName: "Alliander",
        content: "Beschrijving",
        id: "ih-invalid",
        title: "   ",
      },
    };
    const body = new TextEncoder().encode(JSON.stringify(payload));
    const result = await processObservation(store, {
      body,
      bronId: "bron-invalid",
      bronSlug: "inhuurdesk",
      contentHash: "hash-invalid",
      observedAt: new Date("2026-08-28T10:00:00.000Z"),
      rawPayloadRef: "raw/invalid.json",
      scrapeRunId: "run-invalid",
    });

    expect(result.status).toBe("quarantined");
    expect(store.aanvragen).toHaveLength(0);
  });

  it("keeps Inhuurdesk active when no closingDateClient is present (absent stays absent)", async () => {
    const body = buildInhuurdeskBody("<p>Rolomschrijving.</p>");
    const contentHash = await hashContent(body);
    const draft = normaliseInhuurdeskObservation(body, contentHash);

    expect(draft.lifecycle).not.toBe("closed");
    expect(draft.status).not.toBe("closed");
  });
});

describe("normalise tenderned", () => {
  it("coerces a numeric kenmerk to a string bronReferentie that validates", () => {
    const draft = parseTenderNedPayload(
      buildTenderNedPayload({ kenmerk: 563_214, publicatieId: 608_998 }),
      TENDER_NED_HASH
    );

    expect(draft.bronReferentie.value).toBe("563214");
    expect(draft.bronReferentie.value).toBeTypeOf("string");
    expect(() => validateNormalisedDraft(draft)).not.toThrow();
    expect(
      validateNormalisedDraft(draft).filter(
        (issue) => issue.field === "bron_referentie"
      )
    ).toEqual([]);
  });

  it("coerces a numeric publicatieId into the bronUrl and bronSpecifiek", () => {
    const draft = parseTenderNedPayload(
      buildTenderNedPayload({ kenmerk: 563_214, publicatieId: 608_998 }),
      TENDER_NED_HASH
    );

    expect(draft.bronUrl.value).toBe(
      "https://www.tenderned.nl/aankondigingen/overzicht/608998"
    );
    // SAFETY: parseTenderNedPayload always emits an object with publicatie_id.
    const specifiek = draft.bronSpecifiek.value as { publicatie_id: unknown };
    expect(specifiek.publicatie_id).toBe("608998");
    expect(specifiek.publicatie_id).toBeTypeOf("string");
  });

  it("keeps string ids from fixtures unchanged", () => {
    const draft = parseTenderNedPayload(
      buildTenderNedPayload({
        kenmerk: "TN563214",
        publicatieId: "fixture-pub-001",
      }),
      TENDER_NED_HASH
    );

    expect(draft.bronReferentie.value).toBe("TN563214");
    expect(draft.bronUrl.value).toBe(
      "https://www.tenderned.nl/aankondigingen/overzicht/fixture-pub-001"
    );
    expect(validateNormalisedDraft(draft)).toEqual([]);
  });

  it("still reports an empty bron_referentie as an issue", () => {
    const draft = parseTenderNedPayload(
      buildTenderNedPayload({ kenmerk: null, publicatieId: 608_998 }),
      TENDER_NED_HASH
    );

    expect(validateNormalisedDraft(draft)).toEqual([
      { field: "bron_referentie", message: "bron_referentie is required" },
    ]);
  });

  it("stays hard-false on sluitingsdatumPassed (no closing date at this source) yet still closes via aankondigingCode (RJC-377)", () => {
    const rawDetail = [
      '{"aanbestedingNaam":"Platform engineer Azure DAS"',
      '"aankondigingCode":{"code":"AGO"}',
      '"kenmerk":"TN563214"',
      '"numberOfDaysBeforeAanmeldenInschrijven":14',
      '"opdrachtBeschrijving":"Volledige detailbeschrijving."',
      '"opdrachtgeverNaam":"Gemeente Amsterdam"',
      '"publicatieDatum":"2026-08-28T12:15:00+02:00"',
      '"publicatieId":"fixture-pub-001"}',
    ].join(",");
    // SAFETY: rawDetail above is a literal object matching the shape of
    // TenderNedFetchedPayload["detail"] (same pattern as buildTenderNedPayload).
    const detail = JSON.parse(rawDetail) as TenderNedFetchedPayload["detail"];
    const draft = parseTenderNedPayload(
      { detail, listing: detail, publicatieId: "fixture-pub-001" },
      TENDER_NED_HASH
    );

    expect(draft.lifecycle).toBe("closed");
    expect(draft.status).toBe("closed");
  });

  it("stays open when neither the day-count nor the aankondigingCode signal closure", () => {
    const draft = parseTenderNedPayload(
      buildTenderNedPayload({ kenmerk: 563_214, publicatieId: 608_998 }),
      TENDER_NED_HASH
    );

    expect(draft.lifecycle).not.toBe("closed");
  });

  it("maps fixture nutsCodes NL329 to locatie_tekst Groot-Amsterdam (CTP-506)", async () => {
    const fixture = await loadConnectorFixture<
      TenderNedFetchedPayload["detail"]
    >("tenderned/detail-pub-001.json");
    const detail = fixture.payload;
    const draft = parseTenderNedPayload(
      { detail, listing: detail, publicatieId: detail.publicatieId },
      TENDER_NED_HASH
    );

    expect(detail.nutsCodes).toEqual(["NL329"]);
    expect(draft.locatieTekst.value).toBe("Groot-Amsterdam");
    expect(draft.parserVersion).toBe("tenderned/v3");
  });
});

const buildNeedstaffingPayload = (
  overrides: Partial<NeedstaffingFetchedPayload["detail"]> = {}
): NeedstaffingFetchedPayload => ({
  detail: {
    deadline: "1788778800000",
    id: "15520",
    locatie: "Den Haag",
    periode: "4 maanden",
    referentie: "2026-BZB-0457",
    start: "1790380800000",
    tarief: "€98-102",
    tariefMax: "102",
    tariefMin: "98",
    titel: "Operationeel Database Ontwikkelaar 2026-BZB-0457",
    uren: "36",
    ...overrides,
  },
  listing: {
    id: "15520",
    opdrachtgeverNaam: "Belastingdienst",
    titel: "Operationeel Database Ontwikkelaar 2026-BZB-0457",
  },
  raw: { html: "<p>Rolomschrijving voor database ontwikkelaar.</p>" },
});

describe("normalise needstaffing", () => {
  it("keeps a parsed tarief band but leaves its unit unknown when the source does not publish one", () => {
    const draft = parseNeedstaffingPayload(
      buildNeedstaffingPayload(),
      "hash-needstaffing"
    );

    expect(draft.tarief.min).toBe("98");
    expect(draft.tarief.max).toBe("102");
    expect(draft.tarief.eenheid).toBe(UNKNOWN);
    expect(draft.parserVersion).toBe("needstaffing/v5");
    expect(draft.startDatum.value).toBe("2026-09-26");
    expect(draft.bronReferentie.value).toBe("15520");
    expect(draft.bronUrl.value).toBe(
      "https://www.needstaffing.nl/Opdrachten/15520"
    );
    expect(draft.opdrachtgeverNaam.value).toBe("Belastingdienst");
    expect(draft.beschrijving.value).toContain(
      "Rolomschrijving voor database ontwikkelaar"
    );
    expect(draft.bronSpecifiek.value).toMatchObject({
      uren: "36",
      uren_per_week: "36",
    });
    expect(validateNormalisedDraft(draft)).toEqual([]);
  });

  it("sets the tarief unit for an explicit per-hour source band", () => {
    const draft = parseNeedstaffingPayload(
      buildNeedstaffingPayload({
        tarief: "€80,- / €95,- per uur all-in ex.btw",
        tariefMax: "95",
        tariefMin: "80",
      }),
      "hash-needstaffing-hourly"
    );

    expect(draft.tarief).toEqual({
      eenheid: "uur",
      max: "95",
      min: "80",
      valuta: "EUR",
    });
  });

  it("decodes entities in the canonical plain description", () => {
    const draft = parseNeedstaffingPayload(
      {
        ...buildNeedstaffingPayload(),
        raw: {
          html: "<p>Inrichten en ontwikkelen van datastromen (van bron ontsluiting tot dashboard &amp; applicaties)</p>",
        },
      },
      "hash-needstaffing-entities"
    );

    expect(draft.beschrijving.value).toBe(
      "Inrichten en ontwikkelen van datastromen (van bron ontsluiting tot dashboard & applicaties)"
    );
  });

  it("removes source tags before retaining escaped angle-bracket text", () => {
    const draft = parseNeedstaffingPayload(
      {
        ...buildNeedstaffingPayload(),
        raw: {
          html: "<p>Een team van &lt;5 werknemers&gt; zoekt een <strong>engineer.</strong></p>",
        },
      },
      "hash-needstaffing-angle-text"
    );

    expect(draft.beschrijving.value).toBe(
      "Een team van <5 werknemers> zoekt een engineer."
    );
  });

  it("falls back to UNKNOWN when tarief or start data is missing", () => {
    const draft = parseNeedstaffingPayload(
      buildNeedstaffingPayload({
        deadline: undefined,
        start: undefined,
        tariefMax: undefined,
        tariefMin: undefined,
      }),
      "hash-needstaffing-unknown"
    );

    expect(draft.tarief.min).toBe(UNKNOWN);
    expect(draft.tarief.max).toBe(UNKNOWN);
    expect(draft.startDatum.value).toBe(UNKNOWN);
  });

  it("closes lifecycle once the epoch-ms deadline has passed (RJC-377)", () => {
    const draft = parseNeedstaffingPayload(
      buildNeedstaffingPayload({ deadline: String(Date.parse("2000-01-01")) }),
      "hash-needstaffing-closed-past"
    );

    expect(draft.lifecycle).toBe("closed");
    expect(draft.status).toBe("closed");
  });

  it("stays active while the epoch-ms deadline is still in the future", () => {
    const draft = parseNeedstaffingPayload(
      buildNeedstaffingPayload({ deadline: String(Date.parse("2099-01-01")) }),
      "hash-needstaffing-active-future"
    );

    expect(draft.lifecycle).toBe("active");
    expect(draft.status).toBe("active");
  });

  it("stays active when the deadline is a few minutes from now (RJC-376-style boundary)", () => {
    const draft = parseNeedstaffingPayload(
      buildNeedstaffingPayload({
        deadline: String(Date.now() + 5 * 60 * 1000),
      }),
      "hash-needstaffing-later-today"
    );

    expect(draft.lifecycle).toBe("active");
  });

  it("stays unknown/open rather than auto-closing when the deadline is absent or unparsable", () => {
    const missing = parseNeedstaffingPayload(
      buildNeedstaffingPayload({ deadline: undefined }),
      "hash-needstaffing-no-deadline"
    );
    expect(missing.lifecycle).not.toBe("closed");

    const malformed = parseNeedstaffingPayload(
      buildNeedstaffingPayload({ deadline: "not-a-number" }),
      "hash-needstaffing-bad-deadline"
    );
    expect(malformed.lifecycle).not.toBe("closed");
  });

  it("never reads an empty/whitespace/absurd deadline as epoch 1970 (RJC-377 amendment, codex review)", () => {
    // Number("") and Number(" ") are 0 in JS -- that used to resolve to
    // epoch 1970, a false "already closed". 1e20 and a negative value must
    // not throw or reach new Date() as a bogus instant either.
    for (const deadline of ["", " ", "1e20", "-100000000000"]) {
      const draft = parseNeedstaffingPayload(
        buildNeedstaffingPayload({ deadline }),
        `hash-needstaffing-edge-${deadline || "empty"}`
      );
      expect(draft.lifecycle).not.toBe("closed");
    }
  });
});

const buildOpdrachtoverheidPayload = (
  overrides: Partial<OpdrachtoverheidFetchedPayload["tender"]> = {}
): OpdrachtoverheidFetchedPayload => ({
  jobPosting: null,
  tender: {
    contract_type: "detachering",
    opdracht_overheid_url:
      "https://www.opdrachtoverheid.nl/inhuuropdracht/Enexis/Senior-Coordinator/36A6A824",
    tender_buying_organization: "Enexis",
    tender_id: "harveynash_298847",
    tender_job_location: null,
    tender_max_hours: 40,
    tender_maximum_tariff: 119,
    tender_min_hours: 32,
    tender_name: "Senior Project- en Programmacoordinator Grootzakelijk",
    tender_no_max_tariff: false,
    tender_source: "harveynash",
    tender_start_date: "2026-08-29",
    tender_url:
      "https://www.harveynash.nl/vacatures/298847-Senior-Project--en-Programmacoordinator-Grootzakelijk",
    web_key: "36A6A824-B5F2-4D3E-A749-425BA6B99EDD",
    ...overrides,
  },
});

describe("normalise opdrachtoverheid", () => {
  it("uses tender_id as the stable bron_referentie", () => {
    const draft = parseOpdrachtoverheidPayload(
      buildOpdrachtoverheidPayload(),
      "hash-oo-1"
    );

    expect(draft.bronReferentie.value).toBe("harveynash_298847");
    expect(validateNormalisedDraft(draft)).toEqual([]);
  });

  it("parses tender_maximum_tariff as a numeric hourly max tarief", () => {
    const draft = parseOpdrachtoverheidPayload(
      buildOpdrachtoverheidPayload(),
      "hash-oo-2"
    );

    expect(draft.tarief.max).toBe("119");
    expect(draft.tarief.min).toBe(UNKNOWN);
    expect(draft.tarief.eenheid).toBe("uur");
    expect(draft.tarief.valuta).toBe("EUR");
  });

  it("keeps tender_source and tender_url in bron_specifiek for cross-source dedup", () => {
    const draft = parseOpdrachtoverheidPayload(
      buildOpdrachtoverheidPayload(),
      "hash-oo-3"
    );

    // SAFETY: parseOpdrachtoverheidPayload always emits these bron_specifiek fields.
    const specifiek = draft.bronSpecifiek.value as {
      tender_source: unknown;
      tender_url: unknown;
    };
    expect(specifiek.tender_source).toBe("harveynash");
    expect(specifiek.tender_url).toBe(
      "https://www.harveynash.nl/vacatures/298847-Senior-Project--en-Programmacoordinator-Grootzakelijk"
    );
  });

  it("falls back to unknown tarief when tender_maximum_tariff is absent", () => {
    const draft = parseOpdrachtoverheidPayload(
      buildOpdrachtoverheidPayload({ tender_maximum_tariff: undefined }),
      "hash-oo-4"
    );

    expect(draft.tarief.max).toBe(UNKNOWN);
    expect(draft.tarief.min).toBe(UNKNOWN);
    expect(draft.tarief.eenheid).toBe(UNKNOWN);
  });

  it("falls back to tender_hours_week when min/max hours are both absent", () => {
    const draft = parseOpdrachtoverheidPayload(
      buildOpdrachtoverheidPayload({
        tender_hours_week: "36",
        tender_max_hours: undefined,
        tender_min_hours: undefined,
      }),
      "hash-oo-5"
    );

    // SAFETY: parseOpdrachtoverheidPayload always emits these bron_specifiek fields.
    const specifiek = draft.bronSpecifiek.value as {
      tender_hours_week: unknown;
      uren_max: unknown;
      uren_min: unknown;
      uren_per_week: unknown;
    };
    expect(specifiek.tender_hours_week).toBe("36");
    expect(specifiek.uren_min).toBeNull();
    expect(specifiek.uren_max).toBeNull();
    expect(specifiek.uren_per_week).toBe("36");
  });

  it("formats numeric weekly bounds without changing one-sided meaning", () => {
    const range = parseOpdrachtoverheidPayload(
      buildOpdrachtoverheidPayload({
        tender_hours_week: "36",
        tender_max_hours: 40,
        tender_min_hours: 32,
      }),
      "hash-oo-5-range"
    );
    expect(range.bronSpecifiek.value).toMatchObject({
      tender_hours_week: "36",
      uren_per_week: "32–40",
    });

    const minimumOnly = parseOpdrachtoverheidPayload(
      buildOpdrachtoverheidPayload({
        tender_max_hours: null,
        tender_min_hours: 32,
      }),
      "hash-oo-5-minimum"
    );
    expect(minimumOnly.bronSpecifiek.value).toMatchObject({
      uren_per_week: "≥32",
    });
  });

  it("falls back to vacancies_location when tender_job_location is absent", () => {
    const draft = parseOpdrachtoverheidPayload(
      buildOpdrachtoverheidPayload({
        tender_job_location: null,
        vacancies_location: { province: "Noord-Holland" },
      }),
      "hash-oo-6"
    );

    expect(draft.locatieTekst.value).toBe("Noord-Holland");
  });

  it("reports an unknown location when no location field is populated", () => {
    const draft = parseOpdrachtoverheidPayload(
      buildOpdrachtoverheidPayload({ tender_job_location: null }),
      "hash-oo-7"
    );

    expect(draft.locatieTekst.value).toBe(UNKNOWN);
  });

  it("prefers the JobPosting JSON-LD description and marks jsonld extractieMethode", () => {
    const draft = parseOpdrachtoverheidPayload(
      {
        jobPosting: {
          "@type": "JobPosting",
          description: "Verrijkte beschrijving uit JSON-LD detailpagina.",
        },
        tender: buildOpdrachtoverheidPayload().tender,
      },
      "hash-oo-8"
    );

    expect(draft.beschrijving.value).toBe(
      "Verrijkte beschrijving uit JSON-LD detailpagina."
    );
    expect(draft.extractieMethode).toBe("jsonld");
  });

  it("uses the api extractieMethode when no JobPosting enrichment is present", () => {
    const draft = parseOpdrachtoverheidPayload(
      buildOpdrachtoverheidPayload(),
      "hash-oo-9"
    );

    expect(draft.extractieMethode).toBe("api");
  });

  it("parses tender_tariff free text into a numeric max when tender_maximum_tariff is absent (fixture)", async () => {
    const fixture = await loadConnectorFixture<OpdrachtoverheidListingResponse>(
      "opdrachtoverheid/listing-page-0.json"
    );
    const [record] = fixture.payload.negometrix_tenders;
    if (!record) {
      throw new Error("Expected an Opdrachtoverheid fixture record");
    }
    // Confirmed live 2026-08-31: all 5 fixture records have
    // tender_maximum_tariff: null and a numeric tender_tariff string.
    expect(record.tender_maximum_tariff).toBeNull();
    expect(record.tender_tariff).toBe("70");

    const draft = parseOpdrachtoverheidPayload(
      { jobPosting: null, tender: record },
      "hash-oo-fixture-tarief"
    );

    expect(draft.tarief.max).toBe("70");
    expect(draft.tarief.min).toBe(UNKNOWN);
    expect(draft.tarief.eenheid).toBe("uur");
  });

  it("derives a closed lifecycle from the bron's own tender_status/tender_active (fixture, future offline_date)", async () => {
    const fixture = await loadConnectorFixture<OpdrachtoverheidListingResponse>(
      "opdrachtoverheid/listing-page-0.json"
    );
    const [record] = fixture.payload.negometrix_tenders;
    if (!record) {
      throw new Error("Expected an Opdrachtoverheid fixture record");
    }
    // Confirmed live 2026-08-31: every fixture record is already closed.
    expect(record.tender_status).toBe("closed");
    expect(record.tender_active).toBe(false);

    // Push tender_offline_date into the future so `sluitingsdatumPassed`
    // cannot be what forces the lifecycle to "closed" — without deriving
    // bronSaysClosed from tender_status/tender_active, this would
    // (incorrectly) resolve to "active".
    const draft = parseOpdrachtoverheidPayload(
      {
        jobPosting: null,
        tender: { ...record, tender_offline_date: "2099-01-01 00:00:00" },
      },
      "hash-oo-fixture-closed"
    );

    expect(draft.lifecycle).toBe("closed");
    expect(draft.status).toBe("closed");
  });

  it("closes lifecycle once tender_offline_date has passed", () => {
    const draft = parseOpdrachtoverheidPayload(
      buildOpdrachtoverheidPayload({
        tender_offline_date: "2000-01-01 00:00:00",
      }),
      "hash-oo-closed-past"
    );

    expect(draft.lifecycle).toBe("closed");
    expect(draft.status).toBe("closed");
  });

  it("stays active while tender_offline_date is still in the future", () => {
    const draft = parseOpdrachtoverheidPayload(
      buildOpdrachtoverheidPayload({
        tender_offline_date: "2099-01-01 00:00:00",
      }),
      "hash-oo-active-future"
    );

    expect(draft.lifecycle).toBe("active");
    expect(draft.status).toBe("active");
  });

  it("stays active when tender_offline_date closes later today (RJC-376 regression)", () => {
    // Reproduces the bug: truncating "later today" to a bare date and
    // comparing at midnight used to flip this to "closed" hours before the
    // real deadline. tender_offline_date carries a real time component at
    // the source (space-separated, e.g. "2026-09-01 16:00:00"), so a naive
    // Europe/Amsterdam wall-clock string a few minutes in the future must
    // not close it.
    const parts = new Intl.DateTimeFormat("en-US", {
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      second: "2-digit",
      timeZone: "Europe/Amsterdam",
      year: "numeric",
    }).formatToParts(new Date(Date.now() + 5 * 60 * 1000));
    const get = (type: string) =>
      parts.find((part) => part.type === type)?.value;
    const laterToday = `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;

    const draft = parseOpdrachtoverheidPayload(
      buildOpdrachtoverheidPayload({ tender_offline_date: laterToday }),
      "hash-oo-later-today"
    );

    expect(draft.lifecycle).toBe("active");
    expect(draft.status).toBe("active");
  });

  it("stays unknown/open rather than auto-closing when tender_offline_date is absent", () => {
    const draft = parseOpdrachtoverheidPayload(
      buildOpdrachtoverheidPayload({ tender_offline_date: undefined }),
      "hash-oo-no-offline-date"
    );

    // No closing information at all -- must not read as "already closed".
    expect(draft.lifecycle).not.toBe("closed");
  });
});

describe("identity", () => {
  it("creates one reviewable dedup group for two bronnen with same title/org/start", async () => {
    const store = new InMemoryCurateStore();
    const observedAt = new Date("2026-08-28T10:00:00.000Z");
    const sharedKey = buildDedupKey({
      opdrachtgeverNaam: "Alliander",
      startDatum: "2026-09-01",
      titel: "Senior Java Developer",
    });

    const firstBody = buildInhuurdeskBody("Eerste bron beschrijving.");
    const secondBody = buildInhuurdeskBody("Tweede bron beschrijving.");
    const firstHash = await hashContent(firstBody);
    const secondHash = await hashContent(secondBody);
    const firstDraft = normaliseInhuurdeskObservation(firstBody, firstHash);
    firstDraft.bronReferentie.value = "IH-GROUP-1";
    const secondDraft = normaliseInhuurdeskObservation(secondBody, secondHash);
    secondDraft.bronReferentie.value = "IH-GROUP-2";

    await curateObservation(store, {
      bronId: "bron-a",
      draft: firstDraft,
      observedAt,
      rawPayloadRef: "raw/a.json",
      scrapeRunId: "run-a",
    });
    await curateObservation(store, {
      bronId: "bron-b",
      draft: secondDraft,
      observedAt,
      rawPayloadRef: "raw/b.json",
      scrapeRunId: "run-b",
    });

    expect(store.aanvragen).toHaveLength(2);
    expect(store.dedupGroepen).toHaveLength(1);
    expect(store.dedupGroepen[0]?.dedupKey).toBe(sharedKey);
    expect(store.aanvragen.every((row) => row.dedupGroepId)).toBe(true);
  });

  it("supports reversible dedup group splits", async () => {
    const store = new InMemoryCurateStore();
    const body = buildInhuurdeskBody("Beschrijving");
    const hash = await hashContent(body);
    const draft = normaliseInhuurdeskObservation(body, hash);
    const result = await curateObservation(store, {
      bronId: "bron-split",
      draft,
      observedAt: new Date("2026-08-28T10:00:00.000Z"),
      rawPayloadRef: "raw/split.json",
      scrapeRunId: "run-split",
    });
    const { dedupGroepId } = result;
    expect(dedupGroepId).toBeDefined();
    if (!dedupGroepId) {
      throw new Error("Expected dedupGroepId from curateObservation");
    }
    await splitDedupGroep(store, dedupGroepId);
    expect(store.aanvragen[0]?.dedupGroepId).toBeNull();
    expect(store.dedupGroepen).toHaveLength(0);
  });

  it("opens SCD2 version and outbox event when tarief changes", async () => {
    const store = new InMemoryCurateStore();
    const observedAt = new Date("2026-08-28T10:00:00.000Z");
    const firstBody = buildInhuurdeskBody("Max tarief €100 per uur.");
    const secondBody = buildInhuurdeskBody("Max tarief €130 per uur.");
    const firstHash = await hashContent(firstBody);
    const secondHash = await hashContent(secondBody);

    await processObservation(store, {
      body: firstBody,
      bronId: "bron-tarief",
      bronSlug: "inhuurdesk",
      contentHash: firstHash,
      observedAt,
      rawPayloadRef: "raw/v1.json",
      scrapeRunId: "run-v1",
    });
    const changed = await processObservation(store, {
      body: secondBody,
      bronId: "bron-tarief",
      bronSlug: "inhuurdesk",
      contentHash: secondHash,
      observedAt: new Date("2026-08-29T10:00:00.000Z"),
      rawPayloadRef: "raw/v2.json",
      scrapeRunId: "run-v2",
    });

    expect(changed.status).toBe("curated");
    expect(changed.versie).toBe(2);
    expect(store.versies).toHaveLength(2);
    expect(store.versies[0]?.geldigTot).not.toBeNull();
    expect(store.outboxEvents.at(-1)?.eventType).toBe("aanvraag.gewijzigd");
    expect(store.aanvragen[0]?.tariefMax).toBe("130");
  });

  it("RJC-394 fix-first: an unchanged observation still writes locatieTekst/sluitingsdatum, without a new versie but with an outbox event", async () => {
    const store = new InMemoryCurateStore();
    const body = buildInhuurdeskBody("Beschrijving ongewijzigd.");
    const hash = await hashContent(body);
    const observedAt = new Date("2026-08-28T10:00:00.000Z");

    const firstDraft = normaliseInhuurdeskObservation(body, hash);
    const created = await curateObservation(store, {
      bronId: "bron-unchanged",
      draft: firstDraft,
      observedAt,
      rawPayloadRef: "raw/unchanged-v1.json",
      scrapeRunId: "run-unchanged-v1",
    });
    expect(created.status).toBe("curated");
    // Inhuurdesk never publishes a closing moment (RJC-377); it does
    // publish a location, so overwrite that too to keep the test's own
    // "was absent, is now set" premise honest for both fields.
    expect(store.aanvragen[0]?.sluitingsdatum).toBeNull();

    const sluitingsdatum = new Date("2026-09-07T11:00:00.000Z");
    const draftWithValues = normaliseInhuurdeskObservation(body, hash);
    draftWithValues.locatieTekst.value = "Amsterdam";
    draftWithValues.sluitingsdatum = sluitingsdatum;

    const unchanged = await curateObservation(store, {
      bronId: "bron-unchanged",
      draft: draftWithValues,
      observedAt: new Date("2026-08-29T10:00:00.000Z"),
      rawPayloadRef: "raw/unchanged-v2.json",
      scrapeRunId: "run-unchanged-v2",
    });

    expect(unchanged.status).toBe("unchanged");
    expect(store.aanvragen[0]?.locatieTekst).toBe("Amsterdam");
    expect(store.aanvragen[0]?.sluitingsdatum).toEqual(sluitingsdatum);
    expect(store.aanvragen[0]?.versie).toBe(1);
    expect(store.versies).toHaveLength(1);
    // CTP-498: locatie and sluitingsdatum are both projected fields, so this
    // write needs its own event. Status did not flip, so no new SCD2 version.
    expect(store.outboxEvents).toHaveLength(2);
    expect(store.outboxEvents[1]?.eventType).toBe("aanvraag.gewijzigd");

    // A later unchanged observation whose draft has neither field must not
    // erase the values already stored -- a source that stops publishing a
    // deadline should never silently look like it never had one.
    const draftWithoutValues = normaliseInhuurdeskObservation(body, hash);
    draftWithoutValues.locatieTekst.value = UNKNOWN;
    draftWithoutValues.sluitingsdatum = undefined;
    const stillUnchanged = await curateObservation(store, {
      bronId: "bron-unchanged",
      draft: draftWithoutValues,
      observedAt: new Date("2026-08-30T10:00:00.000Z"),
      rawPayloadRef: "raw/unchanged-v3.json",
      scrapeRunId: "run-unchanged-v3",
    });

    expect(stillUnchanged.status).toBe("unchanged");
    expect(store.aanvragen[0]?.locatieTekst).toBe("Amsterdam");
    expect(store.aanvragen[0]?.sluitingsdatum).toEqual(sluitingsdatum);
  });
});
