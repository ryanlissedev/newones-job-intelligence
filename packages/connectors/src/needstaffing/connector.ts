import type { BronId } from "@ji/domain";

import type {
  Connector,
  ConnectorCheckpoint,
  ConnectorDiscoverResult,
  DiscoverItem,
} from "../contract";
import { shouldSkipFetch } from "../known-hash";
import type { KnownHashStore } from "../known-hash";
import {
  buildNeedstaffingRawHtml,
  createNeedstaffingClient,
  parseNeedstaffingDetail,
} from "./client";
import type { NeedstaffingClient } from "./client";
import { hashNeedstaffingListingItem, hashNeedstaffingPayload } from "./hash";
import type {
  NeedstaffingFetchedPayload,
  NeedstaffingListingItem,
} from "./types";
import { NEEDSTAFFING_MAX_LISTING_PAGES } from "./types";

export interface NeedstaffingConnectorOptions {
  bronId: BronId;
  client?: NeedstaffingClient;
  knownHashes?: KnownHashStore;
}

export const createNeedstaffingConnector = (
  options: NeedstaffingConnectorOptions
): Connector => {
  const client = options.client ?? createNeedstaffingClient();
  const { knownHashes } = options;

  return {
    bronId: options.bronId,
    discover: async (
      checkpoint: ConnectorCheckpoint | null
    ): Promise<ConnectorDiscoverResult> => {
      const page = checkpoint?.page ?? 0;
      const listing = await client.fetchListing(page);
      const items: DiscoverItem[] = await Promise.all(
        listing.items.map(async (item) => ({
          bronReferentie: item.id,
          contentHash: await hashNeedstaffingListingItem(item),
          listingPayload: item,
        }))
      );
      const withinCap = page + 1 < NEEDSTAFFING_MAX_LISTING_PAGES;
      return {
        checkpoint: { page: page + 1 },
        hasMore: listing.hasNextPage && withinCap,
        items,
        // RJC-397: the cap stopped us while the site still had a next page.
        truncated: listing.hasNextPage && !withinCap,
      };
    },
    fetch: async (item) => {
      // SAFETY: discover() attaches parsed Needstaffing listing rows as listingPayload.
      const listing = item.listingPayload as
        | NeedstaffingListingItem
        | undefined;
      if (!listing?.id) {
        return {
          bronReferentie: item.bronReferentie,
          reason: "listing payload missing id",
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

      const detailHtml = await client.fetchDetailHtml(listing.id);
      const detail = await parseNeedstaffingDetail(detailHtml, listing.id);
      if (!detail.titel) {
        return {
          bronReferentie: item.bronReferentie,
          reason: "detail page missing titel",
          status: "rejected" as const,
        };
      }

      const payload: NeedstaffingFetchedPayload = {
        detail,
        listing,
        raw: { html: buildNeedstaffingRawHtml(detailHtml) },
      };
      const body = new TextEncoder().encode(JSON.stringify(payload));
      const contentHash = await hashNeedstaffingPayload(body);
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
