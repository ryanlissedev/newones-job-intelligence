import { synthesizeJobPostingFromAvature } from "../extract";
import type { JsonLdConnectorConfig } from "../types";

/**
 * TenneT careers run on Avature (careers.tennet.eu; robots allows the
 * careers portals and advertises the sitemap index). The nl_NL sitemap lists 142 JobDetail
 * URLs (`/nl_NL/careers/JobDetail/<slug>/<numeric-id>`) among ~47 utility
 * pages; the whitelist keeps only the numeric-id detail shape. Detail pages
 * are server-rendered narrative HTML without JobPosting JSON-LD — the
 * detailSynthesizer takes `og:title`, the `jobId` from `og:url`/URL, and the
 * `article--details` bodies. Avature publishes no stable location field on the
 * detail page, so jobLocation stays country-only; locatie is UNKNOWN at the
 * source, not inferred from the slug or prose.
 */
export const tennetConfig: JsonLdConnectorConfig = {
  detailFixtures: {
    "https://careers.tennet.eu/nl_NL/careers/JobDetail/Operating-Engineer-Electrical-Auxiliary-Automation-Expat-EU-Resident-Malaysia-Johor-Bahru/91976":
      "tennet/detail-operating-engineer-johor-bahru-91976.json",
    "https://careers.tennet.eu/nl_NL/careers/JobDetail/Power-System-EMT-Specialist/99587":
      "tennet/detail-power-system-emt-specialist-99587.json",
    "https://careers.tennet.eu/nl_NL/careers/JobDetail/Toezichthouder-Transmission-Lines-Brabant/94548":
      "tennet/detail-toezichthouder-transmission-lines-brabant-94548.json",
  },
  detailSynthesizer: synthesizeJobPostingFromAvature,
  discovery: {
    kind: "sitemap",
    url: "https://careers.tennet.eu/nl_NL/careers/sitemap.xml",
  },
  excludePatterns: [
    /^(?!https:\/\/careers\.tennet\.eu\/nl_NL\/careers\/JobDetail\/[^/]+\/\d+\/?$).+$/u,
  ],
  listingFixturePath: "tennet/listing-page-0.json",
  liveEnvVar: "TENNET_LIVE",
  parserVersion: "tennet/v2",
  slug: "tennet",
};
