import type { JsonLdConnectorConfig } from "../types";

/**
 * Nationale Vacaturebank JobPosting pages publish real baseSalary (MONTH),
 * datePosted, workHours, and education chips. Discovery stays Motian-backed
 * today; this config shares the json-ld normaliser for live HTML/enrich paths.
 */
export const nationaleVacaturebankConfig: JsonLdConnectorConfig = {
  detailFixtures: {},
  discovery: {
    kind: "sitemap",
    url: "https://www.nationalevacaturebank.nl/sitemap.xml",
  },
  excludePatterns: [],
  labelBlock: {
    tarief: {
      pattern:
        /(?:maandsalaris|salaris)\s*(?:tussen de\s*)?(?<value>€?\s*[\d.,]+(?:\s*(?:en|[-–])\s*€?\s*[\d.,]+)?)/iu,
      source: "description",
    },
    urenPerWeek: {
      pattern: /(?:Uren|Aantal uren)\s*:\s*(?<value>[^<\n]+)/iu,
      source: "description",
    },
  },
  listingFixturePath: "nationalevacaturebank/listing-page-0.json",
  liveEnvVar: "NVB_LIVE",
  parserVersion: "nationalevacaturebank/v2",
  slug: "nationalevacaturebank",
};
