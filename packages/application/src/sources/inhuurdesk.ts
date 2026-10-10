import {
  createInhuurdeskClient,
  createInhuurdeskConnector,
} from "@ji/connectors/inhuurdesk";

import { normaliseInhuurdeskObservation } from "../normalise/inhuurdesk";
import type { SourceDefinition } from "./definition";

export const inhuurdesk = {
  bronId: "00000000-0000-4000-8000-000000000002",
  createConnector: ({ bronId, knownHashes, listingFixturePath }) =>
    createInhuurdeskConnector({
      bronId,
      client: listingFixturePath
        ? createInhuurdeskClient({ listingFixturePath, liveEnabled: false })
        : undefined,
      knownHashes,
    }),
  // RJC-357/RJC-401: listing hash covers every InhuurdeskAssignment field (fetch re-serialises the listing row; no detail request) -- see docs/sources/inhuurdesk.md.
  listingHashCoversDetail: true,
  liveEnv: "INHUURDESK_LIVE",
  naam: "Inhuurdesk",
  normalise: normaliseInhuurdeskObservation,
  seed: {
    crawlDelayMs: 500,
    methode: "json-api",
    voorwaardenStatus: "toegestaan",
  },
  slug: "inhuurdesk",
} satisfies SourceDefinition<"inhuurdesk">;
