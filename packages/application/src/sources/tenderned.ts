import type { ConnectorRunKind } from "@ji/connectors";
import {
  buildTenderNedPollFilters,
  createTenderNedClient,
  createTenderNedConnector,
} from "@ji/connectors/tenderned";

import { normaliseTenderNedObservation } from "../normalise/tenderned";
import type { SourceDefinition } from "./definition";

export const resolveTenderNedTestImportDays = (): number => {
  const configuredDays =
    process.env.TENDER_NED_TEST_IMPORT_DAYS?.trim() || "14";
  const days = Number(configuredDays);
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    throw new Error(
      `TENDER_NED_TEST_IMPORT_DAYS must be an integer in the range 1-90; received "${configuredDays}"`
    );
  }
  return days;
};

const resolveFilters = (
  live: boolean,
  runKind: ConnectorRunKind
): ReturnType<typeof buildTenderNedPollFilters> | undefined => {
  if (!live) {
    return;
  }
  if (runKind === "poll") {
    return buildTenderNedPollFilters();
  }
  return buildTenderNedPollFilters(
    undefined,
    undefined,
    resolveTenderNedTestImportDays()
  );
};

export const tenderned = {
  bronId: "00000000-0000-4000-8000-000000000001",
  // RJC-357/RJC-401: knownHashes deliberately NOT forwarded -- a skip here
  // would freeze detail-only changes; see listingHashCoversDetail below.
  createConnector: ({ bronId, listingFixturePath, live, runKind }) =>
    createTenderNedConnector({
      bronId,
      client: listingFixturePath
        ? createTenderNedClient({ listingFixturePath, liveEnabled: false })
        : undefined,
      filters: resolveFilters(live, runKind),
    }),
  // RJC-357/RJC-401: the detail response carries opdrachtBeschrijving,
  // cpvCodes, nutsCodes, opdrachtAardCode, procedureCode and
  // opdrachtgeverNaam -- all persisted, none visible to the listing hash.
  listingHashCoversDetail: false,
  liveEnv: "TENDER_NED_LIVE",
  naam: "TenderNed",
  normalise: normaliseTenderNedObservation,
  seed: {
    crawlDelayMs: 500,
    methode: "json-api",
    voorwaardenStatus: "toegestaan",
  },
  slug: "tenderned",
} satisfies SourceDefinition<"tenderned">;
