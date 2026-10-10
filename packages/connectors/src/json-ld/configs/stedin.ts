import type { JsonLdConnectorConfig } from "../types";

export const stedinConfig: JsonLdConnectorConfig = {
  detailFixtures: {
    "https://werkenbij.stedin.net/banen/amstelveen/monteur-gas/3297/35532249792":
      "stedin/detail-monteur-gas-amstelveen.json",
    "https://werkenbij.stedin.net/banen/delft/devops-engineer/3297/43419274752":
      "stedin/detail-devops-engineer-delft.json",
  },
  discovery: {
    kind: "sitemap",
    url: "https://werkenbij.stedin.net/sitemap.xml",
  },
  excludePatterns: [
    /^(?!https:\/\/werkenbij\.stedin\.net\/banen\/[^/?#]+\/[^/?#]+\/\d+\/\d+$).+$/u,
  ],
  listingFixturePath: "stedin/listing-page-0.json",
  liveEnvVar: "STEDIN_LIVE",
  parserVersion: "stedin/v2",
  slug: "stedin",
};
