import { describe, expect, it } from "bun:test";

import type { CtmEntry, CtmFetchedPayload } from "@ji/connectors/ctm";
import { UNKNOWN } from "@ji/domain";

import {
  decodeCtmPayload,
  normaliseCtmObservation,
  parseCtmPayload,
} from "./ctm";

/** Built from the real capture in
 * fixtures/connectors/ctm/listing-page-0.json (aanvraagnummer 460057,
 * "Openbare Europese aanbesteding voor onderhoud blusmiddelen en
 * noodverlichting", captured 2026-08-30). */
const buildEntry = (overrides: Partial<CtmEntry> = {}): CtmEntry => ({
  aanvraagnummer: "460057",
  cpv: [
    { code: "35111320-4", name: "Portable fire-extinguishers" },
    {
      code: "50700000-2",
      name: "Repair and maintenance services of building installations",
    },
  ],
  link: "https://eu.eu-supply.com/app/rfq/rwlentrance_s.asp?PID=460057&PP=transactions.asp&B=CTMSOLUTION&PS=1",
  organisatie: "Anculus B.V.",
  procedure: "02 - Openbare procedure",
  publicatiedatum: "2026-08-26T04:34:00+02:00",
  referentie:
    "https://eu.eu-supply.com/app/rfq/rwlentrance_s.asp?PID=460057&PP=transactions.asp&B=CTMSOLUTION&PS=1",
  sluitingstijd: "2026-10-13T11:00:00",
  titel:
    "Openbare Europese aanbesteding voor onderhoud blusmiddelen en noodverlichting",
  ...overrides,
});

describe("parseCtmPayload", () => {
  it("maps the real Anculus B.V. tender entry into the normalised draft", () => {
    const draft = parseCtmPayload({ entry: buildEntry() }, "hash-1");

    expect(draft.titel.value).toBe(
      "Openbare Europese aanbesteding voor onderhoud blusmiddelen en noodverlichting"
    );
    expect(draft.opdrachtgeverNaam.value).toBe("Anculus B.V.");
    expect(draft.locatieLand.value).toBe("NL");
    expect(draft.bronReferentie.value).toBe("460057");
    expect(draft.bronUrl.value).toBe(
      "https://eu.eu-supply.com/app/rfq/rwlentrance_s.asp?PID=460057&PP=transactions.asp&B=CTMSOLUTION&PS=1"
    );
    expect(draft.beschrijving.value).toContain("02 - Openbare procedure");
    expect(draft.beschrijving.value).toContain("Anculus B.V.");
    expect(draft.extractieMethode).toBe("api");
  });

  it("marks tarief, startDatum and locatieTekst UNKNOWN — genuinely absent at source", () => {
    const draft = parseCtmPayload({ entry: buildEntry() }, "hash-1");

    expect(draft.tarief).toEqual({
      eenheid: UNKNOWN,
      max: UNKNOWN,
      min: UNKNOWN,
      valuta: "EUR",
    });
    expect(draft.startDatum.value).toBe(UNKNOWN);
    expect(draft.startDatum.provenance.sourcePath).toBe(
      "n/a (not published by source)"
    );
    expect(draft.locatieTekst.value).toBe(UNKNOWN);
  });

  it("keeps procedure, cpv, publicatiedatum and the full referentie URL in bronSpecifiek", () => {
    const draft = parseCtmPayload({ entry: buildEntry() }, "hash-1");
    // SAFETY: parseCtmPayload's own bronSpecifiek literal (see ./ctm.ts)
    // fixes this shape; asserting it here only narrows the test's view.
    const specifiek = draft.bronSpecifiek.value as {
      cpv: { code: string; name: string | null }[] | null;
      procedure: string | null;
      publicatiedatum: string | null;
      referentie: string | null;
      sluitingstijd_raw: string | null;
    };

    expect(specifiek.procedure).toBe("02 - Openbare procedure");
    expect(specifiek.publicatiedatum).toBe("2026-08-26T04:34:00+02:00");
    expect(specifiek.sluitingstijd_raw).toBe("2026-10-13T11:00:00");
    expect(specifiek.referentie).toBe(
      "https://eu.eu-supply.com/app/rfq/rwlentrance_s.asp?PID=460057&PP=transactions.asp&B=CTMSOLUTION&PS=1"
    );
    expect(specifiek.cpv).toEqual([
      { code: "35111320-4", name: "Portable fire-extinguishers" },
      {
        code: "50700000-2",
        name: "Repair and maintenance services of building installations",
      },
    ]);
  });

  it("falls back opdrachtgeverNaam to UNKNOWN when organisatie is absent", () => {
    const draft = parseCtmPayload(
      { entry: buildEntry({ organisatie: undefined }) },
      "hash-1"
    );

    expect(draft.opdrachtgeverNaam.value).toBe(UNKNOWN);
  });

  it("closes lifecycle once the sluitingstijd deadline has passed", () => {
    const draft = parseCtmPayload(
      { entry: buildEntry({ sluitingstijd: "2000-01-01T00:00:00" }) },
      "hash-1"
    );

    expect(draft.lifecycle).toBe("closed");
    expect(draft.status).toBe("closed");
  });

  it("stays active while the sluitingstijd deadline is still in the future", () => {
    const draft = parseCtmPayload(
      { entry: buildEntry({ sluitingstijd: "2099-01-01T00:00:00" }) },
      "hash-1"
    );

    expect(draft.lifecycle).toBe("active");
    expect(draft.status).toBe("active");
  });

  it("stays active when sluitingstijd closes later today (RJC-376 regression)", () => {
    // Reproduces the bug: truncating "later today" to a bare date and
    // comparing at midnight used to flip this to "closed" hours before the
    // real deadline. A naive Europe/Amsterdam wall-clock string a few
    // minutes in the future must not close it.
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
    const laterToday = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;

    const draft = parseCtmPayload(
      { entry: buildEntry({ sluitingstijd: laterToday }) },
      "hash-1"
    );

    expect(draft.lifecycle).toBe("active");
    expect(draft.status).toBe("active");
  });

  it("stays unknown/open rather than auto-closing when sluitingstijd is absent", () => {
    const draft = parseCtmPayload(
      { entry: buildEntry({ sluitingstijd: undefined }) },
      "hash-1"
    );

    // No closing information at all -- must not read as "already closed".
    expect(draft.lifecycle).not.toBe("closed");
  });
});

describe("normaliseCtmObservation", () => {
  it("round-trips a JSON-encoded payload through decode + parse", () => {
    const payload: CtmFetchedPayload = { entry: buildEntry() };
    const body = new TextEncoder().encode(JSON.stringify(payload));

    expect(decodeCtmPayload(body)).toEqual(payload);

    const draft = normaliseCtmObservation(body, "hash-2");
    expect(draft.bronReferentie.value).toBe("460057");
    expect(draft.contentHash).toBe("hash-2");
  });
});
