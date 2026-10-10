import type { BronId } from "@ji/domain";

import type {
  Connector,
  ConnectorCheckpoint,
  ConnectorDiscoverResult,
  DiscoverItem,
} from "../contract";
import { createIndeedClient } from "./client";
import type { IndeedClient } from "./client";
import { hashIndeedDetailPayload, hashIndeedListingItem } from "./hash";
import type {
  IndeedFetchedPayload,
  IndeedJobCard,
  IndeedPageLink,
} from "./types";

export interface IndeedConnectorOptions {
  bronId: BronId;
  client?: IndeedClient;
  /** Test/smoke bound on SERP pages per sweep. A capped run reports
   * `truncated` so the runner does not count unseen records as missed. */
  pageLimit?: number;
}

interface IndeedCursor {
  /** Pages already served this sweep (1-based count including current). */
  n: number;
  /** Upstream `start` parameter of the next page to request. */
  start: number;
  /** Set once an earlier page hit `pageLimit` (run already truncated). */
  t?: 1;
}

const CURSOR_PREFIX = "indeed:";

const encodeCursor = (cursor: IndeedCursor): string =>
  `${CURSOR_PREFIX}${JSON.stringify(cursor)}`;

const decodeCursor = (checkpoint: ConnectorCheckpoint | null): IndeedCursor => {
  const raw = checkpoint?.cursor;
  if (!raw?.startsWith(CURSOR_PREFIX)) {
    return { n: 0, start: 0 };
  }
  try {
    // SAFETY: cursor is connector-owned JSON written by encodeCursor.
    const parsed = JSON.parse(raw.slice(CURSOR_PREFIX.length)) as IndeedCursor;
    if (
      Number.isInteger(parsed.start) &&
      parsed.start >= 0 &&
      Number.isInteger(parsed.n) &&
      parsed.n >= 0
    ) {
      return parsed;
    }
  } catch {
    // Fall through to a fresh sweep on an unparseable cursor.
  }
  return { n: 0, start: 0 };
};

/** Next upstream `start`, taken from the SERP's own `pageLinks` (label ==
 * pageNum + 1) rather than assumed — the 2026-09-18 capture showed a stride
 * of 10 while serving 15 cards per page, so the page size cannot be derived
 * from the card count. */
const nextStartOf = (
  pageNum: number | null,
  links: readonly IndeedPageLink[]
): number | null => {
  if (pageNum === null) {
    return null;
  }
  const next = links.find((link) => link.label === pageNum + 1);
  const href = next?.href;
  if (!href) {
    return null;
  }
  const start = new URL(href, "https://nl.indeed.com").searchParams.get(
    "start"
  );
  const parsed = start === null ? Number.NaN : Number(start);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
};

const JOBKEY_PATTERN = /^[a-f0-9]{10,20}$/u;

export const createIndeedConnector = (
  options: IndeedConnectorOptions
): Connector => {
  const client = options.client ?? createIndeedClient();
  const pageLimit =
    options.pageLimit !== undefined && options.pageLimit >= 1
      ? options.pageLimit
      : undefined;

  return {
    bronId: options.bronId,
    discover: async (
      checkpoint: ConnectorCheckpoint | null
    ): Promise<ConnectorDiscoverResult> => {
      const cursor = decodeCursor(checkpoint);
      const page = await client.fetchListing(cursor.start);
      const pagesServed = cursor.n + 1;
      const items: DiscoverItem[] = await Promise.all(
        page.cards.map(async (card) => ({
          bronReferentie: card.jobkey,
          contentHash: await hashIndeedListingItem(card),
          listingPayload: card,
        }))
      );

      const nextStart = nextStartOf(page.pageNum, page.pageLinks);
      const pageLimitReached =
        pageLimit !== undefined && pagesServed >= pageLimit;
      // An empty page while the SERP still links further pages is an
      // anomaly, not a clean end — flag it so the run reads truncated
      // instead of letting reconcileMissedPolls stale the unseen remainder.
      const anomalousEmptyPage = page.cards.length === 0 && nextStart !== null;
      const truncated =
        (nextStart !== null && pageLimitReached) ||
        anomalousEmptyPage ||
        cursor.t === 1;
      const hasMore = nextStart !== null && !pageLimitReached;

      const result: ConnectorDiscoverResult = {
        checkpoint:
          nextStart === null || pageLimitReached
            ? {}
            : {
                cursor: encodeCursor({
                  n: pagesServed,
                  start: nextStart,
                  t: truncated ? 1 : cursor.t,
                }),
              },
        hasMore,
        items,
      };
      if (truncated && !hasMore) {
        result.truncated = true;
      }
      return result;
    },
    fetch: async (item) => {
      // SAFETY: discover() attaches projected Indeed job cards as listingPayload.
      const card = item.listingPayload as IndeedJobCard | null | undefined;
      const jobkey = card?.jobkey ?? item.bronReferentie;
      if (!JOBKEY_PATTERN.test(jobkey)) {
        return {
          bronReferentie: item.bronReferentie,
          reason: "listing payload missing a jobkey",
          status: "rejected" as const,
        };
      }

      const detail = await client.fetchDetail(jobkey);
      if (detail === null) {
        // /viewjob?jk= is login-gated and the SERP only embeds a viewjob
        // body for the card it auto-opens; without either there is no
        // anonymous detail. Reject rather than freeze a card-only body —
        // the snippet would masquerade as the full beschrijving and a
        // silently-broken detail route would stay invisible in run metrics.
        return {
          bronReferentie: item.bronReferentie,
          reason: `no anonymous viewjob payload published for jk ${jobkey}`,
          status: "rejected" as const,
        };
      }

      const payload: IndeedFetchedPayload = {
        card: card ?? null,
        detail,
        jobkey,
      };
      const body = new TextEncoder().encode(JSON.stringify(payload));
      const contentHash = await hashIndeedDetailPayload(body);
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
