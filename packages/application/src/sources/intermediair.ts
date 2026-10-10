import {
  createJsonLdClient,
  createJsonLdConnector,
  intermediairConfig,
} from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "../normalise/json-ld";
import type { SourceDefinition } from "./definition";

export const intermediair = {
  bronId: "00000000-0000-4000-8000-000000000037",
  // Sitemap metadata covers only the URL, not detail-page JobPosting fields.
  createConnector: ({ bronId, listingFixturePath }) =>
    createJsonLdConnector({
      bronId,
      client: listingFixturePath
        ? createJsonLdClient({
            config: intermediairConfig,
            listingFixturePath,
            liveEnabled: false,
          })
        : undefined,
      config: intermediairConfig,
    }),
  listingHashCoversDetail: false,
  liveEnv: "INTERMEDIAIR_LIVE",
  naam: "Intermediair",
  normalise: normaliseJsonLdObservation,
  // ~2,800 child-sitemap detail URLs (2,828 on 8 Oct 2026) × 2 s crawl delay
  // is ~94 minutes of pacing alone, so the 1 hour poller default aborted every
  // run. 2.5 h is the pacing plus ~60 % for fetch latency and catalog growth.
  runBudgetMs: 2.5 * 60 * 60 * 1000,
  seed: {
    crawlDelayMs: 2000,
    methode: "json-ld",
    voorwaardenStatus: "te_toetsen",
  },
  slug: "intermediair",
} satisfies SourceDefinition<"intermediair">;
