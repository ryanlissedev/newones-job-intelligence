import type { JsonLdConnectorConfig } from "../types";

/**
 * Hero.eu (Next.js RSC, SSR) -- note the `.eu` TLD, not `.nl`. The listing page
 * (`/interim-opdrachten`) carries no JSON-LD; discovery instead extracts detail links
 * matching `/interim-opdrachten/<slug>` directly from the listing HTML. Detail pages
 * carry a thin JobPosting (only `workHours`, no tarief/start/deadline; hiring
 * organisation is anonymised to "Hero Interim Professionals"). Robots: `/api/`
 * disallowed; GPTBot/ClaudeBot explicitly allowed.
 */
export const heroConfig: JsonLdConnectorConfig = {
  detailBaseUrl: "https://hero.eu",
  detailFixtures: {
    "https://hero.eu/interim-opdrachten/devops-engineer-1f2fde9f":
      "hero/detail-1.json",
    "https://hero.eu/interim-opdrachten/front-end-developer-9c99b237":
      "hero/detail-2.json",
  },
  discovery: {
    kind: "listing",
    // Matched against the resolved URL's pathname (see extractListingLinks), so this
    // also accepts an absolute href even though live capture (2026-08-31) confirms
    // hero.eu's own listing renders only relative hrefs today.
    linkPattern: /^\/interim-opdrachten\/[a-z0-9-]+$/u,
    url: "https://hero.eu/interim-opdrachten",
  },
  excludePatterns: [/\/api\//u],
  listingFixturePath: "hero/listing-page-0.json",
  liveEnvVar: "HERO_LIVE",
  parserVersion: "hero/v2",
  slug: "hero",
};
