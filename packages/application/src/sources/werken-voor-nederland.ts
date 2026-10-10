import {
  createJsonLdClient,
  createJsonLdConnector,
  werkenVoorNederlandConfig,
} from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "../normalise/json-ld";
import type { SourceDefinition } from "./definition";

export const werkenVoorNederland = {
  bronId: "00000000-0000-4000-8000-00000000000e",
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
            config: werkenVoorNederlandConfig,
            listingFixturePath,
            liveEnabled: false,
          })
        : undefined,
      config: werkenVoorNederlandConfig,
      lastmodSkip: knownHashes ? { knownHashes } : undefined,
    }),
  // RJC-357/RJC-401: the JobPosting lives on the detail page; the sitemap hash
  // sees only url and lastmod, not the detail fields.
  listingHashCoversDetail: false,
  liveEnv: "WERKEN_VOOR_NEDERLAND_LIVE",
  naam: "Werken voor Nederland",
  normalise: normaliseJsonLdObservation,
  seed: {
    crawlDelayMs: 2000,
    methode: "json-ld",
    voorwaardenStatus: "te_toetsen",
  },
  slug: "werken-voor-nederland",
} satisfies SourceDefinition<"werken-voor-nederland">;
