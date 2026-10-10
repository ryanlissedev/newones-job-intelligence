import { describe, expect, it } from "bun:test";

import type { HarveyNashFetchedPayload } from "@ji/connectors/harveynash";
import { UNKNOWN } from "@ji/domain";

import {
  normaliseHarveyNashObservation,
  parseHarveyNashPayload,
  parseHarveyNashRichttarief,
  resolveHarveyNashDeadline,
} from "./harveynash";

/** Built from the real detail capture in
 * fixtures/connectors/harveynash/detail-endpoints-specialist.json
 * (job id 452d25a3-ae7d-4ee6-9ceb-3c696332799f, "Endpoints specialist",
 * captured 2026-08-31). */
const buildPayload = (
  overrides: Partial<HarveyNashFetchedPayload["detail"]> = {}
): HarveyNashFetchedPayload => ({
  detail: {
    eindklant: "Politie",
    facts: {
      deadline: "04-09 om 09:00",
      jobRef: "BBBH121494_1788161094",
      locatie: "Bunnik , Utrecht",
      richttarief: "Max tarief 106.50 euro all-in exclusief btw",
      start: "01-11-2026 (starten kan na afronding van screening)",
      uren: "36",
    },
    jobId: "452d25a3-ae7d-4ee6-9ceb-3c696332799f",
    jsonLd: {
      datePosted: "2026-08-31T07:24:55.419Z",
      description:
        "<p>Voor onze eindklant Politie is Harvey Nash op zoek naar een endpoints specialist</p>",
      title: "Endpoints specialist ",
      validThrough: "2026-09-07T23:59:59.999Z",
    },
    publishedAt: 1_788_161_095,
    reference: "BBBH121494_1788161094",
    title: "Endpoints specialist",
    url: "https://www.harveynash.nl/vacatures/298852-Endpoints-specialist-",
    ...overrides,
  },
});

describe("resolveHarveyNashDeadline — real Harvey Nash deadline text (captured 2026-08-31)", () => {
  it("parses 'DD-MM om HH:MM' with no year, anchored to the observation date, keeping the published time (CTP-519)", () => {
    // Real: Endpoints specialist, published_at 2026-08-31.
    expect(
      resolveHarveyNashDeadline(
        "04-09 om 09:00",
        new Date(1_788_161_095 * 1000)
      )
    ).toBe("2026-09-04T09:00:00");
  });

  it("parses 'DD-MM-YYYY, HH:MM' with an explicit year, keeping the published time (CTP-519)", () => {
    // Real: Medior M365 Copilot Adoptie Consultant, published_at 2026-08-31.
    expect(
      resolveHarveyNashDeadline(
        "02-09-2026, 12:00",
        new Date(1_788_168_555 * 1000)
      )
    ).toBe("2026-09-02T12:00:00");
  });

  it("parses a weekday-prefixed numeric date ('wo 2-9 om 16.00'), keeping the dot-separated time (CTP-519)", () => {
    // Real: Senior Project- en Programmacoördinator, published_at 2026-08-28.
    expect(
      resolveHarveyNashDeadline(
        "wo 2-9 om 16.00",
        new Date(1_787_922_509 * 1000)
      )
    ).toBe("2026-09-02T16:00:00");
  });

  it("skips a leading '<number> word' that isn't a month name and finds the real date later in the text", () => {
    // Fable review 2026-08-31: "3 dagen" matches the day+word pattern first
    // but "dagen" isn't a Dutch month -- the parser must keep scanning
    // rather than give up after the first match.
    expect(
      resolveHarveyNashDeadline(
        "nog 3 dagen, uiterlijk 4 september reageren",
        new Date("2026-08-25T00:00:00.000Z")
      )
    ).toBe("2026-09-04");
  });

  it("parses a full weekday name plus a Dutch month name ('dinsdag 1 september 16 uur'), keeping the bare-hour time (CTP-519)", () => {
    // Real: Programmamanager Digitaliseren Gasnet, published_at 2026-08-28.
    expect(
      resolveHarveyNashDeadline(
        "dinsdag 1 september 16 uur",
        new Date(1_787_900_013 * 1000)
      )
    ).toBe("2026-09-01T16:00:00");
  });

  it("parses a single-digit day/month with no leading zeros ('31-8 voor 09:00 uur'), keeping the published time (CTP-519)", () => {
    // Real: Projectleider Realisatie, published_at 2026-08-27.
    expect(
      resolveHarveyNashDeadline(
        "31-8 voor 09:00 uur",
        new Date(1_787_824_221 * 1000)
      )
    ).toBe("2026-08-31T09:00:00");
  });

  it("rolls a yearless date into next year when it would otherwise precede the observation date", () => {
    // Synthetic edge case: none of the real 2026-08-31 captures happened to
    // straddle a year boundary, so this exercises the rollover branch
    // directly rather than via a fixture.
    expect(
      resolveHarveyNashDeadline("15-03", new Date("2026-11-01T00:00:00.000Z"))
    ).toBe("2027-03-15");
  });

  it("passes through an ISO date verbatim", () => {
    expect(
      resolveHarveyNashDeadline(
        "2026-09-15",
        new Date("2026-08-25T00:00:00.000Z")
      )
    ).toBe("2026-09-15");
  });

  it("returns UNKNOWN when there is no observation date to anchor a yearless deadline", () => {
    expect(resolveHarveyNashDeadline("04-09 om 09:00")).toBe(UNKNOWN);
  });

  it("returns UNKNOWN for missing or unparseable deadline text", () => {
    // Real: several 2026-08-31 postings omit the deadline paragraph entirely
    // or use free text like "Z.S.M" with no date at all.
    expect(resolveHarveyNashDeadline(undefined, new Date())).toBe(UNKNOWN);
    expect(resolveHarveyNashDeadline("Z.S.M", new Date())).toBe(UNKNOWN);
  });
});

describe("parseHarveyNashRichttarief — real 'Salaris' field text", () => {
  it("extracts the numeric max from the real 'Max tarief 106.50 euro all-in exclusief btw' text", () => {
    const tarief = parseHarveyNashRichttarief(
      "Max tarief 106.50 euro all-in exclusief btw"
    );
    expect(tarief.max).toBe("106.50");
    expect(tarief.min).toBe(UNKNOWN);
    expect(tarief.valuta).toBe("EUR");
    // CTP-519 F09: this real text names no "uur"/"dag"/"maand" word at all --
    // "all-in exclusief btw" is itself the Dutch-inhuur convention for an
    // hourly rate (same token set `./tarief.ts`'s `detectEenheid` treats as
    // "uur"), so eenheid must resolve to "uur", not UNKNOWN.
    expect(tarief.eenheid).toBe("uur");
  });

  it("detects the eenheid from surrounding text when present", () => {
    expect(parseHarveyNashRichttarief("Max tarief 95 per uur").eenheid).toBe(
      "uur"
    );
    expect(parseHarveyNashRichttarief("Max tarief 700 per dag").eenheid).toBe(
      "dag"
    );
  });

  it("returns UNKNOWN for the real free-text values with no number ('Bespreekbaar', 'Tarief in overleg')", () => {
    expect(parseHarveyNashRichttarief("Bespreekbaar").max).toBe(UNKNOWN);
    expect(parseHarveyNashRichttarief("Tarief in overleg").max).toBe(UNKNOWN);
  });

  it("returns UNKNOWN for a missing richttarief", () => {
    expect(parseHarveyNashRichttarief().max).toBe(UNKNOWN);
  });
});

describe("parseHarveyNashPayload", () => {
  it("maps the real Endpoints specialist facts into the normalised draft", () => {
    const draft = parseHarveyNashPayload(buildPayload(), "hash-1");

    expect(draft.titel.value).toBe("Endpoints specialist");
    expect(draft.opdrachtgeverNaam.value).toBe("Politie");
    expect(draft.locatieTekst.value).toBe("Bunnik , Utrecht");
    expect(draft.startDatum.value).toContain("01-11-2026");
    expect(draft.bronReferentie.value).toBe(
      "452d25a3-ae7d-4ee6-9ceb-3c696332799f"
    );
    expect(draft.bronUrl.value).toBe(
      "https://www.harveynash.nl/vacatures/298852-Endpoints-specialist-"
    );
    expect(draft.tarief.max).toBe("106.50");
    expect(draft.extractieMethode).toBe("html_parser");
    expect(draft.bronSpecifiek.value).toMatchObject({
      deadline_raw: "04-09 om 09:00",
      deadline_resolved: "2026-09-04T09:00:00",
      job_ref: "BBBH121494_1788161094",
      provincie: "Utrecht",
      reference: "BBBH121494_1788161094",
      uren_per_week: "36",
    });
  });

  it("maps provincie from the explicit 'stad , provincie' locatie text (CTP-519 F04)", () => {
    const draft = parseHarveyNashPayload(buildPayload(), "hash-provincie");
    expect(draft.bronSpecifiek.value).toMatchObject({ provincie: "Utrecht" });
  });

  it("leaves provincie null when the locatie text names no recognised province", () => {
    const base = buildPayload();
    const draft = parseHarveyNashPayload(
      buildPayload({
        facts: { ...base.detail.facts, locatie: "Amsterdam" },
      }),
      "hash-no-provincie"
    );
    expect(draft.bronSpecifiek.value).toMatchObject({ provincie: null });
  });

  it("extracts duur and werkvorm from the real labelled description paragraphs (CTP-519 F11, F07)", () => {
    // Real labelled paragraphs from fixtures/connectors/harveynash/
    // detail-endpoints-specialist.json's JobPosting description.
    const description =
      "<p>Verwachte startdatum: 01-11-2026</p><p>Duur van de opdracht: 24 maanden</p><p>Aantal uren per week:   36</p><p>Op locatie of vanuit huis:  Hybride</p>";
    const base = buildPayload();
    const draft = parseHarveyNashPayload(
      buildPayload({
        jsonLd: { ...base.detail.jsonLd, description },
      }),
      "hash-duur-werkvorm"
    );
    expect(draft.bronSpecifiek.value).toMatchObject({
      duur: "24 maanden",
      eind_datum: null,
      werkvorm: "Hybride",
    });
  });

  it("leaves duur and werkvorm null (never guessed) when the description names neither (honesty)", () => {
    const base = buildPayload();
    const draft = parseHarveyNashPayload(
      buildPayload({
        jsonLd: {
          ...base.detail.jsonLd,
          description: "<p>Geen aanvullende informatie.</p>",
        },
      }),
      "hash-no-duur-werkvorm"
    );
    expect(draft.bronSpecifiek.value).toMatchObject({
      duur: null,
      eind_datum: null,
      werkvorm: null,
    });
  });

  it("does not fabricate duur from a narrative paragraph that merely contains the word 'duur' (advisor review, CTP-519)", () => {
    const base = buildPayload();
    const draft = parseHarveyNashPayload(
      buildPayload({
        jsonLd: {
          ...base.detail.jsonLd,
          description: "<p>Gedurende de opdracht werk je met: Azure</p>",
        },
      }),
      "hash-no-fabricated-duur"
    );
    expect(draft.bronSpecifiek.value).toMatchObject({ duur: null });
  });

  it("does not fabricate werkvorm from a narrative paragraph that merely contains 'op locatie' (advisor review, CTP-519)", () => {
    const base = buildPayload();
    const draft = parseHarveyNashPayload(
      buildPayload({
        jsonLd: {
          ...base.detail.jsonLd,
          description: "<p>De werkzaamheden op locatie omvatten: onderhoud</p>",
        },
      }),
      "hash-no-fabricated-werkvorm"
    );
    expect(draft.bronSpecifiek.value).toMatchObject({ werkvorm: null });
  });

  it("falls back to the listing title when JSON-LD has none", () => {
    const draft = parseHarveyNashPayload(
      buildPayload({ jsonLd: {} }),
      "hash-2"
    );
    expect(draft.titel.value).toBe("Endpoints specialist");
  });

  it("marks opdrachtgeverNaam UNKNOWN when the posting has no Clients category", () => {
    const draft = parseHarveyNashPayload(
      buildPayload({ eindklant: undefined }),
      "hash-3"
    );
    expect(draft.opdrachtgeverNaam.value).toBe(UNKNOWN);
  });

  it("builds beschrijving from the parsed facts", () => {
    const draft = parseHarveyNashPayload(
      buildPayload({
        jsonLd: { ...buildPayload().detail.jsonLd, description: undefined },
      }),
      "hash-4"
    );
    expect(draft.beschrijving.value).toContain("Locatie: Bunnik , Utrecht");
    expect(draft.beschrijving.value).toContain(
      "Richttarief: Max tarief 106.50 euro all-in exclusief btw"
    );
  });

  it("prefers the retained full source description over the synthesized fallback", () => {
    const description =
      "<p>Voor onze eindklant Politie is Harvey Nash op zoek naar een endpoints specialist</p><p>Werkzaamheden thuis kunnen enkel vanuit Nederland plaatsvinden.</p>";
    const draft = parseHarveyNashPayload(
      buildPayload({
        jsonLd: { ...buildPayload().detail.jsonLd, description },
      }),
      "hash-full-description"
    );
    expect(draft.beschrijving.value).toBe(
      "Voor onze eindklant Politie is Harvey Nash op zoek naar een endpoints specialist Werkzaamheden thuis kunnen enkel vanuit Nederland plaatsvinden."
    );
    expect(draft.beschrijving.provenance.sourcePath).toBe(
      "detail.jsonLd.description"
    );
    expect(draft.parserVersion).toBe("harveynash/v3");
  });

  it("removes source tags before retaining escaped angle-bracket text", () => {
    const draft = parseHarveyNashPayload(
      buildPayload({
        jsonLd: {
          ...buildPayload().detail.jsonLd,
          description:
            "<p>Een organisatie met &lt;5 werknemers&gt; zoekt een <strong>specialist.</strong></p>",
        },
      }),
      "hash-angle-text"
    );

    expect(draft.beschrijving.value).toBe(
      "Een organisatie met <5 werknemers> zoekt een specialist."
    );
  });

  it("normaliseHarveyNashObservation round-trips a serialised payload", () => {
    const payload = buildPayload();
    const body = new TextEncoder().encode(JSON.stringify(payload));
    const draft = normaliseHarveyNashObservation(body, "hash-5");
    expect(draft.titel.value).toBe("Endpoints specialist");
    expect(draft.contentHash).toBe("hash-5");
  });
});

// CTP-519: docs/sources/harveynash.md and the RJC-377 comment had already
// documented the correct mechanism but left it unapplied -- `sluitingsdatum`
// used to always read `jsonLd.validThrough` (the JobPosting's own generic
// listing-validity date) and ignore `facts.deadline` ("Deadline voor het
// voorstellen van kandidaten") entirely, even though the candidate
// submission deadline is the real moment an aanvraag stops being actionable
// for a Catapulze user. The fix: prefer the *resolved* `facts.deadline`,
// falling back to `validThrough` only when the deadline free text itself
// could not be resolved.
const buildDeadlineFacts = (
  deadline?: string
): HarveyNashFetchedPayload["detail"]["facts"] => {
  const base: HarveyNashFetchedPayload["detail"]["facts"] = {
    jobRef: "BBBH121494_1788161094",
    locatie: "Bunnik , Utrecht",
    richttarief: "Max tarief 106.50 euro all-in exclusief btw",
    start: "01-11-2026",
    uren: "36",
  };
  if (deadline !== undefined) {
    base.deadline = deadline;
  }
  return base;
};

describe("parseHarveyNashPayload — closing lifecycle (CTP-519 F13 fix, was RJC-377)", () => {
  it("closes once the resolved facts.deadline has passed, even while validThrough is still far in the future", () => {
    const draft = parseHarveyNashPayload(
      buildPayload({
        facts: buildDeadlineFacts("2000-01-01"),
        jsonLd: { validThrough: "2099-01-01T00:00:00.000Z" },
      }),
      "hash-deadline-closed-past"
    );

    expect(draft.lifecycle).toBe("closed");
    expect(draft.status).toBe("closed");
    // sluitingsdatum tracks the same closing-moment source as lifecycle.
    expect(draft.sluitingsdatum?.toISOString()).toBe(
      "2000-01-01T22:59:59.999Z"
    );
  });

  it("closes at the published deadline time, not end-of-day, when the deadline text names a clock time (CTP-519)", () => {
    const draft = parseHarveyNashPayload(
      buildPayload({
        facts: buildDeadlineFacts("01-01-2000 om 09:00"),
        jsonLd: { validThrough: "2099-01-01T00:00:00.000Z" },
      }),
      "hash-deadline-closed-timed"
    );

    expect(draft.lifecycle).toBe("closed");
    expect(draft.status).toBe("closed");
    // 09:00 Europe/Amsterdam on 2000-01-01 (winter, UTC+1) is 08:00 UTC --
    // literal instant, not the date-only fallback's 22:59:59.999Z.
    expect(draft.sluitingsdatum?.toISOString()).toBe(
      "2000-01-01T08:00:00.000Z"
    );
  });

  it("stays active while the resolved facts.deadline is still in the future, even when validThrough has already passed", () => {
    const draft = parseHarveyNashPayload(
      buildPayload({
        facts: buildDeadlineFacts("2099-01-01"),
        jsonLd: { validThrough: "2000-01-01T00:00:00.000Z" },
      }),
      "hash-deadline-active-future"
    );

    expect(draft.lifecycle).toBe("active");
    expect(draft.status).toBe("active");
  });

  it("falls back to validThrough when facts.deadline cannot be resolved (no deadline text)", () => {
    const closed = parseHarveyNashPayload(
      buildPayload({
        facts: buildDeadlineFacts(),
        jsonLd: { validThrough: "2000-01-01T00:00:00.000Z" },
      }),
      "hash-fallback-closed"
    );
    expect(closed.lifecycle).toBe("closed");

    const active = parseHarveyNashPayload(
      buildPayload({
        facts: buildDeadlineFacts(),
        jsonLd: { validThrough: "2099-01-01T00:00:00.000Z" },
      }),
      "hash-fallback-active"
    );
    expect(active.lifecycle).toBe("active");
  });

  it("stays unknown/open rather than auto-closing when neither facts.deadline nor validThrough resolve", () => {
    const draft = parseHarveyNashPayload(
      buildPayload({ facts: buildDeadlineFacts(), jsonLd: {} }),
      "hash-no-valid-through"
    );

    expect(draft.lifecycle).not.toBe("closed");
  });

  it("rejects an impossible calendar date in validThrough (Feb 30) used as the fallback, rather than rolling it over (codex review)", () => {
    const draft = parseHarveyNashPayload(
      buildPayload({
        facts: buildDeadlineFacts(),
        jsonLd: { validThrough: "2026-02-30T23:59:59.999Z" },
      }),
      "hash-invalid-calendar-date"
    );

    expect(draft.lifecycle).not.toBe("closed");
  });
});
