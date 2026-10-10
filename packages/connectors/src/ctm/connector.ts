import type { BronId } from "@ji/domain";

import type {
  Connector,
  ConnectorCheckpoint,
  ConnectorDiscoverResult,
  DiscoverItem,
} from "../contract";
import { shouldSkipFetch } from "../known-hash";
import type { KnownHashStore } from "../known-hash";
import { createCtmClient } from "./client";
import type { CtmClient } from "./client";
import { hashCtmListingItem, hashCtmPayload } from "./hash";
import type { CtmFetchedPayload } from "./types";

export interface CtmConnectorOptions {
  bronId: BronId;
  client?: CtmClient;
  knownHashes?: KnownHashStore;
}

/**
 * CTM/EU-Supply publishes its Atom feed as a single, ungapped window (days=30) —
 * there is no page parameter to advance through, so discover() always returns
 * hasMore: false. The knownHashes lookup in fetch() is an early-exit optimisation
 * against the last-seen listing hash (same pattern as the sibling connectors); the
 * outcome that actually prevents re-ingesting unchanged entries across polls is the
 * observation recorder's new/changed/unchanged comparison further down the pipeline.
 */
export const createCtmConnector = (options: CtmConnectorOptions): Connector => {
  const client = options.client ?? createCtmClient();
  const { knownHashes } = options;

  return {
    bronId: options.bronId,
    discover: async (
      _checkpoint: ConnectorCheckpoint | null
    ): Promise<ConnectorDiscoverResult> => {
      const listing = await client.fetchListing();
      const items: DiscoverItem[] = await Promise.all(
        listing.entries.map(async (entry) => ({
          bronReferentie: entry.aanvraagnummer,
          contentHash: await hashCtmListingItem(entry),
          listingPayload: entry,
        }))
      );
      return {
        checkpoint: { cursor: listing.updatedAt },
        hasMore: false,
        items,
      };
    },
    fetch: async (item) => {
      // SAFETY: discover() attaches parsed CTM Atom entries as listingPayload.
      const entry = item.listingPayload as
        | CtmFetchedPayload["entry"]
        | undefined;
      if (!entry?.aanvraagnummer || !entry?.titel) {
        return {
          bronReferentie: item.bronReferentie,
          reason: "listing payload missing aanvraagnummer or titel",
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

      const payload: CtmFetchedPayload = { entry };
      const body = new TextEncoder().encode(JSON.stringify(payload));
      const contentHash = await hashCtmPayload(body);
      return {
        body,
        bronReferentie: item.bronReferentie,
        contentHash,
        contentType: "json",
        status: "fetched" as const,
      };
    },
    fetchUsesNetwork: false,
  };
};
