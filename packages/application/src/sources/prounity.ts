import {
  createProunityClient,
  createProunityConnector,
} from "@ji/connectors/prounity";

import { normaliseProunityObservation } from "../normalise/prounity";
import type { SourceDefinition } from "./definition";

export const prounity = {
  bronId: "00000000-0000-4000-8000-000000000040",
  // RJC-357/RJC-401: knownHashes deliberately NOT forwarded -- the sitemap row
  // (url + lastmod) cannot see detail-page changes; see listingHashCoversDetail.
  createConnector: ({ bronId, listingFixturePath }) =>
    createProunityConnector({
      bronId,
      client: listingFixturePath
        ? createProunityClient({ listingFixturePath, liveEnabled: false })
        : undefined,
    }),
  // RJC-357/RJC-401: titel/periode/requirements/description live on the detail
  // page; the sitemap hash sees only url + lastmod.
  listingHashCoversDetail: false,
  liveEnv: "PROUNITY_LIVE",
  naam: "ProUnity",
  normalise: normaliseProunityObservation,
  // ~1,000 sitemap detail URLs (audit 8 Oct 2026) × the 10 s robots.txt
  // crawl delay is ~167 minutes of pacing alone, so the 1 hour poller default
  // aborted every run before it reached the end of the sitemap. 3.5 h is the
  // pacing plus ~25 % for fetch latency and catalog growth.
  runBudgetMs: 3.5 * 60 * 60 * 1000,
  seed: {
    // robots.txt: `Crawl-delay: 10` (verified live 2026-09-18).
    crawlDelayMs: 10_000,
    methode: "html",
    // ToS has an IP/database clause ("copy, analyze … content encumbered with
    // Intellectual Property Rights", incl. database rights) — GO on BE scope
    // was given by the product owner; stays te_toetsen until the clause is
    // cleared. See docs/sources/prounity.md.
    voorwaardenStatus: "te_toetsen",
  },
  slug: "prounity",
} satisfies SourceDefinition<"prounity">;
