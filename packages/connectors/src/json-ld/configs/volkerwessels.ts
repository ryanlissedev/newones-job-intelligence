import { synthesizeContactsFromVolkerwesselsPage } from "../extract";
import type { JsonLdConnectorConfig } from "../types";

export const volkerwesselsConfig: JsonLdConnectorConfig = {
  detailFixtures: {
    "https://www.werkenbijvolkerwessels.nl/vacature/3334/voorman-timmerman":
      "volkerwessels/detail-voorman-timmerman-3334.json",
    "https://www.werkenbijvolkerwessels.nl/vacature/3353/projectontwikkelaar-1":
      "volkerwessels/detail-projectontwikkelaar-3353.json",
    "https://www.werkenbijvolkerwessels.nl/vacature/3383/calculator-21":
      "volkerwessels/detail-calculator-3383.json",
    "https://www.werkenbijvolkerwessels.nl/vacature/3400/vastgoedontwikkelaar":
      "volkerwessels/detail-vastgoedontwikkelaar-3400.json",
    "https://www.werkenbijvolkerwessels.nl/vacature/3434/uitvoerder-rs-o-1":
      "volkerwessels/detail-uitvoerder-3434.json",
    "https://www.werkenbijvolkerwessels.nl/vacature/3440/projectleider-industriebouw":
      "volkerwessels/detail-projectleider-industriebouw-3440.json",
    "https://www.werkenbijvolkerwessels.nl/vacature/3441/senior-calculator-kostendeskundige-3":
      "volkerwessels/detail-senior-calculator-3441.json",
    "https://www.werkenbijvolkerwessels.nl/vacature/3450/senior-projectmanager-1":
      "volkerwessels/detail-senior-projectmanager-3450.json",
  },
  detailSynthesizer: (body) => synthesizeContactsFromVolkerwesselsPage(body),
  discovery: {
    kind: "sitemap",
    url: "https://www.werkenbijvolkerwessels.nl/sitemap.vacancy.xml",
  },
  excludePatterns: [
    /^(?!https:\/\/www\.werkenbijvolkerwessels\.nl\/vacature\/[^/?#]+\/[^/?#]+$).+$/u,
  ],
  listingFixturePath: "volkerwessels/listing-page-0.json",
  liveEnvVar: "VOLKERWESSELS_LIVE",
  parserVersion: "volkerwessels/v2",
  slug: "volkerwessels",
};
