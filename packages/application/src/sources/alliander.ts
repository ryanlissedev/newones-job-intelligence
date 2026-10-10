import {
  allianderConfig,
  createJsonLdClient,
  createJsonLdConnector,
} from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "../normalise/json-ld";
import type { SourceDefinition } from "./definition";

export const alliander = {
  bronId: "00000000-0000-4000-8000-00000000003a",
  // Sitemap metadata covers only the URL, not detail-page fields.
  // Do not pass known hashes, so detail-only changes remain observable.
  createConnector: ({ bronId, listingFixturePath }) =>
    createJsonLdConnector({
      bronId,
      client: listingFixturePath
        ? createJsonLdClient({
            config: allianderConfig,
            listingFixturePath,
            liveEnabled: false,
          })
        : undefined,
      config: allianderConfig,
    }),
  listingHashCoversDetail: false,
  liveEnv: "ALLIANDER_LIVE",
  naam: "Alliander",
  normalise: normaliseJsonLdObservation,
  seed: {
    crawlDelayMs: 2000,
    methode: "json-ld",
    voorwaardenStatus: "te_toetsen",
  },
  slug: "alliander",
} satisfies SourceDefinition<"alliander">;
