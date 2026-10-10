import {
  createJsonLdClient,
  createJsonLdConnector,
  proActConfig,
} from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "../normalise/json-ld";
import type { SourceDefinition } from "./definition";

export const proAct = {
  bronId: "00000000-0000-4000-8000-000000000005",
  // RJC-357/RJC-401: knownHashes deliberately NOT forwarded -- a skip here
  // would freeze detail-only changes; see listingHashCoversDetail below.
  createConnector: ({ bronId, listingFixturePath }) =>
    createJsonLdConnector({
      bronId,
      client: listingFixturePath
        ? createJsonLdClient({
            config: proActConfig,
            listingFixturePath,
            liveEnabled: false,
          })
        : undefined,
      config: proActConfig,
    }),
  // RJC-357/RJC-401: the JobPosting (incl. closing) lives on the detail page; the sitemap hash sees only url+lastmod (RJC-401).
  listingHashCoversDetail: false,
  liveEnv: "PROACT_LIVE",
  naam: "Pro-Act IT",
  normalise: normaliseJsonLdObservation,
  seed: {
    crawlDelayMs: 10_000,
    methode: "json-ld",
    // Operatorbesluit 2026-09-03 (live testimport productie); bewijs in
    // docs/sources/pro-act.md "Voorwaarden" + robots-probe scripts/probe-source-voorwaarden.ts.
    voorwaardenStatus: "toegestaan",
  },
  slug: "pro-act",
} satisfies SourceDefinition<"pro-act">;
