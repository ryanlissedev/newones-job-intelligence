import type { JsonLdConnectorConfig } from "../types";

/**
 * TenMonks (WordPress/Rank Math, SSR). Discovery uses the newest assignment
 * sitemap; detail pages publish a JobPosting JSON-LD node. The sample exposes
 * no reliable label/value block, so this config intentionally remains JSON-LD-only.
 * Robots allows crawling outside wp-admin; supplier terms remain to be assessed
 * before activation. Sitemap 2 is a documented follow-up, not crawled by v1.
 */
export const tenmonksConfig: JsonLdConnectorConfig = {
  detailFixtures: {
    "https://tenmonks.nl/opdrachten/34350/data-analist/":
      "tenmonks/detail-34350-data-analist.json",
  },
  discovery: {
    kind: "sitemap",
    url: "https://tenmonks.nl/assignment-sitemap1.xml",
  },
  excludePatterns: [
    /^https?:\/\/tenmonks\.nl\/wp-admin(?:\/|$)/u,
    /^https?:\/\/tenmonks\.nl\/opdrachten\/?$/u,
    /^https?:\/\/tenmonks\.nl\/opdrachten\/(?!\d+\/[^/?#]+\/$)/u,
  ],
  listingFixturePath: "tenmonks/listing-page-0.json",
  liveEnvVar: "TENMONKS_LIVE",
  parserVersion: "tenmonks/v2",
  slug: "tenmonks",
};
