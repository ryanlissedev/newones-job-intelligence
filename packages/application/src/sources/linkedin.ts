import {
  createLinkedinClient,
  createLinkedinConnector,
} from "@ji/connectors/linkedin";

import { normaliseJsonLdObservation } from "../normalise/json-ld";
import type { SourceDefinition } from "./definition";

/**
 * LinkedIn Jobs public guest route (CTP-549 POC; ToS waived for this POC by
 * the owner). Listing fragments come from `/jobs-guest/jobs/api/
 * seeMoreJobPostings/search`, details from the public `/jobs/view/` page,
 * which carries a JobPosting `ld+json` node ~sometimes — the connector
 * synthesises it from topcard/criteria markup when absent, so the emitted
 * body is always JsonLdFetchedPayload-shaped and the shared JSON-LD
 * normaliser applies unchanged.
 */
export const linkedin = {
  bronId: "00000000-0000-4000-8000-000000000043",
  createConnector: ({ bronId, listingFixturePath }) =>
    createLinkedinConnector({
      bronId,
      client: listingFixturePath
        ? createLinkedinClient({ listingFixturePath, liveEnabled: false })
        : undefined,
    }),
  // RJC-357/RJC-401: the listing hash covers card fields only — criteria,
  // description and JobPosting edits are detail-page changes it cannot see.
  listingHashCoversDetail: false,
  liveEnv: "LINKEDIN_LIVE",
  naam: "LinkedIn Jobs",
  normalise: normaliseJsonLdObservation,
  seed: {
    crawlDelayMs: 2000,
    methode: "json-ld",
    voorwaardenStatus: "te_toetsen",
  },
  slug: "linkedin",
} satisfies SourceDefinition<"linkedin">;
