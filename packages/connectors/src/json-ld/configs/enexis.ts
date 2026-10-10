import type { JsonLdConnectorConfig } from "../types";

export const enexisConfig: JsonLdConnectorConfig = {
  detailFixtures: {
    "https://werkenbij.enexis.nl/vacatures/applicatie-engineer-13841":
      "enexis/detail-applicatie-engineer.json",
    "https://werkenbij.enexis.nl/vacatures/junior-monteur-hoogspanning-13619":
      "enexis/detail-junior-monteur-hoogspanning.json",
    "https://werkenbij.enexis.nl/vacatures/senior-projectmanager-13320":
      "enexis/detail-senior-projectmanager.json",
  },
  discovery: {
    kind: "sitemap",
    url: "https://werkenbij.enexis.nl/sitemap.xml",
  },
  excludePatterns: [
    /^(?!https:\/\/werkenbij\.enexis\.nl\/vacatures\/[^/]+-\d+$).+$/u,
  ],
  listingFixturePath: "enexis/listing-page-0.json",
  liveEnvVar: "ENEXIS_LIVE",
  parserVersion: "enexis/v2",
  slug: "enexis",
};
