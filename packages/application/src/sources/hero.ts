import {
  createJsonLdClient,
  createJsonLdConnector,
  heroConfig,
} from "@ji/connectors/json-ld";

import { normaliseJsonLdObservation } from "../normalise/json-ld";
import type { SourceDefinition } from "./definition";

export const hero = {
  bronId: "00000000-0000-4000-8000-000000000004",
  // RJC-357/RJC-401: knownHashes deliberately NOT forwarded -- a skip here
  // would freeze detail-only changes; see listingHashCoversDetail below.
  createConnector: ({ bronId, listingFixturePath }) =>
    createJsonLdConnector({
      bronId,
      client: listingFixturePath
        ? createJsonLdClient({
            config: heroConfig,
            listingFixturePath,
            liveEnabled: false,
          })
        : undefined,
      config: heroConfig,
    }),
  // RJC-357/RJC-401: the JobPosting (incl. closing) lives on the detail page; the sitemap hash sees only url+lastmod (RJC-401).
  listingHashCoversDetail: false,
  liveEnv: "HERO_LIVE",
  naam: "Hero.eu",
  normalise: normaliseJsonLdObservation,
  seed: {
    crawlDelayMs: 2000,
    methode: "json-ld",
    // Operatorbesluit 2026-09-03 (live testimport productie); bewijs in
    // docs/sources/hero.md "Voorwaarden" + robots-probe scripts/probe-source-voorwaarden.ts.
    voorwaardenStatus: "toegestaan",
  },
  slug: "hero",
} satisfies SourceDefinition<"hero">;
