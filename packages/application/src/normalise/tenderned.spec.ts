import { describe, expect, it } from "bun:test";

import type { TenderNedFetchedPayload } from "@ji/connectors/tenderned";
import { UNKNOWN } from "@ji/domain";

import { decodeTenderNedPayload, parseTenderNedPayload } from "./tenderned";

/** Built from the real capture in
 * fixtures/connectors/tenderned/detail-pub-001.json (publicatieId
 * "fixture-pub-001", "Platform engineer Azure DAS"). */
const buildPayload = (
  overrides: Partial<TenderNedFetchedPayload["detail"]> = {}
): TenderNedFetchedPayload => {
  const detail: TenderNedFetchedPayload["detail"] = {
    aanbestedingNaam: "Platform engineer Azure DAS",
    aankondigingCode: { code: "AAO", omschrijving: "Aankondiging" },
    cpvCodes: [
      {
        code: "72000000-5",
        isHoofdOpdracht: true,
        omschrijving:
          "IT-diensten: advies, softwareontwikkeling, internet en ondersteuning",
      },
    ],
    kenmerk: "TN563214",
    numberOfDaysBeforeAanmeldenInschrijven: 14,
    nutsCodes: ["NL329"],
    opdrachtAardCode: { code: "IDA", omschrijving: "Dynamisch aankoopsysteem" },
    opdrachtBeschrijving:
      "Volledige detailbeschrijving voor Azure platform engineer binnen een dynamisch aankoopsysteem.",
    opdrachtgeverNaam: "Gemeente Amsterdam",
    procedureCode: { code: "OPE", omschrijving: "Openbaar" },
    publicatieDatum: "2026-08-28T12:15:00+02:00",
    publicatieId: "fixture-pub-001",
    ...overrides,
  };
  return {
    detail,
    listing: detail,
    publicatieId: "fixture-pub-001",
  };
};

describe("parseTenderNedPayload", () => {
  const observedAt = new Date("2026-09-01T12:00:00.000Z");

  it("maps the real Platform engineer Azure DAS publication into the normalised draft", () => {
    const draft = parseTenderNedPayload(buildPayload(), "hash-1");

    expect(draft.titel.value).toBe("Platform engineer Azure DAS");
    expect(draft.opdrachtgeverNaam.value).toBe("Gemeente Amsterdam");
    expect(draft.bronReferentie.value).toBe("TN563214");
    expect(draft.locatieTekst.value).toBe("Groot-Amsterdam");
  });

  it("derives sluitingsdatum from observedAt and a positive countdown (CTP-531)", () => {
    const draft = parseTenderNedPayload(
      buildPayload({ numberOfDaysBeforeAanmeldenInschrijven: 10 }),
      "hash-2",
      { observedAt }
    );
    expect(draft.sluitingsdatum).toEqual(new Date("2026-09-11T12:00:00.000Z"));
  });

  it("does not invent a deadline from publicatieDatum (CTP-531 honesty)", () => {
    const draft = parseTenderNedPayload(
      buildPayload({
        numberOfDaysBeforeAanmeldenInschrijven: 10,
        publicatieDatum: "2026-08-12T12:00:00.000Z",
      }),
      "hash-2-publicatie",
      { observedAt }
    );
    expect(draft.sluitingsdatum).toEqual(new Date("2026-09-11T12:00:00.000Z"));
  });

  it("leaves sluitingsdatum undefined when the countdown is zero", () => {
    const draft = parseTenderNedPayload(
      buildPayload({ numberOfDaysBeforeAanmeldenInschrijven: 0 }),
      "hash-2-zero",
      { observedAt }
    );
    expect(draft.sluitingsdatum).toBeUndefined();
  });

  it("leaves sluitingsdatum undefined for missing, invalid, or negative days", () => {
    for (const [days, hash] of [
      [undefined, "hash-2-missing"],
      [Number.NaN, "hash-2-nan"],
      [-1, "hash-2-negative"],
    ] as const) {
      const draft = parseTenderNedPayload(
        buildPayload({ numberOfDaysBeforeAanmeldenInschrijven: days }),
        hash,
        { observedAt }
      );
      expect(draft.sluitingsdatum).toBeUndefined();
    }
  });

  it("leaves sluitingsdatum undefined without an observedAt instant", () => {
    const draft = parseTenderNedPayload(
      buildPayload({ numberOfDaysBeforeAanmeldenInschrijven: 10 }),
      "hash-2-no-observed-at"
    );
    expect(draft.sluitingsdatum).toBeUndefined();
  });

  it("maps the NUTS2 prefix NL329 to Noord-Holland via provincie.ts (CTP-525 F04)", () => {
    const draft = parseTenderNedPayload(buildPayload(), "hash-5");
    // SAFETY: parseTenderNedPayload always emits bron_specifiek.provincie.
    const specifiek = draft.bronSpecifiek.value as { provincie: unknown };
    expect(specifiek.provincie).toBe("Noord-Holland");
  });

  it("leaves provincie null for a non-NL/unrecognised nutsCode (honesty)", () => {
    const draft = parseTenderNedPayload(
      buildPayload({ nutsCodes: ["BE100"] }),
      "hash-6"
    );
    // SAFETY: parseTenderNedPayload always emits bron_specifiek.provincie.
    const specifiek = draft.bronSpecifiek.value as { provincie: unknown };
    expect(specifiek.provincie).toBeNull();
  });

  it("maps the NUTS 2024 re-codings NL35/NL36 to Utrecht/Zuid-Holland", () => {
    for (const [code, expected] of [
      ["NL350", "Utrecht"],
      ["NL361", "Zuid-Holland"],
    ] as const) {
      const draft = parseTenderNedPayload(
        buildPayload({ nutsCodes: [code] }),
        `hash-nuts2024-${code}`
      );
      // SAFETY: parseTenderNedPayload always emits bron_specifiek.provincie.
      const specifiek = draft.bronSpecifiek.value as { provincie: unknown };
      expect(specifiek.provincie).toBe(expected);
    }
  });

  it("marks locatieLand UNKNOWN for a malformed nutsCode instead of inventing a country", () => {
    for (const code of ["NOT-A-CODE", "NL3299", "N", "NL 32"]) {
      const draft = parseTenderNedPayload(
        buildPayload({ nutsCodes: [code] }),
        `hash-malformed-${code}`
      );
      expect(draft.locatieLand.value).toBe(UNKNOWN);
    }
  });

  it("skips a malformed nutsCode and reads the country from the next well-formed one", () => {
    const draft = parseTenderNedPayload(
      buildPayload({ nutsCodes: ["NOT-A-CODE", "NL329"] }),
      "hash-malformed-then-valid"
    );
    expect(draft.locatieLand.value).toBe("NL");
  });

  it("derives locatieLand ISO-2 from the nutsCodes country prefix (CTP-525 F05)", () => {
    const draft = parseTenderNedPayload(buildPayload(), "hash-7");
    expect(draft.locatieLand.value).toBe("NL");
  });

  it("maps a non-NL nutsCode country prefix to its own ISO-2, never a hardcoded NL", () => {
    const draft = parseTenderNedPayload(
      buildPayload({ nutsCodes: ["BE100"] }),
      "hash-8"
    );
    expect(draft.locatieLand.value).toBe("BE");
  });

  it("marks locatieLand UNKNOWN when nutsCodes is absent (honesty)", () => {
    const draft = parseTenderNedPayload(
      buildPayload({ nutsCodes: undefined }),
      "hash-9"
    );
    expect(draft.locatieLand.value).toBe(UNKNOWN);
  });

  it("derives NL from a bare country-level nutsCode with no province (honesty)", () => {
    const draft = parseTenderNedPayload(
      buildPayload({ nutsCodes: ["NL"] }),
      "hash-10"
    );
    expect(draft.locatieLand.value).toBe("NL");
    // SAFETY: parseTenderNedPayload always emits bron_specifiek.provincie.
    const specifiek = draft.bronSpecifiek.value as { provincie: unknown };
    expect(specifiek.provincie).toBeNull();
  });

  it("finds the province in a later, more specific nutsCode when an earlier entry is country-level only", () => {
    const draft = parseTenderNedPayload(
      buildPayload({ nutsCodes: ["NL", "NL329"] }),
      "hash-11"
    );
    expect(draft.locatieLand.value).toBe("NL");
    // SAFETY: parseTenderNedPayload always emits bron_specifiek.provincie.
    const specifiek = draft.bronSpecifiek.value as { provincie: unknown };
    expect(specifiek.provincie).toBe("Noord-Holland");
  });

  it("normaliseTenderNedObservation round-trips a serialised payload", () => {
    const payload = buildPayload();
    const body = new TextEncoder().encode(JSON.stringify(payload));
    expect(decodeTenderNedPayload(body)).toEqual(payload);
  });
});
