import {
  createOpdrachtoverheidClient,
  createOpdrachtoverheidConnector,
} from "@ji/connectors/opdrachtoverheid";

import { normaliseOpdrachtoverheidObservation } from "../normalise/opdrachtoverheid";
import type { SourceDefinition } from "./definition";

export const opdrachtoverheid = {
  // Distinct hex-suffix UUID (not the decimal ..001/..002 sequence used by
  // tenderned/inhuurdesk) to avoid collisions with sibling Slice C source
  // branches picking the same next-in-sequence id.
  bronId: "00000000-0000-4000-8000-0000000000ad",
  // RJC-357/RJC-401: knownHashes deliberately NOT forwarded -- a skip here
  // would freeze detail-only changes; see listingHashCoversDetail below.
  createConnector: ({ bronId, listingFixturePath }) =>
    createOpdrachtoverheidConnector({
      bronId,
      client: listingFixturePath
        ? createOpdrachtoverheidClient({
            listingFixturePath,
            liveEnabled: false,
          })
        : undefined,
    }),
  // RJC-357/RJC-401: the JSON-LD detail enrichment can change while the listing row is unchanged.
  listingHashCoversDetail: false,
  liveEnv: "OPDRACHTOVERHEID_LIVE",
  naam: "Opdrachtoverheid",
  normalise: normaliseOpdrachtoverheidObservation,
  seed: {
    crawlDelayMs: 1000,
    methode: "json-api",
    // Operatorbesluit 2026-09-03 (live testimport productie); bewijs in
    // docs/sources/opdrachtoverheid.md "Voorwaarden" + robots-probe scripts/probe-source-voorwaarden.ts.
    voorwaardenStatus: "toegestaan",
  },
  slug: "opdrachtoverheid",
} satisfies SourceDefinition<"opdrachtoverheid">;
