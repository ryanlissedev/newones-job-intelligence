import {
  createJsonLdClient,
  createJsonLdConnector,
  tenmonksConfig,
} from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "../normalise/json-ld";
import type { SourceDefinition } from "./definition";

export const tenmonks = {
  bronId: "00000000-0000-4000-8000-00000000000d",
  // RJC-357/RJC-401: knownHashes deliberately NOT forwarded -- a skip here
  // would freeze detail-only changes; see listingHashCoversDetail below.
  createConnector: ({ bronId, listingFixturePath }) =>
    createJsonLdConnector({
      bronId,
      client: listingFixturePath
        ? createJsonLdClient({
            config: tenmonksConfig,
            listingFixturePath,
            liveEnabled: false,
          })
        : undefined,
      config: tenmonksConfig,
    }),
  // RJC-357/RJC-401: the JobPosting lives on the detail page; the sitemap hash
  // sees only url (and no reliable detail fields).
  listingHashCoversDetail: false,
  liveEnv: "TENMONKS_LIVE",
  naam: "TenMonks",
  normalise: normaliseJsonLdObservation,
  seed: {
    crawlDelayMs: 2000,
    methode: "json-ld",
    voorwaardenStatus: "te_toetsen",
  },
  slug: "tenmonks",
} satisfies SourceDefinition<"tenmonks">;
