import { synthesizeJobPostingFromVike } from "../extract";
import type { JsonLdConnectorConfig } from "../types";

/**
 * Techniekwerkt detail pages carry no JobPosting JSON-LD (only a BreadcrumbList),
 * but the Vike SSR payload `vike_pageContext.pageProps.job` holds the vacancy as
 * a structured object — the configured detailSynthesizer rebuilds the
 * JobPosting from it. The vacancy sitemap is served gzip-compressed under
 * `application/x-compressed` without a `Content-Encoding` header; the shared
 * live reader inflates it by magic bytes. `salary`/`contract` facets were empty
 * on every sampled detail (2026-09-17); they map to labelBlock only when the
 * source populates them, never to tarief/employmentType.
 */
export const techniekwerktConfig: JsonLdConnectorConfig = {
  detailFixtures: {
    "https://techniekwerkt.nl/nl/vacature/leerling-monteur-werktuigbouwkunde-unica-rotterdam-973440":
      "techniekwerkt/detail-leerling-monteur-werktuigbouwkunde-unica-rotterdam.json",
    "https://techniekwerkt.nl/nl/vacature/monteur-elektrotechniek-unica-eindhoven-973508":
      "techniekwerkt/detail-monteur-elektrotechniek-unica-eindhoven.json",
    "https://techniekwerkt.nl/nl/vacature/pcs-7-software-engineer-unica-zwolle-973447":
      "techniekwerkt/detail-pcs-7-software-engineer-unica-zwolle.json",
  },
  detailSynthesizer: synthesizeJobPostingFromVike,
  discovery: {
    kind: "sitemap",
    url: "https://media.techniekwerkt.nl/sitemaps/vacatures.xml.gz",
  },
  excludePatterns: [
    /^(?!https:\/\/techniekwerkt\.nl\/nl\/vacature\/[^/]+-\d+$).+$/u,
  ],
  listingFixturePath: "techniekwerkt/listing-page-0.json",
  liveEnvVar: "TECHNIEKWERKT_LIVE",
  parserVersion: "techniekwerkt/v2",
  slug: "techniekwerkt",
};
