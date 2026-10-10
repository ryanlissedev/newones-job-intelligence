import {
  createJsonLdClient,
  createJsonLdConnector,
  enexisConfig,
} from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "../normalise/json-ld";
import type { SourceDefinition } from "./definition";

export const enexis = {
  bronId: "00000000-0000-4000-8000-000000000034",
  // Sitemap metadata covers only the URL, not detail-page JobPosting fields.
  // Do not pass known hashes, so detail-only changes remain observable.
  createConnector: ({ bronId, listingFixturePath }) =>
    createJsonLdConnector({
      bronId,
      client: listingFixturePath
        ? createJsonLdClient({
            config: enexisConfig,
            listingFixturePath,
            liveEnabled: false,
          })
        : undefined,
      config: enexisConfig,
    }),
  listingHashCoversDetail: false,
  liveEnv: "ENEXIS_LIVE",
  naam: "Enexis",
  normalise: normaliseJsonLdObservation,
  seed: {
    crawlDelayMs: 2000,
    methode: "json-ld",
    voorwaardenStatus: "te_toetsen",
  },
  slug: "enexis",
} satisfies SourceDefinition<"enexis">;
