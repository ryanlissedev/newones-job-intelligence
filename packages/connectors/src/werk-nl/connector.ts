import type { BronId } from "@ji/domain";

import type {
  Connector,
  ConnectorCheckpoint,
  ConnectorDiscoverResult,
  DiscoverItem,
} from "../contract";
import { HttpStatusError } from "../json-ld/live-fetch";
import { createWerkNlClient } from "./client";
import type { WerkNlClient } from "./client";
import { hashWerkNlDetailPayload, hashWerkNlListingItem } from "./hash";
import type {
  WerkNlFetchedPayload,
  WerkNlSearchItem,
  WerkNlVacatureDetail,
} from "./types";
import {
  WERK_NL_MAX_SEARCH_RESULTS,
  WERK_NL_PAGE_SIZE,
  WERK_NL_SHIFT_TYPE_SHARDS,
} from "./types";

export interface WerkNlConnectorOptions {
  bronId: BronId;
  client?: WerkNlClient;
  /** JOB_SHIFT_TYPE facet values to shard on; defaults to both live values.
   * Sharding keeps every discover slice under the 200k search ceiling. */
  shardValues?: readonly string[];
  /** Test/smoke bound on pages per shard. A capped run reports `truncated`
   * so the runner does not count unseen records as missed. */
  pageLimitPerShard?: number;
}

interface WerkNlCursor {
  /** Shard index into `shardValues`. */
  s: number;
  /** 1-based `currentPage` within that shard. */
  p: number;
  /** Set once any earlier shard hit `pageLimitPerShard`. */
  t?: 1;
}

const encodeCursor = (cursor: WerkNlCursor): string =>
  `werk-nl:${JSON.stringify(cursor)}`;

const CURSOR_PREFIX = "werk-nl:";

const decodeCursor = (checkpoint: ConnectorCheckpoint | null): WerkNlCursor => {
  const raw = checkpoint?.cursor;
  if (!raw?.startsWith(CURSOR_PREFIX)) {
    return { p: 1, s: 0 };
  }
  try {
    // SAFETY: cursor is connector-owned JSON written by encodeCursor.
    const parsed = JSON.parse(raw.slice(CURSOR_PREFIX.length)) as WerkNlCursor;
    if (
      Number.isInteger(parsed.s) &&
      Number.isInteger(parsed.p) &&
      parsed.s >= 0 &&
      parsed.p >= 1
    ) {
      return parsed;
    }
  } catch {
    // Fall through to a fresh sweep on an unparseable cursor.
  }
  return { p: 1, s: 0 };
};

const referenceOf = (item: WerkNlSearchItem): string =>
  String(item.referenceNumber);

/** Page count for one shard. `totalResults` can be absent/non-finite
 * upstream; then a full page means "probably more" and anything less ends
 * the shard — the answer never feeds a NaN page calculation. */
const totalPagesOf = (
  totalResults: number | null | undefined,
  rowsServed: number,
  page: number
): number => {
  if (!Number.isFinite(totalResults)) {
    return rowsServed === WERK_NL_PAGE_SIZE ? page + 1 : page;
  }
  return Math.ceil(
    Math.min(totalResults ?? 0, WERK_NL_MAX_SEARCH_RESULTS) / WERK_NL_PAGE_SIZE
  );
};

export const createWerkNlConnector = (
  options: WerkNlConnectorOptions
): Connector => {
  const client = options.client ?? createWerkNlClient();
  const shards = options.shardValues ?? WERK_NL_SHIFT_TYPE_SHARDS;
  const pageLimit =
    options.pageLimitPerShard !== undefined && options.pageLimitPerShard >= 1
      ? options.pageLimitPerShard
      : undefined;

  return {
    bronId: options.bronId,
    discover: async (
      checkpoint: ConnectorCheckpoint | null
    ): Promise<ConnectorDiscoverResult> => {
      const cursor = decodeCursor(checkpoint);
      // A cursor pointing past the last shard is stale (the shard list shrank
      // since the checkpoint): the sweep is over, not "clamp into the last
      // shard and recrawl it".
      if (cursor.s >= shards.length) {
        return { checkpoint: {}, hasMore: false, items: [] };
      }
      const shardIndex = cursor.s;
      const shiftType = shards[shardIndex];
      if (shiftType === undefined) {
        return { checkpoint: {}, hasMore: false, items: [] };
      }
      const page = cursor.p;
      const listing = await client.fetchListing(page, shiftType);
      const rows = listing.items ?? [];
      const items: DiscoverItem[] = await Promise.all(
        rows.map(async (row) => ({
          bronReferentie: referenceOf(row),
          contentHash: await hashWerkNlListingItem(row),
          listingPayload: row,
        }))
      );

      const totalPages = totalPagesOf(listing.totalResults, rows.length, page);
      const pageLimitReached =
        pageLimit !== undefined && page >= pageLimit && page < totalPages;
      // An empty page while upstream still claims un-served results is an
      // anomaly, not a clean shard end — flag it so the run reads truncated
      // instead of letting reconcileMissedPolls stale the unseen remainder.
      // Covers the empty last page too: totalResults 40 with an empty page 2
      // still leaves 20 claimed items unaccounted for. A shard that shrank
      // upstream (page beyond totalPages) is a genuine end, not an anomaly.
      const claimedUnseen =
        Number.isFinite(listing.totalResults) &&
        (listing.totalResults ?? 0) > (page - 1) * WERK_NL_PAGE_SIZE;
      const anomalousEmptyPage = rows.length === 0 && claimedUnseen;
      const truncated =
        pageLimitReached || anomalousEmptyPage || cursor.t === 1;
      const shardExhausted =
        rows.length === 0 || page >= totalPages || pageLimitReached;
      const nextShardIndex = shardIndex + 1;
      const hasMore = !shardExhausted || nextShardIndex < shards.length;

      let nextCursor: ConnectorCheckpoint = {};
      if (!shardExhausted) {
        nextCursor = {
          cursor: encodeCursor({ p: page + 1, s: shardIndex, t: cursor.t }),
        };
      } else if (nextShardIndex < shards.length) {
        nextCursor = {
          cursor: encodeCursor({
            p: 1,
            s: nextShardIndex,
            t: truncated ? 1 : cursor.t,
          }),
        };
      }

      const result: ConnectorDiscoverResult = {
        checkpoint: nextCursor,
        hasMore,
        items,
      };
      if (truncated && !hasMore) {
        result.truncated = true;
      }
      return result;
    },
    fetch: async (item) => {
      // SAFETY: discover() attaches werk.nl search rows as listingPayload.
      const listing = item.listingPayload as
        | WerkNlSearchItem
        | null
        | undefined;
      const referenceNumber =
        listing !== null && listing !== undefined
          ? referenceOf(listing)
          : item.bronReferentie;
      const numeric = Number(referenceNumber);
      if (!(Number.isFinite(numeric) && numeric > 0)) {
        return {
          bronReferentie: item.bronReferentie,
          reason: "listing payload missing referenceNumber",
          status: "rejected" as const,
        };
      }

      let detail: WerkNlVacatureDetail;
      try {
        detail = await client.fetchDetail(referenceNumber);
      } catch (error) {
        // CTP-608: a vacature that expired between listing and detail read is
        // "removed at source" — reject the item instead of stalling the sweep
        // on a page that can never succeed. 410 Gone is the same signal.
        if (
          error instanceof HttpStatusError &&
          (error.status === 404 || error.status === 410)
        ) {
          return {
            bronReferentie: item.bronReferentie,
            reason: `detail returned ${error.status} — removed at source`,
            status: "rejected" as const,
          };
        }
        throw error;
      }
      const payload: WerkNlFetchedPayload = {
        detail,
        listing: listing ?? null,
        referenceNumber,
      };
      const body = new TextEncoder().encode(JSON.stringify(payload));
      const contentHash = await hashWerkNlDetailPayload(body);
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
