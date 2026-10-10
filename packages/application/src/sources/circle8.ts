import {
  circle8Config,
  createJsonLdClient,
  createJsonLdConnector,
} from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "../normalise/json-ld";
import type { SourceDefinition } from "./definition";

export const circle8 = {
  bronId: "00000000-0000-4000-8000-000000000042",
  createConnector: ({ bronId, listingFixturePath }) =>
    createJsonLdConnector({
      bronId,
      client: listingFixturePath
        ? createJsonLdClient({
            config: circle8Config,
            listingFixturePath,
            liveEnabled: false,
          })
        : undefined,
      config: circle8Config,
    }),
  listingHashCoversDetail: false,
  liveEnv: "CIRCLE8_LIVE",
  naam: "Circle8",
  normalise: normaliseJsonLdObservation,
  seed: {
    crawlDelayMs: 2000,
    methode: "json-ld",
    voorwaardenStatus: "te_toetsen",
  },
  slug: "circle8",
} satisfies SourceDefinition<"circle8">;
