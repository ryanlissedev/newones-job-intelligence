import {
  createJsonLdClient,
  createJsonLdConnector,
  essentConfig,
} from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "../normalise/json-ld";
import type { SourceDefinition } from "./definition";

export const essent = {
  bronId: "00000000-0000-4000-8000-00000000003b",
  // Sitemap metadata covers only the URL, not detail-page fields.
  // Do not pass known hashes, so detail-only changes remain observable.
  createConnector: ({ bronId, listingFixturePath }) =>
    createJsonLdConnector({
      bronId,
      client: listingFixturePath
        ? createJsonLdClient({
            config: essentConfig,
            listingFixturePath,
            liveEnabled: false,
          })
        : undefined,
      config: essentConfig,
    }),
  listingHashCoversDetail: false,
  liveEnv: "ESSENT_LIVE",
  naam: "Essent",
  normalise: normaliseJsonLdObservation,
  seed: {
    crawlDelayMs: 2000,
    methode: "json-ld",
    voorwaardenStatus: "te_toetsen",
  },
  slug: "essent",
} satisfies SourceDefinition<"essent">;
