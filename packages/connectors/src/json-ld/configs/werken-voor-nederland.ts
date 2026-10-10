import type { JsonLdConnectorConfig } from "../types";

/** Werken voor Nederland is the Rijk careers hub. Its vacancy sitemap points
 * directly to detail pages that publish a JobPosting JSON-LD node. The
 * inventory has no reliable source-specific label block, so this connector is
 * intentionally JSON-LD-only. */
export const werkenVoorNederlandConfig: JsonLdConnectorConfig = {
  detailFixtures: {
    "https://www.werkenvoornederland.nl/vacatures/kubernetes-software-platform-engineer-CJIB-2026-9570":
      "werken-voor-nederland/detail-kubernetes-software-platform-engineer.json",
  },
  discovery: {
    kind: "sitemap",
    url: "https://www.werkenvoornederland.nl/sitemap-vacatures.xml",
  },
  excludePatterns: [
    /^https?:\/\/www\.werkenvoornederland\.nl\/login(?:\/|(?:\?.*)?$)/u,
    /^https?:\/\/www\.werkenvoornederland\.nl\/vacatures\/?(?:\?.*)?$/u,
    /^https?:\/\/www\.werkenvoornederland\.nl\/(?!vacatures\/[^/?]+$).+/u,
  ],
  listingFixturePath: "werken-voor-nederland/listing-page-0.json",
  liveEnvVar: "WERKEN_VOOR_NEDERLAND_LIVE",
  parserVersion: "werken-voor-nederland/v2",
  slug: "werken-voor-nederland",
};
