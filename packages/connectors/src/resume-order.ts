import type { BronId } from "@ji/domain";

import type { DiscoverItem } from "./contract";

/**
 * Fetch history port for fetch ordering: per listed reference, when a run
 * last processed it. "Processed" covers every outcome (fetched, skipped on
 * a known listing hash, rejected), so nothing stays at the front forever. A
 * reference missing from the map was never processed.
 */
export interface ResumeOrderLookup {
  lastFetchedAt: (
    bronId: BronId,
    bronReferenties: readonly string[]
  ) => Promise<ReadonlyMap<string, Date>>;
  /** Stamps one reference as processed now. */
  markFetched: (bronId: BronId, bronReferentie: string) => Promise<void>;
}

/**
 * Orders one discovered page for fetching so a run that is cut off by its
 * budget loses as little as possible and the next run picks up the rest:
 *
 * 1. references never processed (new listings) first,
 * 2. then the rest by oldest processing first.
 *
 * Within each group the listing order is kept. `referenceOf` maps an item to
 * the key the lookup used (the stored, bounded reference).
 */
export const orderForResume = (
  items: readonly DiscoverItem[],
  lastFetched: ReadonlyMap<string, Date>,
  referenceOf: (item: DiscoverItem) => string
): DiscoverItem[] => {
  const rank = (item: DiscoverItem): number =>
    lastFetched.get(referenceOf(item))?.getTime() ?? Number.NEGATIVE_INFINITY;
  return items
    .map((item, index) => ({ index, item, rank: rank(item) }))
    .toSorted((left, right) =>
      left.rank === right.rank
        ? left.index - right.index
        : left.rank - right.rank
    )
    .map(({ item }) => item);
};
