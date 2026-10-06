import {
  createJsonLdClient,
  createJsonLdConnector,
  randstadConfig,
} from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "../normalise/json-ld";
import type { SourceDefinition } from "./definition";

export const randstad = {
  bronId: "00000000-0000-4000-8000-000000000019",
  createConnector: ({ bronId, listingFixturePath }) =>
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
