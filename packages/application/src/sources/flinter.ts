import {
  createFlinterClient,
  createFlinterConnector,
} from "@ji/connectors/flinter";

import { normaliseFlinterObservation } from "../normalise/flinter";
import type { SourceDefinition } from "./definition";

export const flinter = {
  bronId: "00000000-0000-4000-8000-00000000000a",
  // RJC-357/RJC-401: knownHashes deliberately NOT forwarded -- a skip here
  // would freeze detail-only changes; see listingHashCoversDetail below.
  createConnector: ({ bronId, listingFixturePath }) =>
    createFlinterConnector({
      bronId,
      client: listingFixturePath
        ? createFlinterClient({ listingFixturePath, liveEnabled: false })
        : undefined,
    }),
  // RJC-357/RJC-401: the detail page carries titel/beschrijving/tarief/closing the listing hash cannot see.
  listingHashCoversDetail: false,
  liveEnv: "FLINTER_LIVE",
  naam: "Flinter",
  normalise: normaliseFlinterObservation,
  seed: {
    // Low volume, no pagination, no XHR (docs/sources/flinter.md) -- poll
    // far less often than the JSON/XHR sources.
    crawlDelayMs: 3000,
    methode: "html",
    // The site publishes ~20 items and the connector rejects
    // permanent-employment/malformed items, so 19 persisted observations is
    // a full catalog (see docs/sources/flinter.md).
    minimumTestImportObservations: 10,
    // Operatorbesluit 2026-09-03 (live testimport productie); bewijs in
    // docs/sources/flinter.md "Voorwaarden" + robots-probe scripts/probe-source-voorwaarden.ts.
    voorwaardenStatus: "toegestaan",
  },
  slug: "flinter",
} satisfies SourceDefinition<"flinter">;
