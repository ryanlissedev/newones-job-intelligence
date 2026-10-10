import { describe, expect, it } from "bun:test";

import { UNKNOWN } from "@ji/domain";

import { parseTariefFromText } from "./tarief";

describe("parseTariefFromText", () => {
  it("parses a single euro amount as max-only hourly", () => {
    expect(parseTariefFromText("Tarief: € 77,50 inclusief MSP fee")).toEqual({
      eenheid: "uur",
      max: "77.50",
      min: UNKNOWN,
      valuta: "EUR",
    });
  });

  it("parses tot/max without a min", () => {
    expect(parseTariefFromText("Tarief: max. €110")).toMatchObject({
      eenheid: "uur",
      max: "110",
      min: UNKNOWN,
    });
    expect(parseTariefFromText("tot €106,50 per uur")).toMatchObject({
      max: "106.50",
      min: UNKNOWN,
    });
  });

  it("parses tussen ranges and strips thousand points", () => {
    expect(
      parseTariefFromText("Tarief: tussen € 95,00 en € 109,00")
    ).toMatchObject({
      max: "109.00",
      min: "95.00",
    });
    expect(parseTariefFromText("max € 1.250 per dag")).toMatchObject({
      eenheid: "dag",
      max: "1250",
      min: UNKNOWN,
    });
  });

  it("parses bare euro ranges used by needstaffing-style listings", () => {
    expect(parseTariefFromText("tarief 85-95 euro")).toMatchObject({
      max: "95",
      min: "85",
    });
  });

  it("keeps qualitative vocabulary as unknown", () => {
    expect(parseTariefFromText("Tarief: marktconform")).toEqual({
      eenheid: UNKNOWN,
      max: UNKNOWN,
      min: UNKNOWN,
      valuta: "EUR",
    });
  });
});

describe("tarief parser regressions (bugbot)", () => {
  it("does not treat tot N uur per week as a max-only rate", () => {
    expect(
      parseTariefFromText("Detachering, tot 36 uur per week")
    ).toMatchObject({
      max: UNKNOWN,
      min: UNKNOWN,
    });
  });

  it("still parses tot € amounts as max-only", () => {
    expect(parseTariefFromText("Tarief tot €95")).toMatchObject({
      max: "95",
      min: UNKNOWN,
    });
  });

  it("prefers per dag over all-in gloss for eenheid", () => {
    expect(parseTariefFromText("€450 per dag all-in")).toMatchObject({
      eenheid: "dag",
      max: "450",
    });
  });

  it("does not mine a date after operationaliseren as a rate", () => {
    expect(
      parseTariefFromText(
        "Het daadwerkelijk operationaliseren van deze functie levert 31-12-2026 op."
      )
    ).toEqual({
      eenheid: UNKNOWN,
      max: UNKNOWN,
      min: UNKNOWN,
      valuta: "EUR",
    });
  });

  it("does not mine a duration after strategische as a rate", () => {
    expect(
      parseTariefFromText("Er is strategische ruimte voor 2–3 jaar.")
    ).toEqual({
      eenheid: UNKNOWN,
      max: UNKNOWN,
      min: UNKNOWN,
      valuta: "EUR",
    });
  });

  it("does not mine a headcount range without rate context", () => {
    expect(
      parseTariefFromText("Je geeft leiding aan een team van 10-15.")
    ).toEqual({
      eenheid: UNKNOWN,
      max: UNKNOWN,
      min: UNKNOWN,
      valuta: "EUR",
    });
  });
});

describe("parseTariefFromText benefits copy is not a rate range (CTP-606)", () => {
  // "van"/"vanaf"/"from" introduce a single amount as often as a range, so on
  // their own they must not turn an "en"/"and" list of unrelated amounts into
  // a band. Only "tussen", or a currency mark on both bounds, does that.
  it.each([
    ["Je krijgt een bonus van € 500 en 1.000 euro opleidingsbudget.", "500"],
    ["vanaf € 20 en 25 vakantiedagen", "20"],
    ["from €50 and 100 laptops", "50"],
    ["between € 80 and 120 collega's", "80"],
  ])("reads %j as a single amount, not a band", (text, max) => {
    expect(parseTariefFromText(text)).toEqual({
      eenheid: "uur",
      max,
      min: UNKNOWN,
      valuta: "EUR",
    });
  });

  it("still reads a band when both bounds carry a currency mark", () => {
    expect(parseTariefFromText("between €80 and €120 per uur")).toEqual({
      eenheid: "uur",
      max: "120",
      min: "80",
      valuta: "EUR",
    });
  });
});

describe("parseTariefFromText salaris vs inhuur tarief", () => {
  it("labels jobboard salaris ranges as maand, not uur", () => {
    const parsed = parseTariefFromText(
      "Een maandsalaris tussen de € 3.150,00 en € 6.500,00"
    );
    expect(parsed).toMatchObject({
      eenheid: "maand",
      max: "6500.00",
      min: "3150.00",
      valuta: "EUR",
    });
  });

  it("keeps labeled uurtarief as uur", () => {
    const parsed = parseTariefFromText("Uurtarief €90 - €110 all-in");
    expect(parsed.eenheid).toBe("uur");
  });
});

describe("parseTariefFromText monthly salary ranges (CTP-606)", () => {
  it("reads both bounds of a tussen range carrying the Dutch ,- suffix", () => {
    expect(
      parseTariefFromText(
        "Een salaris tussen € 5.517,- en € 9.337,- bruto per maand (schaal 62)"
      )
    ).toEqual({
      eenheid: "maand",
      max: "9337",
      min: "5517",
      valuta: "EUR",
    });
  });

  it("reads a van/tot range instead of mining its tot half as a max", () => {
    expect(
      parseTariefFromText(
        "Een salaris van €4.488,- tot €7.515,- bruto per maand (schaal 61)"
      )
    ).toEqual({
      eenheid: "maand",
      max: "7515",
      min: "4488",
      valuta: "EUR",
    });
  });

  it("reads an English from/and range as monthly, not hourly", () => {
    expect(
      parseTariefFromText(
        "The salary for this position ranges from €4862 and €6077 gross per month"
      )
    ).toEqual({
      eenheid: "maand",
      max: "6077",
      min: "4862",
      valuta: "EUR",
    });
  });

  it("reads the Flinter permanent-vacancy salary range", () => {
    expect(
      parseTariefFromText(
        "Een salaris tussen € 4.238,- en € 6.635,- bruto per maand (o.b.v. 40 uur)"
      )
    ).toEqual({
      eenheid: "maand",
      max: "6635",
      min: "4238",
      valuta: "EUR",
    });
  });

  it("leaves amounts unknown when comma-grouped digits could mean either 3150 or 3.15", () => {
    expect(parseTariefFromText("€3,150 - €6,500 gross per month")).toEqual({
      eenheid: "maand",
      max: UNKNOWN,
      min: UNKNOWN,
      valuta: "EUR",
    });
  });

  it("skips an hours range to reach the salary range later in the text", () => {
    expect(
      parseTariefFromText(
        "Een dienstverband van 32 tot 40 uur per week. Een salaris tussen € 4.238,- en € 6.635,- bruto per maand."
      )
    ).toEqual({
      eenheid: "maand",
      max: "6635",
      min: "4238",
      valuta: "EUR",
    });
  });

  it("does not read en between a rate and an unrelated amount as a range", () => {
    expect(
      parseTariefFromText("Je krijgt € 500 en 1.000 euro opleidingsbudget.")
    ).toEqual({
      eenheid: "uur",
      max: "500",
      min: UNKNOWN,
      valuta: "EUR",
    });
  });
});
