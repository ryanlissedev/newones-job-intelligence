import {
  createNeedstaffingClient,
  createNeedstaffingConnector,
} from "@ji/connectors/needstaffing";

import { normaliseNeedstaffingObservation } from "../normalise/needstaffing";
import type { SourceDefinition } from "./definition";

export const needstaffing = {
  bronId: "00000000-0000-4000-8000-000000000003",
  // RJC-357/RJC-401: knownHashes deliberately NOT forwarded -- a skip here
  // would freeze detail-only changes; see listingHashCoversDetail below.
  createConnector: ({ bronId, listingFixturePath }) =>
    createNeedstaffingConnector({
      bronId,
      client: listingFixturePath
        ? createNeedstaffingClient({ listingFixturePath, liveEnabled: false })
        : undefined,
    }),
  // RJC-357/RJC-401: the detail page carries titel/beschrijving/tarief the listing hash cannot see.
  listingHashCoversDetail: false,
  liveEnv: "NEEDSTAFFING_LIVE",
  naam: "Need Staffing IT",
  normalise: normaliseNeedstaffingObservation,
  seed: {
    crawlDelayMs: 2000,
    methode: "html",
    // Operatorbesluit 2026-09-03 (live testimport productie); bewijs in
    // docs/sources/needstaffing.md "Voorwaarden" + robots-probe scripts/probe-source-voorwaarden.ts.
    voorwaardenStatus: "toegestaan",
  },
  slug: "needstaffing",
} satisfies SourceDefinition<"needstaffing">;
