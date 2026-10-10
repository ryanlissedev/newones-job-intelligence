import type { JsonLdConnectorConfig } from "../types";

export const gasunieConfig: JsonLdConnectorConfig = {
  detailFixtures: {
    "https://www.werkenbijgasunie.nl/vacature/318/technicus-e-i-warmte-rotterdam-den-haag":
      "gasunie/detail-technicus-e-i-warmte-rotterdam-den-haag.json",
    "https://www.werkenbijgasunie.nl/vacature/341/production-lead":
      "gasunie/detail-production-lead.json",
  },
  discovery: {
    kind: "sitemap",
    url: "https://www.werkenbijgasunie.nl/sitemap.vacancy.xml",
  },
  excludePatterns: [
    /^(?!https:\/\/www\.werkenbijgasunie\.nl\/vacature\/\d+\/[^/?#]+$).+$/u,
  ],
  labelBlock: {
    // The location name is rendered only in the "vacancy-options" HTML list
    // (fa-map-marker icon → "Barendrecht"/"Rotterdam"). The JSON-LD
    // PostalAddress ships an empty addressLocality with a bare postalCode --
    // a postcode is not a place name, so only this label-block text feeds
    // `locatie`.
    locatie: {
      pattern: /<li class="vacancy-location">[\s\S]*?<\/i>\s*(?<value>[^<]+)/u,
    },
  },
  listingFixturePath: "gasunie/listing-page-0.json",
  liveEnvVar: "GASUNIE_LIVE",
  parserVersion: "gasunie/v2",
  slug: "gasunie",
};
