import {
  createJsonLdClient,
  createJsonLdConnector,
  randstadConfig,
} from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "../normalise/json-ld";
import type { SourceDefinition } from "./definition";

export const randstad = {
  bronId: "00000000-0000-4000-8000-000000000019",
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
            config: randstadConfig,
            listingFixturePath,
            liveEnabled: false,
          })
        : undefined,
      config: randstadConfig,
      lastmodSkip: knownHashes ? { knownHashes } : undefined,
    }),
  listingHashCoversDetail: false,
  liveEnv: "RANDSTAD_LIVE",
  naam: "Randstad",
  normalise: normaliseJsonLdObservation,
  // ~3,000 sitemap detail URLs (2,988 on 6 Oct 2026) × 2 s crawl delay is
  // ~100 minutes, so the 1 hour poller default aborted every run.
  runBudgetMs: 3 * 60 * 60 * 1000,
  seed: {
    crawlDelayMs: 2000,
    methode: "json-ld",
    voorwaardenStatus: "te_toetsen",
  },
  slug: "randstad",
} satisfies SourceDefinition<"randstad">;
