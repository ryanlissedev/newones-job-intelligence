import {
  createJsonLdClient,
  createJsonLdConnector,
  heijmansConfig,
} from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "../normalise/json-ld";
import type { SourceDefinition } from "./definition";

export const heijmans = {
  bronId: "00000000-0000-4000-8000-000000000016",
  // Sitemap metadata covers only the URL, not detail-page JobPosting fields.
  createConnector: ({ bronId, listingFixturePath }) =>
    createJsonLdConnector({
      bronId,
      client: listingFixturePath
        ? createJsonLdClient({
            config: heijmansConfig,
            listingFixturePath,
            liveEnabled: false,
          })
        : undefined,
      config: heijmansConfig,
    }),
  listingHashCoversDetail: false,
  liveEnv: "HEIJMANS_LIVE",
  naam: "Heijmans",
  normalise: normaliseJsonLdObservation,
  seed: {
    crawlDelayMs: 2000,
    methode: "json-ld",
    voorwaardenStatus: "te_toetsen",
  },
  slug: "heijmans",
} satisfies SourceDefinition<"heijmans">;
