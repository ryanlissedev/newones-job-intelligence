import { synthesizeJobPostingFromNextData } from "../extract";
import type { JsonLdConnectorConfig } from "../types";

/**
 * ASML's Sitecore/Next.js careers detail pages do not publish JobPosting
 * JSON-LD. The configured detailSynthesizer rebuilds that node from jobData in
 * __NEXT_DATA__; discovery remains limited to the job-posting sitemap.
 * Full time is mapped to schema.org FULL_TIME; other timeType values pass
 * through unchanged because ASML's vocabulary is not otherwise documented.
 */
export const asmlConfig: JsonLdConnectorConfig = {
  detailFixtures: {
    "https://www.asml.com/en/careers/find-your-job/senior-electrical-safety-expert-nominated-person--installatie-verantwoordelijke-euv-factory-j00333473":
      "asml/detail-senior-electrical-safety-expert-j00333473.json",
  },
  detailSynthesizer: synthesizeJobPostingFromNextData,
  discovery: {
    kind: "sitemap",
    url: "https://www.asml.com/en/job_posting-sitemap.xml",
  },
  excludePatterns: [
    /^https?:\/\/www\.asml\.com\/en\/careers\/find-your-job\/?(?:\?.*)?$/u,
    /[?&](?:job_country|query|job_type|job_teams|job_city|sort_by|tags|job_technical_fields|job_degrees|job_experience_levels|job_educational_backgrounds)=/iu,
    /^https?:\/\/www\.asml\.com\/sitecore(?:\/|$)/u,
    /^https?:\/\/www\.asml\.com\/en\/Presentation(?:\/|$)/u,
    /^https?:\/\/www\.asml\.com\/en\/careers\/find-your-job\/(?![^/?#]+-j\d+$)[^?#]+/u,
  ],
  listingFixturePath: "asml/listing-page-0.json",
  liveEnvVar: "ASML_LIVE",
  parserVersion: "asml/v2",
  slug: "asml",
};
