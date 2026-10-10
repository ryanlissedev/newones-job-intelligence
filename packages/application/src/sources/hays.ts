import {
  createJsonLdClient,
  createJsonLdConnector,
  haysConfig,
} from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "../normalise/json-ld";
import type { SourceDefinition } from "./definition";

export const hays = {
  bronId: "00000000-0000-4000-8000-00000000001a",
  createConnector: ({ bronId, listingFixturePath }) =>
    createJsonLdConnector({
      bronId,
      client: listingFixturePath
        ? createJsonLdClient({
            config: haysConfig,
            listingFixturePath,
            liveEnabled: false,
          })
        : undefined,
      config: haysConfig,
    }),
  listingHashCoversDetail: false,
  liveEnv: "HAYS_LIVE",
  naam: "Hays",
  normalise: normaliseJsonLdObservation,
  seed: {
    crawlDelayMs: 10_000,
    methode: "json-ld",
    voorwaardenStatus: "te_toetsen",
  },
  slug: "hays",
} satisfies SourceDefinition<"hays">;
