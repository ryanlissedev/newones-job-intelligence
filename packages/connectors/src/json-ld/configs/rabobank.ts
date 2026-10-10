import type { JsonLdConnectorConfig } from "../types";

/**
 * Rabobank's Sanity-backed careers pages publish a JobPosting JSON-LD node.
 * The sitemap contains EN and NL twins for the same JR requisition; ingest EN
 * only so one requisition does not become two observations. Workday is visible
 * only through historical analytics/apply integration details and is not a
 * discovery surface for this connector.
 */
export const rabobankConfig: JsonLdConnectorConfig = {
  detailFixtures: {
    "https://rabobank.jobs/en/job/active-directory-engineer/JR_00144349/":
      "rabobank/detail-active-directory-engineer-jr-00144349.json",
  },
  discovery: {
    kind: "sitemap",
    url: "https://rabobank.jobs/api/sitemap/",
  },
  excludePatterns: [
    /\/en\/jobs\/?(?:[?#].*)?$/u,
    /\/nl\/vacatures\/?(?:[?#].*)?$/u,
    /\/(?:en\/search|nl\/zoeken)\/?(?:[?#].*)?$/u,
    /^https?:\/\/rabobank\.jobs\/(?:en|nl)\/?(?:[?#].*)?$/u,
    /\/(?:en|nl)\/job-alert(?:\/|[?#]|$)/u,
    /\/(?:artikel|article)(?:\/|[?#]|$)/u,
    /\/(?:traineeships|techblog|overview)(?:\/|[?#]|$)/iu,
    /\/nl\/vacature\//u,
    // The sitemap also contains non-job CMS URLs. Keep only the exact EN
    // detail shape, including its required JR requisition identifier.
    /^(?!https:\/\/rabobank\.jobs\/en\/job\/[^/]+\/JR_\d+\/$).+$/u,
  ],
  listingFixturePath: "rabobank/listing-page-0.json",
  liveEnvVar: "RABOBANK_LIVE",
  parserVersion: "rabobank/v2",
  slug: "rabobank",
};
