import type { BronId } from "@ji/domain";

import type { DiscoverItem } from "./contract";

/**
 * Read port for fetch ordering: per listed reference, when its detail page
 * was last fetched and recorded. A reference missing from the map has no
 * source record yet (never fetched); `null` means a record exists but its
 * fetch time is unknown (rows older than migration 0032).
 */
export interface ResumeOrderLookup {
  lastFetchedAt: (
    bronId: BronId,
    bronReferenties: readonly string[]
  ) => Promise<ReadonlyMap<string, Date | null>>;
}

/**
 * Orders one discovered page for fetching so a run that is cut off by its
 * budget loses as little as possible and the next run picks up the rest:
 *
 * 1. references never recorded (new listings) first,
 * 2. then records with an unknown fetch time,
 * 3. then records by oldest fetch first.
 *
 * Within each group the listing order is kept. `referenceOf` maps an item to
 * the key the lookup used (the stored, bounded reference).
 */
export const orderForResume = (
  items: readonly DiscoverItem[],
  lastFetched: ReadonlyMap<string, Date | null>,
  referenceOf: (item: DiscoverItem) => string
): DiscoverItem[] => {
  const rank = (item: DiscoverItem): number => {
    const reference = referenceOf(item);
    if (!lastFetched.has(reference)) {
      return Number.NEGATIVE_INFINITY;
    }
    const fetchedAt = lastFetched.get(reference) ?? null;
    return fetchedAt === null ? Number.MIN_SAFE_INTEGER : fetchedAt.getTime();
  };
  return items
    .map((item, index) => ({ index, item, rank: rank(item) }))
    .toSorted((left, right) =>
      left.rank === right.rank
        ? left.index - right.index
        : left.rank - right.rank
    )
    .map(({ item }) => item);
};
