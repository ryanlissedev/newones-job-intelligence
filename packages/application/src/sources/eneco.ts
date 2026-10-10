import {
  createJsonLdClient,
  createJsonLdConnector,
  enecoConfig,
} from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "../normalise/json-ld";
import type { SourceDefinition } from "./definition";

export const eneco = {
  bronId: "00000000-0000-4000-8000-00000000001e",
  // Sitemap metadata covers only the URL, not detail-page JobPosting fields.
  // Do not pass known hashes, so detail-only changes remain observable.
  createConnector: ({ bronId, listingFixturePath }) =>
    createJsonLdConnector({
      bronId,
      client: listingFixturePath
        ? createJsonLdClient({
            config: enecoConfig,
            listingFixturePath,
            liveEnabled: false,
          })
        : undefined,
      config: enecoConfig,
    }),
  listingHashCoversDetail: false,
  liveEnv: "ENECO_LIVE",
  naam: "Eneco",
  normalise: normaliseJsonLdObservation,
  seed: {
    crawlDelayMs: 2000,
    methode: "json-ld",
    voorwaardenStatus: "te_toetsen",
  },
  slug: "eneco",
} satisfies SourceDefinition<"eneco">;
