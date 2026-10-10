import type { JsonLdConnectorConfig } from "../types";

export const enecoConfig: JsonLdConnectorConfig = {
  detailFixtures: {
    "https://www.werkenbijeneco.nl/vacatures/ervaren-accountsupporter-3145":
      "eneco/detail-ervaren-accountsupporter.json",
    "https://www.werkenbijeneco.nl/vacatures/meewerkstage-dei-communicatie-employee-networks-2954":
      "eneco/detail-meewerkstage-dei-communicatie.json",
    "https://www.werkenbijeneco.nl/vacatures/senior-trader-gas-2864":
      "eneco/detail-senior-trader-gas.json",
  },
  discovery: {
    kind: "sitemap",
    url: "https://www.werkenbijeneco.nl/sitemap.xml",
  },
  excludePatterns: [
    /^(?!https:\/\/www\.werkenbijeneco\.nl\/vacatures\/[^/]+-\d+$).+$/u,
  ],
  listingFixturePath: "eneco/listing-page-0.json",
  liveEnvVar: "ENECO_LIVE",
  parserVersion: "eneco/v2",
  slug: "eneco",
};
