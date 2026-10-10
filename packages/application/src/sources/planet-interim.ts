import {
  createJsonLdConnector,
  planetInterimConfig,
} from "@ji/connectors/json-ld";
import { createPlanetInterimClient } from "@ji/connectors/planet-interim";

import { normaliseJsonLdObservation } from "../normalise/json-ld";
import type { SourceDefinition } from "./definition";

export const planetInterim = {
  bronId: "00000000-0000-4000-8000-000000000038",
  // Listing pages expose detail URLs; Planet's client replays WebForms pagination
  // while JobPosting lives on each detail page.
  createConnector: ({ bronId, listingFixturePath }) =>
    createJsonLdConnector({
      bronId,
      client: listingFixturePath
        ? createPlanetInterimClient({
            config: planetInterimConfig,
            listingFixturePath,
            liveEnabled: false,
          })
        : createPlanetInterimClient({ config: planetInterimConfig }),
      config: planetInterimConfig,
    }),
  listingHashCoversDetail: false,
  liveEnv: "PLANET_INTERIM_LIVE",
  naam: "Planet Interim",
  normalise: normaliseJsonLdObservation,
  seed: {
    crawlDelayMs: 2000,
    methode: "json-ld",
    voorwaardenStatus: "te_toetsen",
  },
  slug: "planet-interim",
} satisfies SourceDefinition<"planet-interim">;
