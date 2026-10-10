import type { JsonLdConnectorConfig } from "../types";

/**
 * TBI's Drupal careers hub publishes ubeeo JobPosting JSON-LD on canonical
 * vacancy detail pages. The sitemap also contains CMS pages and the vacancy
 * listing root, so discovery keeps only one-segment `/vacatures/<slug>` URLs.
 */
export const tbiConfig: JsonLdConnectorConfig = {
  detailFixtures: {
    "https://werkenbij.tbi.nl/vacatures/service-technicus-w-1280611":
      "tbi/detail-service-technicus-w-1280611.json",
  },
  discovery: {
    kind: "sitemap",
    url: "https://werkenbij.tbi.nl/sitemap.xml",
  },
  excludePatterns: [
    // Drupal robots.txt disallows all query URLs, including filtered facets.
    /[?]/u,
    /^https:\/\/werkenbij\.tbi\.nl\/?$/u,
    /^https:\/\/werkenbij\.tbi\.nl\/vacatures\/?$/u,
    /^https:\/\/werkenbij\.tbi\.nl\/(?:ondernemingen|node)(?:\/|$)/u,
    // Keep only canonical detail URLs with one non-empty path segment.
    /^(?!https:\/\/werkenbij\.tbi\.nl\/vacatures\/[^/?#]+\/?$).+$/u,
  ],
  listingFixturePath: "tbi/listing-page-0.json",
  liveEnvVar: "TBI_LIVE",
  parserVersion: "tbi/v2",
  slug: "tbi",
};
