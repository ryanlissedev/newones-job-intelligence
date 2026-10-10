import {
  createJsonLdClient,
  createJsonLdConnector,
  nsConfig,
} from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "../normalise/json-ld";
import type { SourceDefinition } from "./definition";

export const ns = {
  bronId: "00000000-0000-4000-8000-000000000021",
  // Listing metadata covers only detail URLs, not JobPosting fields.
  // Do not pass known hashes, so detail-only changes remain observable.
  createConnector: ({ bronId, listingFixturePath }) =>
    createJsonLdConnector({
      bronId,
      client: listingFixturePath
        ? createJsonLdClient({
            config: nsConfig,
            listingFixturePath,
            liveEnabled: false,
          })
        : undefined,
      config: nsConfig,
    }),
  listingHashCoversDetail: false,
  liveEnv: "NS_LIVE",
  naam: "NS",
  normalise: normaliseJsonLdObservation,
  seed: {
    crawlDelayMs: 2000,
    methode: "json-ld",
    voorwaardenStatus: "te_toetsen",
  },
  slug: "ns",
} satisfies SourceDefinition<"ns">;
