import {
  createJsonLdClient,
  createJsonLdConnector,
  haertConfig,
} from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "../normalise/json-ld";
import type { SourceDefinition } from "./definition";

export const haert = {
  bronId: "00000000-0000-4000-8000-00000000003f",
  // Sitemap metadata covers only the URL (+lastmod), not detail-page JobPosting fields.
  createConnector: ({ bronId, listingFixturePath }) =>
    createJsonLdConnector({
      bronId,
      client: listingFixturePath
        ? createJsonLdClient({
            config: haertConfig,
            listingFixturePath,
            liveEnabled: false,
          })
        : undefined,
      config: haertConfig,
    }),
  listingHashCoversDetail: false,
  liveEnv: "HAERT_LIVE",
  naam: "Haert",
  normalise: normaliseJsonLdObservation,
  seed: {
    crawlDelayMs: 2000,
    methode: "json-ld",
    voorwaardenStatus: "te_toetsen",
  },
  slug: "haert",
} satisfies SourceDefinition<"haert">;
