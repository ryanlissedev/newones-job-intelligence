import type { JsonLdConnectorConfig } from "../types";

export const heijmansConfig: JsonLdConnectorConfig = {
  detailFixtures: {
    "https://www.werkenbijheijmans.nl/vacatures/allround-bouwmedewerker-veldhoven-v-014984":
      "heijmans/detail-allround-bouwmedewerker-veldhoven-v-014984-soft-404.json",
    "https://www.werkenbijheijmans.nl/vacatures/lead-model-based-systems-engineer-mse-sysml-infra-utrecht-v-014566":
      "heijmans/detail-lead-mbse-infra-utrecht-v-014566.json",
    "https://www.werkenbijheijmans.nl/vacatures/maintenance-engineer-drachten-v-014747":
      "heijmans/detail-maintenance-engineer-drachten-v-014747.json",
    "https://www.werkenbijheijmans.nl/vacatures/manager-finance-control-energie-rosmalen-v-015264":
      "heijmans/detail-manager-finance-control-energie-rosmalen-v-015264.json",
    "https://www.werkenbijheijmans.nl/vacatures/modelleur-elektrotechniek-schiphol-v-010603":
      "heijmans/detail-modelleur-elektrotechniek-schiphol-v-010603.json",
    "https://www.werkenbijheijmans.nl/vacatures/servicedeskmedewerker-diemen-v-015120":
      "heijmans/detail-servicedeskmedewerker-diemen-v-015120.json",
    "https://www.werkenbijheijmans.nl/vacatures/trainee-asml-veldhoven-v-014192":
      "heijmans/detail-trainee-asml-veldhoven-v-014192.json",
    "https://www.werkenbijheijmans.nl/vacatures/trainee-civiele-funderingstechniek-rosmalen-v-014135":
      "heijmans/detail-trainee-civiele-funderingstechniek-rosmalen-v-014135.json",
    "https://www.werkenbijheijmans.nl/vacatures/werkvoorbereider-woningbouw-hoofddorp-v-014128":
      "heijmans/detail-werkvoorbereider-woningbouw-hoofddorp-v-014128.json",
  },
  discovery: {
    kind: "sitemap",
    url: "https://www.werkenbijheijmans.nl/sitemap.xml",
  },
  excludePatterns: [
    /^(?!https:\/\/www\.werkenbijheijmans\.nl\/vacatures\/[^/?#]+-v-\d+$).+$/u,
  ],
  listingFixturePath: "heijmans/listing-page-0.json",
  liveEnvVar: "HEIJMANS_LIVE",
  parserVersion: "heijmans/v2",
  slug: "heijmans",
};
