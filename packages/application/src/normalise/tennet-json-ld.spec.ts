import { describe, expect, it } from "bun:test";

import { createJsonLdClient, tennetConfig } from "@ji/connectors/json-ld";
import { UNKNOWN } from "@ji/domain";

import { normaliseJsonLdObservation } from "./json-ld";

const cases = [
  [
    "https://careers.tennet.eu/nl_NL/careers/JobDetail/Toezichthouder-Transmission-Lines-Brabant/94548",
    "Toezichthouder Transmission Lines Brabant",
    "94548",
  ],
  [
    "https://careers.tennet.eu/nl_NL/careers/JobDetail/Power-System-EMT-Specialist/99587",
    "Power System EMT Specialist",
    "99587",
  ],
] as const;

describe("normaliseJsonLdObservation -- TenneT", () => {
  it("normalises each recorded Avature detail", async () => {
    const client = createJsonLdClient({
      config: tennetConfig,
      liveEnabled: false,
    });
    await Promise.all(
      cases.map(async ([url, title, id]) => {
        const detail = await client.fetchDetail(url);
        const draft = normaliseJsonLdObservation(
          new TextEncoder().encode(
            JSON.stringify({
              ...detail,
              parserVersion: tennetConfig.parserVersion,
              slug: tennetConfig.slug,
              url,
            })
          ),
          "hash"
        );
        expect(draft.titel.value).toBe(title);
        expect(draft.bronReferentie.value).toBe(new URL(url).pathname.slice(1));
        expect(draft.opdrachtgeverNaam.value).toBe("TenneT");
        // Avature publishes no location on the detail page -- honestly UNKNOWN.
        expect(draft.locatieTekst.value).toBe(UNKNOWN);
        expect(draft.bronSpecifiek).toMatchObject({
          value: {
            label_block: { referentienummer: id },
            publicatiedatum: null,
            valid_through: null,
          },
        });
        expect(draft.sluitingsdatum).toBeUndefined();
      })
    );
  });
});
