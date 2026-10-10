import {
  createHarveyNashClient,
  createHarveyNashConnector,
} from "@ji/connectors/harveynash";

import { normaliseHarveyNashObservation } from "../normalise/harveynash";
import type { SourceDefinition } from "./definition";

export const harveynash = {
  bronId: "00000000-0000-4000-8000-000000000007",
  // RJC-357/RJC-401: knownHashes deliberately NOT forwarded -- a skip here
  // would freeze detail-only changes; see listingHashCoversDetail below.
  createConnector: ({ bronId, listingFixturePath }) =>
    createHarveyNashConnector({
      bronId,
      client: listingFixturePath
        ? createHarveyNashClient({ listingFixturePath, liveEnabled: false })
        : undefined,
    }),
  // RJC-357/RJC-401: the detail page carries the facts block incl. the closing field the listing hash cannot see (RJC-401).
  listingHashCoversDetail: false,
  liveEnv: "HARVEYNASH_LIVE",
  naam: "Harvey Nash",
  normalise: normaliseHarveyNashObservation,
  seed: {
    crawlDelayMs: 1500,
    methode: "json-api",
    // Operatorbesluit 2026-09-03 (live testimport productie); bewijs in
    // docs/sources/harveynash.md "Voorwaarden" + robots-probe scripts/probe-source-voorwaarden.ts.
    voorwaardenStatus: "toegestaan",
  },
  slug: "harveynash",
} satisfies SourceDefinition<"harveynash">;
