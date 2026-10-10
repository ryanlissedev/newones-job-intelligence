import type { JsonLdConnectorConfig } from "../types";

export const bamConfig: JsonLdConnectorConfig = {
  detailFixtures: {
    "https://www.bamcareers.com/nl/nl/job/24586/Werkvoorbereider-Elektrotechniek":
      "bam/detail-werkvoorbereider-elektrotechniek-24586.json",
    "https://www.bamcareers.com/nl/nl/job/26209/Medewerker-Verkeersmaatregelen":
      "bam/detail-medewerker-verkeersmaatregelen-26209.json",
    "https://www.bamcareers.com/nl/nl/job/26832/Tendermanager-Bouw":
      "bam/detail-tendermanager-bouw-26832.json",
  },
  discovery: {
    kind: "sitemap",
    url: "https://www.bamcareers.com/nl/nl/sitemap.xml",
  },
  excludePatterns: [
    /^(?!https:\/\/www\.bamcareers\.com\/nl\/nl\/job\/\d+\/[^/?#]+$).+$/u,
  ],
  listingFixturePath: "bam/listing-page-0.json",
  liveEnvVar: "BAM_LIVE",
  parserVersion: "bam/v2",
  slug: "bam",
};
