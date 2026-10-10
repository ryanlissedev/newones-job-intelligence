import {
  createJsonLdClient,
  createJsonLdConnector,
  vattenfallConfig,
} from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "../normalise/json-ld";
import type { SourceDefinition } from "./definition";

export const vattenfall = {
  bronId: "00000000-0000-4000-8000-00000000001d",
  // Sitemap metadata covers only the URL, not detail-page JobPosting fields.
  // Do not pass known hashes, so detail-only changes remain observable.
  createConnector: ({ bronId, listingFixturePath }) =>
    createJsonLdConnector({
      bronId,
      client: listingFixturePath
        ? createJsonLdClient({
            config: vattenfallConfig,
            listingFixturePath,
            liveEnabled: false,
          })
        : undefined,
      config: vattenfallConfig,
    }),
  listingHashCoversDetail: false,
  liveEnv: "VATTENFALL_LIVE",
  naam: "Vattenfall",
  normalise: normaliseJsonLdObservation,
  seed: {
    crawlDelayMs: 2000,
    methode: "json-ld",
    voorwaardenStatus: "te_toetsen",
  },
  slug: "vattenfall",
} satisfies SourceDefinition<"vattenfall">;
