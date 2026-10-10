import { synthesizeContactsFromRijkswaterstaatPage } from "../extract";
import type { JsonLdConnectorConfig } from "../types";

/** Rijkswaterstaat's broad CMS sitemap is reduced to its numeric vacancy
 * detail shape; those pages publish direct-employer JobPosting JSON-LD. */
export const rijkswaterstaatConfig: JsonLdConnectorConfig = {
  detailFixtures: {
    "https://werkenbij.rijkswaterstaat.nl/vacatures/adviseur-assetmanagement-rivierbodem/1330716":
      "rijkswaterstaat/detail-adviseur-assetmanagement-rivierbodem-1330716.json",
    "https://werkenbij.rijkswaterstaat.nl/vacatures/adviseur-waterveiligheid/1310882":
      "rijkswaterstaat/detail-adviseur-waterveiligheid-1310882.json",
    "https://werkenbij.rijkswaterstaat.nl/vacatures/jurist-handhaving/1318820":
      "rijkswaterstaat/detail-jurist-handhaving-1318820.json",
  },
  detailSynthesizer: (body) => synthesizeContactsFromRijkswaterstaatPage(body),
  discovery: {
    kind: "sitemap",
    url: "https://werkenbij.rijkswaterstaat.nl/sitemap.xml",
  },
  excludePatterns: [
    /^https:\/\/werkenbij\.rijkswaterstaat\.nl\/(?!vacatures\/[^/?]+\/\d+\/?(?:\?.*)?$).+$/u,
  ],
  listingFixturePath: "rijkswaterstaat/listing-page-0.json",
  liveEnvVar: "RIJKSWATERSTAAT_LIVE",
  parserVersion: "rijkswaterstaat/v2",
  slug: "rijkswaterstaat",
};
