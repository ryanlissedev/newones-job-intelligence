import type { BronId } from "@ji/domain";

import type {
  Connector,
  ConnectorCheckpoint,
  ConnectorDiscoverResult,
} from "../contract";
import { HttpStatusError } from "../json-ld/live-fetch";
import type { JsonLdFetchedPayload } from "../json-ld/types";
import { createLinkedinClient } from "./client";
import type { LinkedinClient } from "./client";
import { hashLinkedinListingItem, hashLinkedinPayload } from "./hash";
import type { LinkedinListingItem } from "./types";
import {
  LINKEDIN_MAX_LISTING_PAGES,
  LINKEDIN_PAGE_SIZE,
  LINKEDIN_PARSER_VERSION,
  LINKEDIN_SLUG,
} from "./types";

export interface LinkedinConnectorOptions {
  bronId: BronId;
  client?: LinkedinClient;
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
        event: "connector.linkedin.checkpoint_cursor_unparseable",
        page: checkpoint.page,
      })
    );
    return new Set();
  }
};

/**
 * LinkedIn guest-route connector (CTP-549 POC): `discover` walks the public
 * `seeMoreJobPostings` fragment in `start`-offset pages; `fetch` retrieves
 * the canonical `/jobs/view/` page and stores a JsonLdFetchedPayload body —
 * the explicit JobPosting `ld+json` node when LinkedIn serves it, otherwise
 * a node synthesised from the topcard/criteria markup. No known-hash
 * short-circuit: the listing hash cannot see detail-only changes, matching
 * `listingHashCoversDetail: false` on the source definition.
 */
export const createLinkedinConnector = (
  options: LinkedinConnectorOptions
): Connector => {
  const client = options.client ?? createLinkedinClient();

  return {
    bronId: options.bronId,
    discover: async (
      checkpoint: ConnectorCheckpoint | null
    ): Promise<ConnectorDiscoverResult> => {
      // `start` offsets only ever advance in full PAGE_SIZE steps: a short
      // page ends the run, so page N always fetched start = N * PAGE_SIZE.
      const page = checkpoint?.page ?? 0;
      const seen = seenFromCheckpoint(checkpoint);
      const listing = await client.fetchListing(page * LINKEDIN_PAGE_SIZE);
      const newItems: LinkedinListingItem[] = [];
      for (const item of listing.items) {
        if (seen.has(item.bronReferentie)) {
          continue;
        }
        seen.add(item.bronReferentie);
        newItems.push(item);
      }
      const nextPage = page + 1;
      const reachedCap = nextPage >= LINKEDIN_MAX_LISTING_PAGES;
      const sourceHasMore = listing.items.length >= LINKEDIN_PAGE_SIZE;
      const hasMore = newItems.length > 0 && sourceHasMore && !reachedCap;
      return {
        checkpoint: {
          cursor: JSON.stringify([...seen].toSorted()),
          page: nextPage,
        },
        hasMore,
        items: await Promise.all(
          newItems.map(async (item) => ({
            bronReferentie: item.bronReferentie,
            contentHash: await hashLinkedinListingItem(item),
            listingPayload: item,
          }))
        ),
        truncated: newItems.length > 0 && sourceHasMore && reachedCap,
      };
    },
    fetch: async (item) => {
      // SAFETY: discover() attaches a LinkedIn listing card to every emitted
      // item; the guard below validates its required fields.
      const listing = item.listingPayload as LinkedinListingItem | undefined;
      if (!(listing?.bronReferentie && listing.url && listing.titel)) {
        return {
          bronReferentie: item.bronReferentie,
          reason: "listing payload missing reference/url/title",
          status: "rejected" as const,
        };
      }
      let detail;
      try {
        detail = await client.fetchDetail(listing);
      } catch (error) {
        // A discovered job can already be gone: reject that item instead of
        // failing the whole run.
        const gone = error instanceof HttpStatusError && error.status === 404;
        if (!gone) {
          throw error;
        }
        return {
          bronReferentie: item.bronReferentie,
          reason: "detail page returned 404 — removed at source",
          status: "rejected" as const,
        };
      }
      if (!detail.jobPosting) {
        return {
          bronReferentie: item.bronReferentie,
          reason: "no JobPosting data found on detail page",
          status: "rejected" as const,
        };
      }
      const payload: JsonLdFetchedPayload = {
        jobPosting: detail.jobPosting,
        labelBlock: detail.labelBlock,
        parserVersion: LINKEDIN_PARSER_VERSION,
        slug: LINKEDIN_SLUG,
        url: listing.url,
      };
      const body = new TextEncoder().encode(JSON.stringify(payload));
      return {
        body,
        bronReferentie: item.bronReferentie,
        contentHash: await hashLinkedinPayload(body),
        contentType: "json",
        status: "fetched" as const,
      };
    },
  };
};
