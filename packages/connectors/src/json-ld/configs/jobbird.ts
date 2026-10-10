import type { JsonLdConnectorConfig } from "../types";

/**
 * Jobbird's freelance/zzp category is a deterministic, relevant listing
 * surface. Use it instead of the generic full job sitemap; one discovery URL
 * deliberately covers page one only, matching the JSON-LD client's bounded
 * single-pass discovery model.
 */
export const jobbirdConfig: JsonLdConnectorConfig = {
  detailFixtures: {
    "https://www.jobbird.com/nl/vacature/25796307-freelance-inkoper-sociaal-domein-zzp":
      "jobbird/detail-25796307-freelance-inkoper-sociaal-domein-zzp.json",
    "https://www.jobbird.com/nl/vacature/25849909-freelance-business-controller-zzp":
      "jobbird/detail-25849909-freelance-business-controller-zzp.json",
    "https://www.jobbird.com/nl/vacature/25852520-freelance-adviseur-kcc-zzp":
      "jobbird/detail-25852520-freelance-adviseur-kcc-zzp.json",
  },
  discovery: {
    kind: "listing",
    linkPattern: /^\/nl\/vacature\/\d+-[^/]+$/u,
    url: "https://www.jobbird.com/nl/dienstverband/freelance-zzp",
  },
  listingFixturePath: "jobbird/listing-page-0.json",
  liveEnvVar: "JOBBIRD_LIVE",
  parserVersion: "jobbird/v2",
  slug: "jobbird",
};
