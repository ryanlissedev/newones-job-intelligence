import {
  createJsonLdClient,
  createJsonLdConnector,
  rabobankConfig,
} from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "../normalise/json-ld";
import type { SourceDefinition } from "./definition";

export const rabobank = {
  bronId: "00000000-0000-4000-8000-000000000010",
  // The sitemap exposes URL/lastmod only; JobPosting fields live on the detail
  // page, so known hashes must not skip detail-only changes.
  createConnector: ({ bronId, listingFixturePath }) =>
    createJsonLdConnector({
      bronId,
      client: listingFixturePath
        ? createJsonLdClient({
            config: rabobankConfig,
            listingFixturePath,
            liveEnabled: false,
          })
        : undefined,
      config: rabobankConfig,
    }),
  listingHashCoversDetail: false,
  liveEnv: "RABOBANK_LIVE",
  naam: "Rabobank",
  normalise: normaliseJsonLdObservation,
  seed: {
    crawlDelayMs: 2000,
    methode: "json-ld",
    voorwaardenStatus: "te_toetsen",
  },
  slug: "rabobank",
} satisfies SourceDefinition<"rabobank">;
