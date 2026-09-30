import type { JsonLdConnectorConfig } from "../types";

/** ZZP-Opdrachten publishes historical sitemap chunks behind a sitemap index. */
export const zzpOpdrachtenConfig: JsonLdConnectorConfig = {
  detailFixtures: {
    "https://www.zzp-opdrachten.nl/vacatures/vacature-adviseur-mobiliteit-708003/":
      "zzp-opdrachten/detail-adviseur-mobiliteit-708003.json",
    "https://www.zzp-opdrachten.nl/vacatures/vacature-bouwprojectmanager-708001/":
      "zzp-opdrachten/detail-bouwprojectmanager-708001.json",
    "https://www.zzp-opdrachten.nl/vacatures/vacature-jurist-707983/":
      "zzp-opdrachten/detail-jurist-707983.json",
    "https://www.zzp-opdrachten.nl/vacatures/vacature-jurist-bezwaar-en-beroep-ruimtelijke-ordening-708008/":
      "zzp-opdrachten/detail-jurist-bezwaar-en-beroep-ruimtelijke-ordening-708008.json",
    "https://www.zzp-opdrachten.nl/vacatures/vacature-strategische-doorontwikkeling-po-707992/":
      "zzp-opdrachten/detail-strategische-doorontwikkeling-po-707992.json",
    "https://www.zzp-opdrachten.nl/vacatures/vacature-teamleider-facilitair-707985/":
      "zzp-opdrachten/detail-teamleider-facilitair-707985.json",
    "https://www.zzp-opdrachten.nl/vacatures/vacature-technisch-beheerder-708005/":
      "zzp-opdrachten/detail-technisch-beheerder-708005.json",
    "https://www.zzp-opdrachten.nl/vacatures/vacature-woonfraude-specialist-710585/":
      "zzp-opdrachten/detail-woonfraude-specialist-710585.json",
  },
  discovery: {
    /** CTP-624: ~1805 URLs across the two newest chunks. 100 items per
     * discover() page keeps one page under ~200s of paced detail fetches and
     * makes the persisted checkpoint meaningful for abort/durable resume. */
    batchSize: 100,
    childPattern: /\/job-sitemap(?<chunk>\d+)\.xml$/u,
    kind: "sitemap-index",
    newest: 2,
    // Live 2026-09-21: /sitemap.xml now 301s to /sitemap_index.xml; the index
    // still lists the same job-sitemap children (newest chunks 57 and 58).
    url: "https://www.zzp-opdrachten.nl/sitemap_index.xml",
  },
  excludePatterns: [
    /^(?!https:\/\/www\.zzp-opdrachten\.nl\/vacatures\/vacature-[^/?#]+\/?$).+$/u,
  ],
  listingFixturePath: "zzp-opdrachten/listing-page-0.json",
  liveEnvVar: "ZZP_OPDRACHTEN_LIVE",
  parserVersion: "zzp-opdrachten/v2",
  sitemapFixtures: {
    "https://www.zzp-opdrachten.nl/job-sitemap57.xml":
      "zzp-opdrachten/job-sitemap57.json",
    "https://www.zzp-opdrachten.nl/job-sitemap58.xml":
      "zzp-opdrachten/job-sitemap58.json",
  },
  slug: "zzp-opdrachten",
};
