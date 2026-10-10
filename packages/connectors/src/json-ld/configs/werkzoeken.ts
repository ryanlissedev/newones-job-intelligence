import type { JsonLdConnectorConfig } from "../types";

/**
 * Werkzoeken shares the Motian/json-ld jobboard shape with NVB.
 *
 * Live HTTP (`WERKZOEKEN_LIVE=1`) hits a Cloudflare managed challenge on every
 * public URL (verified 2026-09-16). Browser-like headers alone do not clear it;
 * set `WERKZOEKEN_COOKIE` from a consented browser session when audit/live
 * fetch is required — see docs/sources/werkzoeken.md (CTP-528). Do not add
 * CAPTCHA solvers.
 */
export const werkzoekenConfig: JsonLdConnectorConfig = {
  detailFixtures: {},
  discovery: {
    kind: "sitemap",
    url: "https://www.werkzoeken.nl/sitemap.xml",
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
  listingFixturePath: "werkzoeken/listing-page-0.json",
  liveEnvVar: "WERKZOEKEN_LIVE",
  parserVersion: "werkzoeken/v2",
  slug: "werkzoeken",
};
