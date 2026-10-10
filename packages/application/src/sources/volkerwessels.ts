import {
  createJsonLdClient,
  createJsonLdConnector,
  volkerwesselsConfig,
} from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "../normalise/json-ld";
import type { SourceDefinition } from "./definition";

export const volkerwessels = {
  bronId: "00000000-0000-4000-8000-000000000014",
  // Sitemap metadata covers only the URL, not detail-page JobPosting fields.
  createConnector: ({ bronId, listingFixturePath }) =>
    createJsonLdConnector({
      bronId,
      client: listingFixturePath
        ? createJsonLdClient({
            config: volkerwesselsConfig,
            listingFixturePath,
            liveEnabled: false,
          })
        : undefined,
      config: volkerwesselsConfig,
    }),
  listingHashCoversDetail: false,
  liveEnv: "VOLKERWESSELS_LIVE",
  naam: "VolkerWessels",
  normalise: normaliseJsonLdObservation,
  seed: {
    crawlDelayMs: 2000,
    methode: "json-ld",
    voorwaardenStatus: "te_toetsen",
  },
  slug: "volkerwessels",
} satisfies SourceDefinition<"volkerwessels">;
