import {
  createJsonLdClient,
  createJsonLdConnector,
  gasunieConfig,
} from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "../normalise/json-ld";
import type { SourceDefinition } from "./definition";

export const gasunie = {
  bronId: "00000000-0000-4000-8000-000000000036",
  // Sitemap metadata covers only the URL, not detail-page JobPosting fields.
  createConnector: ({ bronId, listingFixturePath }) =>
    createJsonLdConnector({
      bronId,
      client: listingFixturePath
        ? createJsonLdClient({
            config: gasunieConfig,
            listingFixturePath,
            liveEnabled: false,
          })
        : undefined,
      config: gasunieConfig,
    }),
  listingHashCoversDetail: false,
  liveEnv: "GASUNIE_LIVE",
  naam: "Gasunie",
  normalise: normaliseJsonLdObservation,
  seed: {
    crawlDelayMs: 2000,
    methode: "json-ld",
    voorwaardenStatus: "te_toetsen",
  },
  slug: "gasunie",
} satisfies SourceDefinition<"gasunie">;
