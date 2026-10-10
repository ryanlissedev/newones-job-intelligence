import { synthesizeJobPostingFromEssentFeatures } from "../extract";
import type { JsonLdConnectorConfig } from "../types";

/**
 * Essent (Kentico, www.werkenbijessent.nl). The sitemap mixes ~30 vacancy URLs
 * (`/nl/vacatures/<vakgebied>/<slug>`, including a literal `vacatures` category)
 * with ~145 content pages; the whitelist keeps only the two-segment vacancy
 * shape. Detail pages carry no JobPosting JSON-LD — vacancy metadata sits in a
 * `data:text/javascript;base64` Vue `DataItems` payload plus `og:`/`article:`
 * metas; the detailSynthesizer decodes both. The `salary` item is a monthly
 * range for a vaste functie → labelBlock.salaris only, never `tarief`.
 */
export const essentConfig: JsonLdConnectorConfig = {
  detailFixtures: {
    "https://www.werkenbijessent.nl/nl/vacatures/customer-services/klantadviseur":
      "essent/detail-klantadviseur.json",
    "https://www.werkenbijessent.nl/nl/vacatures/customer-services/klantadviseur-1":
      "essent/detail-klantadviseur-1.json",
    "https://www.werkenbijessent.nl/nl/vacatures/customer-services/klantadviseur-sales":
      "essent/detail-klantadviseur-sales.json",
    "https://www.werkenbijessent.nl/nl/vacatures/engineering/project-manager-warmtenetten":
      "essent/detail-project-manager-warmtenetten.json",
    "https://www.werkenbijessent.nl/nl/vacatures/vacatures/financial-controller":
      "essent/detail-financial-controller.json",
  },
  detailSynthesizer: synthesizeJobPostingFromEssentFeatures,
  discovery: {
    kind: "sitemap",
    url: "https://www.werkenbijessent.nl/sitemap.xml",
  },
  excludePatterns: [
    /^(?!https:\/\/www\.werkenbijessent\.nl\/nl\/vacatures\/[^/]+\/[^/]+\/?$).+$/u,
  ],
  listingFixturePath: "essent/listing-page-0.json",
  liveEnvVar: "ESSENT_LIVE",
  parserVersion: "essent/v2",
  slug: "essent",
};
