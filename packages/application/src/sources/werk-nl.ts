import {
  createWerkNlClient,
  createWerkNlConnector,
} from "@ji/connectors/werk-nl";

import { normaliseWerkNlObservation } from "../normalise/werk-nl";
import type { SourceDefinition } from "./definition";

export const werkNl = {
  bronId: "00000000-0000-4000-8000-000000000041",
  createConnector: ({ bronId, listingFixturePath }) =>
    createWerkNlConnector({
      bronId,
      client: listingFixturePath
        ? createWerkNlClient({ listingFixturePath, liveEnabled: false })
        : undefined,
    }),
  // The listing hash covers only the 16 whitelisted search-item fields; the
  // detail response carries beschrijving, tarief, sluitingsdatum,
  // contactPerson, proposition and employer — none visible to the listing
  // hash. Field-by-field evidence lives in docs/sources/werk-nl.md.
  listingHashCoversDetail: false,
  liveEnv: "WERK_NL_LIVE",
  naam: "Werk.nl",
  normalise: normaliseWerkNlObservation,
  seed: {
    // ~240k vacatures behind a 20/page API: a full sweep is ~12k requests,
    // so the delay errs on the polite side.
    crawlDelayMs: 1000,
    methode: "json-api",
    // UWV AGV art. 13 forbids automated collection and art. 9 reuse without
    // written consent; the browser PoC proved technical reachability only.
    voorwaardenStatus: "te_toetsen",
  },
  slug: "werk-nl",
} satisfies SourceDefinition<"werk-nl">;
