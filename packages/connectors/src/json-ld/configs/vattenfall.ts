import type { JsonLdConnectorConfig } from "../types";

export const vattenfallConfig: JsonLdConnectorConfig = {
  detailFixtures: {
    "https://careers.vattenfall.com/global/job/analytics-engineer-in-amsterdam-jid-50838":
      "vattenfall/detail-analytics-engineer-amsterdam.json",
    "https://careers.vattenfall.com/global/job/monteur-stadswarmte-in-arnhem-jid-51914":
      "vattenfall/detail-monteur-stadswarmte-arnhem.json",
    "https://careers.vattenfall.com/global/job/service-technician-onshore-wind-turbines-in-slootdorp-jid-48727":
      "vattenfall/detail-service-technician-slootdorp.json",
  },
  discovery: {
    kind: "sitemap",
    url: "https://careers.vattenfall.com/vacanciessitemap.xml",
  },
  excludePatterns: [
    /^(?!https:\/\/careers\.vattenfall\.com\/global\/job\/[^/]+-in-(?:amsterdam|arnhem|diemen|ijmuiden|slootdorp)-jid-\d+$).+$/u,
  ],
  listingFixturePath: "vattenfall/listing-page-0.json",
  liveEnvVar: "VATTENFALL_LIVE",
  parserVersion: "vattenfall/v2",
  slug: "vattenfall",
};
