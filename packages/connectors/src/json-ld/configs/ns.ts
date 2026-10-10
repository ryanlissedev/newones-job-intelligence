import type { JsonLdConnectorConfig } from "../types";

export const nsConfig: JsonLdConnectorConfig = {
  detailBaseUrl: "https://www.werkenbijns.nl",
  detailFixtures: {
    "https://www.werkenbijns.nl/vacatures/conducteur-zwolle-zwolle-1331708":
      "ns/detail-conducteur-zwolle.json",
    "https://www.werkenbijns.nl/vacatures/it-lead-ns-stations-utrecht-1316973":
      "ns/detail-it-lead-ns-stations-utrecht.json",
    "https://www.werkenbijns.nl/vacatures/sap-run-manager-utrecht-utrecht-1320979":
      "ns/detail-sap-run-manager-utrecht.json",
  },
  discovery: {
    kind: "listing",
    linkPattern: /^\/vacatures\/[a-z0-9]+-[a-z0-9-]+$/u,
    url: "https://www.werkenbijns.nl/vacatures",
  },
  listingFixturePath: "ns/listing-page-0.json",
  liveEnvVar: "NS_LIVE",
  parserVersion: "ns/v2",
  slug: "ns",
};
