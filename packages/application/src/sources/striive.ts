import {
  createStriiveClient,
  createStriiveConnector,
} from "@ji/connectors/striive";

import { normaliseStriiveObservation } from "../normalise/striive";
import type { SourceDefinition } from "./definition";

export const striive = {
  bronId: "00000000-0000-4000-8000-000000000008",
  createConnector: ({ bronId, knownHashes, listingFixturePath }) =>
    createStriiveConnector({
      bronId,
      client: listingFixturePath
        ? createStriiveClient({ listingFixturePath, liveEnabled: false })
        : undefined,
      knownHashes,
    }),
  // RJC-357/RJC-401: listing hash covers every projected StriiveJob field (fetch re-serialises the DEC-008 projection; no detail request) -- see docs/sources/striive.md.
  listingHashCoversDetail: true,
  liveEnv: "STRIIVE_LIVE",
  naam: "Striive",
  normalise: normaliseStriiveObservation,
  seed: {
    crawlDelayMs: 1500,
    methode: "json-api",
    // Operatorbesluit 2026-09-03 (live testimport productie); bewijs in
    // docs/sources/striive.md "Voorwaarden" + robots-probe scripts/probe-source-voorwaarden.ts.
    voorwaardenStatus: "toegestaan",
  },
  slug: "striive",
} satisfies SourceDefinition<"striive">;
