import {
  createJsonLdClient,
  createJsonLdConnector,
  jobbirdConfig,
} from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "../normalise/json-ld";
import type { SourceDefinition } from "./definition";

export const jobbird = {
  bronId: "00000000-0000-4000-8000-000000000017",
  createConnector: ({ bronId, listingFixturePath }) =>
    createJsonLdConnector({
      bronId,
      client: listingFixturePath
        ? createJsonLdClient({
            config: jobbirdConfig,
            listingFixturePath,
            liveEnabled: false,
          })
        : undefined,
      config: jobbirdConfig,
    }),
  listingHashCoversDetail: false,
  liveEnv: "JOBBIRD_LIVE",
  naam: "Jobbird",
  normalise: normaliseJsonLdObservation,
  seed: {
    crawlDelayMs: 2000,
    methode: "json-ld",
    voorwaardenStatus: "te_toetsen",
  },
  slug: "jobbird",
} satisfies SourceDefinition<"jobbird">;
