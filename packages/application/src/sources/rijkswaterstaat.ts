import {
  createJsonLdClient,
  createJsonLdConnector,
  rijkswaterstaatConfig,
} from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "../normalise/json-ld";
import type { SourceDefinition } from "./definition";

export const rijkswaterstaat = {
  bronId: "00000000-0000-4000-8000-00000000001b",
  createConnector: ({ bronId, listingFixturePath }) =>
    createJsonLdConnector({
      bronId,
      client: listingFixturePath
        ? createJsonLdClient({
            config: rijkswaterstaatConfig,
            listingFixturePath,
            liveEnabled: false,
          })
        : undefined,
      config: rijkswaterstaatConfig,
    }),
  listingHashCoversDetail: false,
  liveEnv: "RIJKSWATERSTAAT_LIVE",
  naam: "Rijkswaterstaat",
  normalise: normaliseJsonLdObservation,
  seed: {
    crawlDelayMs: 2000,
    methode: "json-ld",
    voorwaardenStatus: "te_toetsen",
  },
  slug: "rijkswaterstaat",
} satisfies SourceDefinition<"rijkswaterstaat">;
