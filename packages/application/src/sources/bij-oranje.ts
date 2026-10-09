import {
  bijOranjeConfig,
  createJsonLdClient,
  createJsonLdConnector,
} from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "../normalise/json-ld";
import type { SourceDefinition } from "./definition";

export const bijOranje = {
  bronId: "00000000-0000-4000-8000-00000000000c",
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
            config: bijOranjeConfig,
            listingFixturePath,
            liveEnabled: false,
          })
        : undefined,
      config: bijOranjeConfig,
      lastmodSkip: knownHashes ? { knownHashes } : undefined,
    }),
  // RJC-357/RJC-401: the JobPosting lives on the detail page; the sitemap hash
  // sees only url (and no reliable detail fields).
  listingHashCoversDetail: false,
  liveEnv: "BIJORANJE_LIVE",
  naam: "Bij Oranje",
  normalise: normaliseJsonLdObservation,
  seed: {
    crawlDelayMs: 2000,
    methode: "json-ld",
    voorwaardenStatus: "te_toetsen",
  },
  slug: "bij-oranje",
} satisfies SourceDefinition<"bij-oranje">;
