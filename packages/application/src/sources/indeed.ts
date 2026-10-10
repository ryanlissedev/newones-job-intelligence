import {
  createIndeedClient,
  createIndeedConnector,
} from "@ji/connectors/indeed";

import { normaliseIndeedObservation } from "../normalise/indeed";
import type { SourceDefinition } from "./definition";

export const indeed = {
  bronId: "00000000-0000-4000-8000-000000000044",
  createConnector: ({ bronId, listingFixturePath }) =>
    createIndeedConnector({
      bronId,
      client: listingFixturePath
        ? createIndeedClient({
            listingFixturePath,
            liveEnabled: false,
          })
        : undefined,
    }),
  // The card hash cannot see detail-only fields (sanitizedJobDescription,
  // salaryInfoModel, jobOccupations), so the fetch always re-reads the
  // embedded viewjob body and knownHashes is never consulted — same rule as
  // werk-nl (RJC-357/RJC-401). See docs/sources/indeed.md.
  listingHashCoversDetail: false,
  liveEnv: "INDEED_LIVE",
  naam: "Indeed",
  normalise: normaliseIndeedObservation,
  seed: {
    // Anonymous sessions degrade to turnstile within a few navigations even
    // in a real browser (PoC + capture, 2026-09-18) — conservative delay.
    crawlDelayMs: 3000,
    methode: "html_parser",
    voorwaardenStatus: "te_toetsen",
  },
  slug: "indeed",
} satisfies SourceDefinition<"indeed">;
