import {
  createJsonLdClient,
  createJsonLdConnector,
  tbiConfig,
} from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "../normalise/json-ld";
import type { SourceDefinition } from "./definition";

export const tbi = {
  bronId: "00000000-0000-4000-8000-000000000011",
  // Sitemap metadata covers only the URL, not detail-page JobPosting fields.
  // Do not pass known hashes, so detail-only changes remain observable.
  createConnector: ({ bronId, listingFixturePath }) =>
    createJsonLdConnector({
      bronId,
      client: listingFixturePath
        ? createJsonLdClient({
            config: tbiConfig,
            listingFixturePath,
            liveEnabled: false,
          })
        : undefined,
      config: tbiConfig,
    }),
  listingHashCoversDetail: false,
  liveEnv: "TBI_LIVE",
  naam: "TBI",
  normalise: normaliseJsonLdObservation,
  seed: {
    crawlDelayMs: 2000,
    methode: "json-ld",
    voorwaardenStatus: "te_toetsen",
  },
  slug: "tbi",
} satisfies SourceDefinition<"tbi">;
