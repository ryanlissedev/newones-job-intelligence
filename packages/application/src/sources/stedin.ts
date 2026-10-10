import {
  createJsonLdClient,
  createJsonLdConnector,
  stedinConfig,
} from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "../normalise/json-ld";
import type { SourceDefinition } from "./definition";

export const stedin = {
  bronId: "00000000-0000-4000-8000-000000000035",
  // Sitemap metadata covers only the URL, not detail-page JobPosting fields.
  createConnector: ({ bronId, listingFixturePath }) =>
    createJsonLdConnector({
      bronId,
      client: listingFixturePath
        ? createJsonLdClient({
            config: stedinConfig,
            listingFixturePath,
            liveEnabled: false,
          })
        : undefined,
      config: stedinConfig,
    }),
  listingHashCoversDetail: false,
  liveEnv: "STEDIN_LIVE",
  naam: "Stedin",
  normalise: normaliseJsonLdObservation,
  seed: {
    crawlDelayMs: 2000,
    methode: "json-ld",
    voorwaardenStatus: "te_toetsen",
  },
  slug: "stedin",
} satisfies SourceDefinition<"stedin">;
