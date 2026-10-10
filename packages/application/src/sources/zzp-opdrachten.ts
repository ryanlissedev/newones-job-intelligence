import {
  createJsonLdClient,
  createJsonLdConnector,
  zzpOpdrachtenConfig,
} from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "../normalise/json-ld";
import type { SourceDefinition } from "./definition";

export const zzpOpdrachten = {
  bronId: "00000000-0000-4000-8000-000000000013",
  // RJC-357/RJC-401: knownHashes never reaches the fetch-time skip (a
  // listing-hash skip would freeze detail-only changes; see
  // listingHashCoversDetail). It only backs lastmodSkip: these sitemap rows
  // carry <lastmod> (measured 2026-10-08), so a page whose lastmod has not
  // moved since its last fetch is skipped; rows without lastmod always fetch.
  createConnector: ({ bronId, knownHashes, listingFixturePath }) =>
    createJsonLdConnector({
      bronId,
      client: listingFixturePath
        ? createJsonLdClient({
            config: zzpOpdrachtenConfig,
            listingFixturePath,
            liveEnabled: false,
          })
        : undefined,
      config: zzpOpdrachtenConfig,
      lastmodSkip: knownHashes ? { knownHashes } : undefined,
    }),
  listingHashCoversDetail: false,
  liveEnv: "ZZP_OPDRACHTEN_LIVE",
  naam: "ZZP-Opdrachten.nl",
  normalise: normaliseJsonLdObservation,
  seed: {
    crawlDelayMs: 2000,
    methode: "json-ld",
    voorwaardenStatus: "te_toetsen",
  },
  slug: "zzp-opdrachten",
} satisfies SourceDefinition<"zzp-opdrachten">;
