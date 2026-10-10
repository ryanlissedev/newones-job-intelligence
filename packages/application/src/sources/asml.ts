import {
  createJsonLdClient,
  createJsonLdConnector,
  asmlConfig,
} from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "../normalise/json-ld";
import type { SourceDefinition } from "./definition";

export const asml = {
  bronId: "00000000-0000-4000-8000-00000000000f",
  // RJC-357/RJC-401: knownHashes deliberately NOT forwarded because the
  // sitemap contains URLs/lastmod, while jobData lives on the detail page.
  createConnector: ({ bronId, listingFixturePath }) =>
    createJsonLdConnector({
      bronId,
      client: listingFixturePath
        ? createJsonLdClient({
            config: asmlConfig,
            listingFixturePath,
            liveEnabled: false,
          })
        : undefined,
      config: asmlConfig,
    }),
  listingHashCoversDetail: false,
  liveEnv: "ASML_LIVE",
  naam: "ASML",
  normalise: normaliseJsonLdObservation,
  seed: {
    crawlDelayMs: 2000,
    methode: "json-ld",
    voorwaardenStatus: "te_toetsen",
  },
  slug: "asml",
} satisfies SourceDefinition<"asml">;
