import type { BronId } from "@ji/domain";

import type {
  Connector,
  ConnectorCheckpoint,
  ConnectorDiscoverResult,
  DiscoverItem,
} from "../contract";
import { shouldSkipFetch } from "../known-hash";
import type { KnownHashStore } from "../known-hash";
import { createTenderNedClient } from "./client";
import type { TenderNedClient } from "./client";
import { hashTenderNedDetailPayload, hashTenderNedListingItem } from "./hash";
import { asIdString } from "./ids";
import type { TenderNedFetchedPayload, TenderNedFilters } from "./types";

export interface TenderNedConnectorOptions {
  bronId: BronId;
  client?: TenderNedClient;
  filters?: TenderNedFilters;
  knownHashes?: KnownHashStore;
}

export const createTenderNedConnector = (
  options: TenderNedConnectorOptions
): Connector => {
  const client = options.client ?? createTenderNedClient();
  const filters = options.filters ?? {
    cpvCodes: ["72000000-5"],
    publicatieDatumVanaf: "2026-08-27",
    typeOpdracht: "D",
  };
  const { knownHashes } = options;

  return {
    bronId: options.bronId,
    discover: async (
      checkpoint: ConnectorCheckpoint | null
    ): Promise<ConnectorDiscoverResult> => {
      const page = checkpoint?.page ?? 0;
      const listing = await client.fetchListing(page, filters);
      const items: DiscoverItem[] = await Promise.all(
        listing.content.map(async (item) => ({
          bronReferentie: asIdString(item.kenmerk),
          contentHash: await hashTenderNedListingItem(item),
          listingPayload: item,
        }))
      );
      return {
        checkpoint: { page: page + 1 },
        hasMore: !listing.last,
        items,
      };
    },
    fetch: async (item) => {
      // SAFETY: discover() attaches TenderNed listing rows as listingPayload.
      const listingPayload = item.listingPayload as
        | { publicatieId?: unknown }
        | undefined;
      const publicatieId = asIdString(listingPayload?.publicatieId);
      if (!publicatieId) {
        return {
          bronReferentie: item.bronReferentie,
          reason: "listing payload missing publicatieId",
          status: "rejected" as const,
        };
      }

      if (
        await shouldSkipFetch(
          knownHashes,
          options.bronId,
          item.bronReferentie,
          item.contentHash
        )
      ) {
        return null;
      }

      const detail = await client.fetchDetail(publicatieId);
      const payload: TenderNedFetchedPayload = {
        detail,
        listing: detail,
        publicatieId,
      };
      const body = new TextEncoder().encode(JSON.stringify(payload));
      const contentHash = await hashTenderNedDetailPayload(body);
      return {
        body,
        bronReferentie: item.bronReferentie,
        contentHash,
        contentType: "json",
        status: "fetched" as const,
      };
    },
  };
};
