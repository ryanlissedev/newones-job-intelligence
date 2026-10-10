import { describe, expect, it } from "bun:test";

import { createJsonLdClient, gasunieConfig } from "@ji/connectors/json-ld";
import { UNKNOWN } from "@ji/domain";

import { normaliseJsonLdObservation } from "./json-ld";

const client = createJsonLdClient({
  config: gasunieConfig,
  liveEnabled: false,
});

const normaliseFixture = async (url: string) => {
  const detail = await client.fetchDetail(url);
  return normaliseJsonLdObservation(
    new TextEncoder().encode(
      JSON.stringify({
        ...detail,
        parserVersion: gasunieConfig.parserVersion,
        slug: gasunieConfig.slug,
        url,
      })
    ),
    "hash-gasunie"
  );
};

describe("normaliseJsonLdObservation -- Gasunie", () => {
  it("normalises the recorded detail fixtures", async () => {
    const technician = await normaliseFixture(
      "https://www.werkenbijgasunie.nl/vacature/318/technicus-e-i-warmte-rotterdam-den-haag"
    );
    expect(technician.titel.value).toBe(
      "Technicus E&I Warmte, Rotterdam/Den Haag"
    );
    expect(technician.opdrachtgeverNaam.value).toBe("Gasunie");
    // The page renders the location only in the HTML label block; the
    // JSON-LD addressLocality is empty and the postalCode is not a name.
    expect(technician.locatieTekst.value).toBe("Barendrecht");
    // The recorded baseSalary (3912-5327, unitText "HOUR") is a monthly band
    // under a mislabeled unit: it must not land as an hourly tarief, but the
    // raw published node stays in bronSpecifiek as provenance.
    expect(technician.tarief).toEqual({
      eenheid: UNKNOWN,
      max: UNKNOWN,
      min: UNKNOWN,
      valuta: "EUR",
    });
    expect(technician.bronSpecifiek.value).toMatchObject({
      base_salary: {
        value: { maxValue: 5327, minValue: 3912, unitText: "HOUR" },
      },
      label_block: { locatie: "Barendrecht" },
    });

    const production = await normaliseFixture(
      "https://www.werkenbijgasunie.nl/vacature/341/production-lead"
    );
    expect(production.titel.value).toBe("Production Lead");
    expect(production.opdrachtgeverNaam.value).toBe("Gasunie");
    expect(production.locatieTekst.value).toBe("Rotterdam");
    expect(production.tarief).toEqual({
      eenheid: UNKNOWN,
      max: UNKNOWN,
      min: UNKNOWN,
      valuta: "EUR",
    });
    expect(production.bronSpecifiek.value).toMatchObject({
      base_salary: {
        value: { maxValue: 8070, minValue: 5903, unitText: "HOUR" },
      },
      label_block: { locatie: "Rotterdam" },
    });
  });
});
