import {
  createOnefellowClient,
  createOnefellowConnector,
} from "@ji/connectors/onefellow";

import { normaliseOnefellowObservation } from "../normalise/onefellow";
import type { SourceDefinition } from "./definition";

export const onefellow = {
  bronId: "00000000-0000-4000-8000-000000000009",
  createConnector: ({ bronId, knownHashes, listingFixturePath }) =>
    createOnefellowConnector({
      bronId,
      client: listingFixturePath
        ? createOnefellowClient({ listingFixturePath, liveEnabled: false })
        : undefined,
      knownHashes,
    }),
  // RJC-357/RJC-401: listing hash covers every OnefellowJob field the normaliser reads (fetch re-serialises the listing job; time_published/time_updated are deliberately untracked) -- see docs/sources/onefellow.md.
  listingHashCoversDetail: true,
  liveEnv: "ONEFELLOW_LIVE",
  naam: "Onefellow",
  normalise: normaliseOnefellowObservation,
  seed: {
    crawlDelayMs: 1500,
    methode: "json-api",
    // Operatorbesluit 2026-09-03 (live testimport productie); bewijs in
    // docs/sources/onefellow.md "Voorwaarden" + robots-probe scripts/probe-source-voorwaarden.ts.
    voorwaardenStatus: "toegestaan",
  },
  slug: "onefellow",
} satisfies SourceDefinition<"onefellow">;
