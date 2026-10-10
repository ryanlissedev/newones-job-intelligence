import { synthesizeJobPostingFromAllianderVacancy } from "../extract";
import type { JsonLdConnectorConfig } from "../types";

/**
 * Alliander (Next.js/Sitecore on werkenbij.alliander.com — the www host has a
 * certificate mismatch and the sitemap lives on the bare domain). The sitemap
 * lists every `/vacatures/<slug>/jr<id>` detail page (187 at capture,
 * 2026-09-30), but those pages are client-rendered shells: the vacancy record
 * is served by the public JSON endpoint `/api/vacancy/<id>`. detailUrlRewrite
 * maps each discovered public URL onto that endpoint for the fetch, while the
 * observation keeps the public URL; the detailSynthesizer projects the API
 * record onto a JobPosting. `contactPerson*` fields become `contactpersonen`
 * (CTP-610); `compensationGrade` is a salarisschaal label and lands in
 * labelBlock only.
 */
export const allianderConfig: JsonLdConnectorConfig = {
  detailFixtures: {
    "https://werkenbij.alliander.com/vacatures/business-partner-veiligheid-milieu-en-kwaliteit/jr14092":
      "alliander/detail-jr14092.json",
    "https://werkenbij.alliander.com/vacatures/cloud-security-specialist/jr17461":
      "alliander/detail-jr17461.json",
    "https://werkenbij.alliander.com/vacatures/gasmonteur-in-opleiding/jr18244":
      "alliander/detail-jr18244.json",
  },
  detailSynthesizer: synthesizeJobPostingFromAllianderVacancy,
  detailUrlRewrite: {
    // Sitemap paths carry the lowercase `jr<id>` form, but the Sitecore
    // vacancy API routes the id uppercase — the recorded captures all hit
    // `/api/vacancy/JR<id>`.
    pattern: /^\/vacatures\/[^/]+\/jr(?<id>\d+)\/?$/iu,
    replace: "/api/vacancy/JR$<id>",
  },
  discovery: {
    kind: "sitemap",
    url: "https://werkenbij.alliander.com/sitemap.xml",
  },
  excludePatterns: [
    /^(?!https:\/\/werkenbij\.alliander\.com\/vacatures\/[^/]+\/jr\d+\/?$).+$/iu,
  ],
  listingFixturePath: "alliander/listing-page-0.json",
  liveEnvVar: "ALLIANDER_LIVE",
  parserVersion: "alliander/v2",
  slug: "alliander",
};
