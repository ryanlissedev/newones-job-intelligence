import type { JsonLdConnectorConfig } from "../types";

/**
 * DataJobs' single Drupal sitemap mixes CMS, employer, salary-guide and
 * two-segment facet URLs with one-segment vacancy details. Keep only the
 * exact one-segment vacancy shape so those other pages cannot be discovered.
 */
export const datajobsConfig: JsonLdConnectorConfig = {
  detailFixtures: {
    "https://www.datajobs.nl/vacatures/aiml-engineer-bij-ilionx":
      "datajobs/detail-aiml-engineer-bij-ilionx.json",
    "https://www.datajobs.nl/vacatures/data-engineer-bij-verpact":
      "datajobs/detail-data-engineer-bij-verpact.json",
    "https://www.datajobs.nl/vacatures/privacy-officer-bij-gemeente-altena":
      "datajobs/detail-privacy-officer-bij-gemeente-altena.json",
  },
  discovery: { kind: "sitemap", url: "https://www.datajobs.nl/sitemap.xml" },
  excludePatterns: [
    /^(?!https:\/\/www\.datajobs\.nl\/vacatures\/[^/?#]+$).+$/u,
  ],
  listingFixturePath: "datajobs/listing-page-0.json",
  liveEnvVar: "DATAJOBS_LIVE",
  parserVersion: "datajobs/v2",
  slug: "datajobs",
};
