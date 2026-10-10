import {
  createJsonLdClient,
  createJsonLdConnector,
  datajobsConfig,
} from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "../normalise/json-ld";
import type { SourceDefinition } from "./definition";

export const datajobs = {
  bronId: "00000000-0000-4000-8000-000000000018",
  createConnector: ({ bronId, listingFixturePath }) =>
    createJsonLdConnector({
      bronId,
      client: listingFixturePath
        ? createJsonLdClient({
            config: datajobsConfig,
            listingFixturePath,
            liveEnabled: false,
          })
        : undefined,
      config: datajobsConfig,
    }),
  listingHashCoversDetail: false,
  liveEnv: "DATAJOBS_LIVE",
  naam: "DataJobs.nl",
  normalise: normaliseJsonLdObservation,
  seed: {
    crawlDelayMs: 2000,
    methode: "json-ld",
    voorwaardenStatus: "te_toetsen",
  },
  slug: "datajobs",
} satisfies SourceDefinition<"datajobs">;
