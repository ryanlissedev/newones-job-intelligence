import type { JsonLdConnectorConfig } from "../types";

/**
 * Haert (Driessen Groep) publishes one Drupal urlset sitemap mixing CMS,
 * kennis and opdrachtgever pages with opdracht details. Keep only the exact
 * `/opdrachten/<slug>-<id>` detail shape (every live detail URL ends in a
 * numeric assignment id); the bare `/opdrachten` listing and all other CMS
 * paths are dropped by the same rule.
 */
export const haertConfig: JsonLdConnectorConfig = {
  detailFixtures: {
    "https://www.haert.nl/opdrachten/hr-adviseur-39565":
      "haert/detail-hr-adviseur.json",
    "https://www.haert.nl/opdrachten/projectleider-energietransitie-98858":
      "haert/detail-projectleider-energietransitie.json",
    "https://www.haert.nl/opdrachten/zwemonderwijzer-13184":
      "haert/detail-zwemonderwijzer.json",
  },
  discovery: {
    kind: "sitemap",
    url: "https://www.haert.nl/sitemap.xml",
  },
  excludePatterns: [
    /^(?!https:\/\/www\.haert\.nl\/opdrachten\/[a-z0-9-]+-\d+$).+$/u,
  ],
  listingFixturePath: "haert/listing-page-0.json",
  liveEnvVar: "HAERT_LIVE",
  parserVersion: "haert/v2",
  slug: "haert",
};
