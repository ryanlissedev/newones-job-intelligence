import type { BronId } from "@ji/domain";

import type {
  Connector,
  ConnectorCheckpoint,
  ConnectorDiscoverResult,
} from "../contract";
import { createFreelancerNlClient, parseFreelancerNlDetail } from "./client";
import type { FreelancerNlClient } from "./client";
import { hashFreelancerNlListingItem, hashFreelancerNlPayload } from "./hash";
import type {
  FreelancerNlFetchedPayload,
  FreelancerNlListingItem,
} from "./types";
import { FREELANCER_NL_MAX_LISTING_PAGES } from "./types";

export interface FreelancerNlConnectorOptions {
  bronId: BronId;
  client?: FreelancerNlClient;
}

const seenFromCheckpoint = (
  checkpoint: ConnectorCheckpoint | null
): Set<string> => {
  if (!checkpoint?.cursor) {
    return new Set();
  }
  try {
    const parsed: unknown = JSON.parse(checkpoint.cursor);
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter(
            (value): value is string =>
              // SAFETY: JSON checkpoint values are accepted only when their
              // runtime representation is a string reference.
              // oxlint-disable-next-line anti-slop/no-runtime-typeof
              typeof value === "string"
          )
        : []
    );
  } catch (error) {
    // oxlint-disable-next-line no-console -- lost resume state must leave a trace; @ji/connectors has no logger dependency
    console.warn(
      JSON.stringify({
        cursorLength: checkpoint.cursor.length,
        error: error instanceof Error ? error.name : "unknown",
        event: "connector.freelancer_nl.checkpoint_cursor_unparseable",
        page: checkpoint.page,
      })
    );
    return new Set();
  }
};

export const createFreelancerNlConnector = (
  options: FreelancerNlConnectorOptions
): Connector => {
  const client = options.client ?? createFreelancerNlClient();

  return {
    bronId: options.bronId,
    discover: async (
      checkpoint: ConnectorCheckpoint | null
    ): Promise<ConnectorDiscoverResult> => {
      const page = checkpoint?.page ?? 1;
      const seen = seenFromCheckpoint(checkpoint);
      const listing = await client.fetchListing(page);
      const newItems: FreelancerNlListingItem[] = [];
      for (const item of listing.items) {
        if (seen.has(item.bronReferentie)) {
          continue;
        }
        seen.add(item.bronReferentie);
        newItems.push(item);
      }
      const nextPage = page + 1;
      const reachedCap = page >= FREELANCER_NL_MAX_LISTING_PAGES;
      const hasMore = newItems.length > 0 && listing.hasNextPage && !reachedCap;
      return {
        checkpoint: {
          cursor: JSON.stringify([...seen].toSorted()),
          page: nextPage,
        },
        hasMore,
        items: await Promise.all(
          newItems.map(async (item) => ({
            bronReferentie: item.bronReferentie,
            contentHash: await hashFreelancerNlListingItem(item),
            listingPayload: item,
          }))
        ),
        truncated: newItems.length > 0 && listing.hasNextPage && reachedCap,
      };
    },
    fetch: async (item) => {
      // SAFETY: discover() attaches a Freelancer.nl listing row to every
      // emitted item; the guard below validates its required fields.
      const listing = item.listingPayload as
        | FreelancerNlListingItem
        | undefined;
      if (!(listing?.bronReferentie && listing.url && listing.titel)) {
        return {
          bronReferentie: item.bronReferentie,
          reason: "listing payload missing reference/url/title",
          status: "rejected" as const,
        };
      }
      const detailHtml = await client.fetchDetailHtml(listing);
      const detail = parseFreelancerNlDetail(detailHtml, listing);
      if (!detail.titel) {
        return {
          bronReferentie: item.bronReferentie,
          reason: "detail page missing titel",
          status: "rejected" as const,
        };
      }
      const payload: FreelancerNlFetchedPayload = { detail, listing };
      const body = new TextEncoder().encode(JSON.stringify(payload));
      return {
        body,
        bronReferentie: item.bronReferentie,
        contentHash: await hashFreelancerNlPayload(body),
        contentType: "json",
        status: "fetched" as const,
      };
    },
  };
};
