import type { JsonLdConnectorConfig } from "../types";

/**
 * Bij Oranje (Laravel/Livewire/InfyOm, SSR). Discovery uses the job sitemap;
 * detail pages publish a JobPosting JSON-LD node. The sample capture exposes no
 * reliable label/value block, so this config intentionally remains JSON-LD-only.
 * Robots allows crawling and links the sitemap; supplier terms remain to be
 * assessed before activation. The sitemap uses www URLs, so non-www duplicates
 * are excluded when encountered.
 */
export const bijOranjeConfig: JsonLdConnectorConfig = {
  detailFixtures: {
    "https://www.bijoranje.nl/vacatures/onbekend/data-analist-noord-holland-65099":
      "bij-oranje/detail-data-analist-65099.json",
  },
  discovery: {
    kind: "sitemap",
    url: "https://www.bijoranje.nl/sitemap-jobs-1.xml",
  },
  excludePatterns: [
    /^https?:\/\/bijoranje\.nl\//u,
    /\/vacatures\/?(?:\?.*)?$/u,
    /\/vacatures\/[^/]+\/?(?:\?.*)?$/u,
  ],
  listingFixturePath: "bij-oranje/listing-page-0.json",
  liveEnvVar: "BIJORANJE_LIVE",
  parserVersion: "bij-oranje/v2",
  slug: "bij-oranje",
};
