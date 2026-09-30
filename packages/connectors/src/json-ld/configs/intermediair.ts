import type { JsonLdConnectorConfig } from "../types";

/** Intermediair publishes a single hourly-refreshed vacancy sitemap behind an index. */
export const intermediairConfig: JsonLdConnectorConfig = {
  detailFixtures: {
    "https://www.intermediair.nl/vacature/004041c6-d11e-4a10-973e-b64cc84081cf/junior-intercedent":
      "intermediair/detail-junior-intercedent.json",
    "https://www.intermediair.nl/vacature/00e53409-2ef3-4730-859a-3e63885be9b7/business-controller-finance-business-partner":
      "intermediair/detail-business-controller-finance-business-partner.json",
    "https://www.intermediair.nl/vacature/0175474c-9c32-4259-91af-c283ad43c89a/supply-chain-consultant":
      "intermediair/detail-supply-chain-consultant.json",
    "https://www.intermediair.nl/vacature/0183eb77-d51b-41fd-819e-9d406609a1a5/student-assistent":
      "intermediair/detail-student-assistent.json",
    "https://www.intermediair.nl/vacature/0187eb17-d388-4b7f-a6d0-5b195e5df0f1/customer-service-medewerker":
      "intermediair/detail-customer-service-medewerker.json",
    "https://www.intermediair.nl/vacature/0cad6431-f0e1-4d5a-9872-d4cba5ef0225/asfaltuitvoerder":
      "intermediair/detail-asfaltuitvoerder.json",
    "https://www.intermediair.nl/vacature/7fd25dd1-894d-4844-acf7-b5b672a10afc/klantmanager-werk-en-inkomen":
      "intermediair/detail-klantmanager-werk-en-inkomen.json",
    "https://www.intermediair.nl/vacature/f7184d95-36c8-4b0c-8a6d-c4054a749c39/validatie-technicus":
      "intermediair/detail-validatie-technicus.json",
  },
  discovery: {
    childPattern: /\/vacature-(?<chunk>\d+)\.xml$/u,
    kind: "sitemap-index",
    newest: 1,
    url: "https://www.intermediair.nl/cdn/sitemaps/vacature.xml",
  },
  listingFixturePath: "intermediair/listing-page-0.json",
  liveEnvVar: "INTERMEDIAIR_LIVE",
  parserVersion: "intermediair/v2",
  sitemapFixtures: {
    "https://intermediair.nl/cdn/sitemaps/vacature/vacature-1.xml":
      "intermediair/sitemap-vacature-1.json",
  },
  slug: "intermediair",
};
