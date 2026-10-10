import { synthesizeContactsFromRandstadPage } from "../extract";
import type { JsonLdConnectorConfig } from "../types";

/** Randstad's sitemap contains the complete staffing board and links directly
 * to vacancy detail pages with JobPosting JSON-LD. */
export const randstadConfig: JsonLdConnectorConfig = {
  detailFixtures: {
    "https://www.randstad.nl/vacatures/741140/vrachtwagenchauffeur-allround":
      "randstad/detail-vrachtwagenchauffeur-allround-741140.json",
    "https://www.randstad.nl/vacatures/749250/operator":
      "randstad/detail-operator-749250.json",
    "https://www.randstad.nl/vacatures/752363/teamleider":
      "randstad/detail-teamleider-752363.json",
  },
  detailSynthesizer: (body) => synthesizeContactsFromRandstadPage(body),
  discovery: {
    kind: "sitemap",
    url: "https://www.randstad.nl/job-sitemap.xml",
  },
  excludePatterns: [/^https:\/\/www\.randstad\.nl\/vacatures\/?(?:\?.*)?$/u],
  listingFixturePath: "randstad/listing-page-0.json",
  liveEnvVar: "RANDSTAD_LIVE",
  parserVersion: "randstad/v2",
  slug: "randstad",
};
