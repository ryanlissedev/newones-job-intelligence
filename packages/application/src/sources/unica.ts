import {
  createJsonLdClient,
  createJsonLdConnector,
  unicaConfig,
} from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "../normalise/json-ld";
import type { SourceDefinition } from "./definition";

export const unica = {
  bronId: "00000000-0000-4000-8000-00000000001f",
  // Sitemap metadata covers only the URL, not detail-page JobPosting fields.
  // Do not pass known hashes, so detail-only changes remain observable.
  createConnector: ({ bronId, listingFixturePath }) =>
    createJsonLdConnector({
      bronId,
      client: listingFixturePath
        ? createJsonLdClient({
            config: unicaConfig,
            listingFixturePath,
            liveEnabled: false,
          })
        : undefined,
      config: unicaConfig,
    }),
  listingHashCoversDetail: false,
  liveEnv: "UNICA_LIVE",
  naam: "Unica",
  normalise: normaliseJsonLdObservation,
  seed: {
    crawlDelayMs: 2000,
    methode: "json-ld",
    voorwaardenStatus: "te_toetsen",
  },
  slug: "unica",
} satisfies SourceDefinition<"unica">;
