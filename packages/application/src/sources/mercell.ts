import type { ConnectorRunKind } from "@ji/connectors";
import {
  createMercellClient,
  createMercellConnector,
} from "@ji/connectors/mercell";

import { normaliseMercellObservation } from "../normalise/mercell";
import type { SourceDefinition } from "./definition";

const MILLISECONDS_PER_DAY = 86_400_000;

/** Poll runs walk the CreatedDate-desc listing only this far back; the
 * connector flags the run `truncated` at the window edge so unwalked rows are
 * never counted as missed. One day mirrors TenderNed's daily poll window. */
const MERCELL_POLL_WINDOW_DAYS = 1;

const resolvePollWindow = (
  live: boolean,
  runKind: ConnectorRunKind
): Date | undefined => {
  if (!live || runKind !== "poll") {
    return;
  }
  return new Date(Date.now() - MERCELL_POLL_WINDOW_DAYS * MILLISECONDS_PER_DAY);
};

export const mercell = {
  bronId: "00000000-0000-4000-8000-000000000045",
  // RJC-357/RJC-401: knownHashes deliberately NOT forwarded -- the detail
  // response carries EstimatedValue*, contact person and participation status
  // the listing hash cannot see, so a skip would freeze detail-only changes.
  createConnector: ({ bronId, listingFixturePath, live, runKind }) =>
    createMercellConnector({
      bronId,
      client: listingFixturePath
        ? createMercellClient({ listingFixturePath, liveEnabled: false })
        : undefined,
      publishedSince: resolvePollWindow(live, runKind),
    }),
  // Detail-only fields (EstimatedValue*, TypeOfContract, contact person,
  // ExplicitTenderStatus) change without the listing hash moving.
  listingHashCoversDetail: false,
  liveEnv: "MERCELL_LIVE",
  naam: "Mercell",
  normalise: normaliseMercellObservation,
  seed: {
    crawlDelayMs: 1000,
    methode: "json-api",
    // s2c.mercell.com robots.txt is `Disallow: /` for the whole site while the
    // JSON API is technically open; the owner waived ToS for the POC only
    // (CTP-570) — a policy decision for Robbie is still open, so the seed is
    // `te_toetsen` again. Decision recorded in docs/sources/mercell.md.
    voorwaardenStatus: "te_toetsen",
  },
  slug: "mercell",
} satisfies SourceDefinition<"mercell">;
