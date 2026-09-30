import type { JsonLdConnectorConfig } from "../types";

export const unicaConfig: JsonLdConnectorConfig = {
  detailFixtures: {
    "https://www.werkenbijunica.nl/vacatures/accountmanager-venray-aqkcmj2yd4e-nszi":
      "unica/detail-accountmanager-venray.json",
    "https://www.werkenbijunica.nl/vacatures/beheertechnicus-warmtenetten-oosterhout-aqkqzty-p1bavycc":
      "unica/detail-beheertechnicus-warmtenetten-oosterhout.json",
    "https://www.werkenbijunica.nl/vacatures/energie-manager-moordrecht-aqkwugvvvcgghbf0":
      "unica/detail-energie-manager-moordrecht.json",
    "https://www.werkenbijunica.nl/vacatures/financieel-administratief-medewerker-groningen-aqfeqamifjtvpqln":
      "unica/detail-financieel-administratief-medewerker-groningen.json",
    "https://www.werkenbijunica.nl/vacatures/service-coordinator-oosterhout-aqp330sa75tapm-s":
      "unica/detail-service-coordinator-oosterhout.json",
    "https://www.werkenbijunica.nl/vacatures/servicemonteur-warmtenetten-oosterhout-aqknnzsfdf-sxr8":
      "unica/detail-servicemonteur-warmtenetten-oosterhout.json",
    "https://www.werkenbijunica.nl/vacatures/technisch-administratief-medewerker-oosterhout-aqk-1g-tfhzmqqg":
      "unica/detail-technisch-administratief-medewerker-oosterhout.json",
    "https://www.werkenbijunica.nl/vacatures/werkvoorbereider-warmtenetten-oosterhout-aqlgyyae65n4goyv":
      "unica/detail-werkvoorbereider-warmtenetten-oosterhout.json",
  },
  discovery: {
    kind: "sitemap",
    url: "https://www.werkenbijunica.nl/sitemap.xml",
  },
  excludePatterns: [
    /^(?!https:\/\/www\.werkenbijunica\.nl\/vacatures\/[^/]+-[a-z0-9-]+$).+$/u,
  ],
  listingFixturePath: "unica/listing-page-0.json",
  liveEnvVar: "UNICA_LIVE",
  parserVersion: "unica/v2",
  slug: "unica",
};
