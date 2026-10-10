import {
  createFreelancerNlClient,
  createFreelancerNlConnector,
} from "@ji/connectors/freelancer-nl";

import { normaliseFreelancerNlObservation } from "../normalise/freelancer-nl";
import type { SourceDefinition } from "./definition";

export const freelancerNl = {
  bronId: "00000000-0000-4000-8000-000000000012",
  // The listing only contains a summary; detail title, description, status and
  // structured fields can change without the listing hash changing.
  createConnector: ({ bronId, listingFixturePath }) =>
    createFreelancerNlConnector({
      bronId,
      client: listingFixturePath
        ? createFreelancerNlClient({ listingFixturePath, liveEnabled: false })
        : undefined,
    }),
  listingHashCoversDetail: false,
  liveEnv: "FREELANCER_NL_LIVE",
  naam: "Freelancer.nl",
  normalise: normaliseFreelancerNlObservation,
  seed: {
    crawlDelayMs: 2000,
    methode: "html",
    voorwaardenStatus: "te_toetsen",
  },
  slug: "freelancer-nl",
} satisfies SourceDefinition<"freelancer-nl">;
