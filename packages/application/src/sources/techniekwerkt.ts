import {
  createJsonLdClient,
  createJsonLdConnector,
  techniekwerktConfig,
} from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "../normalise/json-ld";
import type { SourceDefinition } from "./definition";

export const techniekwerkt = {
  bronId: "00000000-0000-4000-8000-000000000039",
  // Sitemap metadata covers only the URL, not detail-page fields.
  // Do not pass known hashes, so detail-only changes remain observable.
  createConnector: ({ bronId, listingFixturePath }) =>
    createJsonLdConnector({
      bronId,
      client: listingFixturePath
        ? createJsonLdClient({
            config: techniekwerktConfig,
            listingFixturePath,
            liveEnabled: false,
          })
        : undefined,
      config: techniekwerktConfig,
    }),
  listingHashCoversDetail: false,
  liveEnv: "TECHNIEKWERKT_LIVE",
  naam: "Techniekwerkt",
  normalise: normaliseJsonLdObservation,
  // ~8,500 sitemap detail URLs (8,526 on 6 Oct 2026) × 2 s crawl delay is
  // ~4.7 hours, so the 1 hour poller default aborted every run.
  runBudgetMs: 5.5 * 60 * 60 * 1000,
  seed: {
    crawlDelayMs: 2000,
    methode: "json-ld",
    voorwaardenStatus: "te_toetsen",
  },
  slug: "techniekwerkt",
} satisfies SourceDefinition<"techniekwerkt">;
