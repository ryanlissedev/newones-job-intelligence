import type { BronId } from "@ji/domain";

import type { DiscoverItem } from "../contract";
import { shouldSkipFetch } from "../known-hash";
import type { KnownHashStore } from "../known-hash";
import { hashContent } from "../object-store";
import type { JsonLdDiscoveryUrl } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Every URL is re-fetched at least once per this many days, lastmod or not. */
export const LASTMOD_REVALIDATE_EVERY_DAYS = 7;

/**
 * A date-only `<lastmod>` (Randstad: `2026-10-08`) cannot tell a morning
 * fetch from an afternoon edit on the same day, so the page keeps being
 * fetched until its lastmod is this old.
 */
export const DATE_ONLY_LASTMOD_SETTLE_MS = 2 * DAY_MS;

const DATE_ONLY_LASTMOD = /^\d{4}-\d{2}-\d{2}$/u;

export interface LastmodSkipOptions {
  /** Listing hashes persisted by earlier runs (`source_record.listing_hash`). */
  readonly knownHashes: KnownHashStore;
  readonly now?: () => Date;
  readonly revalidateEveryDays?: number;
}

/**
 * The revalidation day of a URL: a stable bucket in `[0, everyDays)`, so the
 * corpus is spread evenly over the week instead of re-fetched all at once.
 */
const revalidationBucket = async (
  url: string,
  everyDays: number
): Promise<number> => {
  const digest = await hashContent(new TextEncoder().encode(url));
  return Number.parseInt(digest.slice(0, 8), 16) % everyDays;
};

const isRevalidationDay = async (
  url: string,
  now: Date,
  everyDays: number
): Promise<boolean> =>
  (await revalidationBucket(url, everyDays)) ===
  Math.floor(now.getTime() / DAY_MS) % everyDays;

const isUnsettledDateOnly = (lastmod: string, now: Date): boolean => {
  if (!DATE_ONLY_LASTMOD.test(lastmod)) {
    return false;
  }
  const published = Date.parse(`${lastmod}T00:00:00Z`);
  return (
    Number.isNaN(published) ||
    now.getTime() - published < DATE_ONLY_LASTMOD_SETTLE_MS
  );
};

/**
 * Whether a sitemap detail page can be skipped because its `<lastmod>` has
 * not moved since the last fetch. The listing hash covers `url + lastmod`
 * (+ parser version), so "the stored listing hash equals this one" is
 * "lastmod unchanged since we last fetched and persisted this page". Any
 * change of lastmod, in either direction, re-fetches.
 *
 * Safe fallbacks, each of which fetches:
 * - no `<lastmod>` on the entry (the hash would never change);
 * - no persisted listing hash (never fetched, or a pre-0012 row);
 * - a date-only lastmod younger than `DATE_ONLY_LASTMOD_SETTLE_MS`;
 * - the URL's weekly revalidation day, which bounds how long a publisher
 *   that forgets to bump lastmod can freeze a record.
 */
export const shouldSkipUnchangedLastmod = async (
  options: LastmodSkipOptions,
  bronId: BronId,
  item: DiscoverItem
): Promise<boolean> => {
  // SAFETY: the json-ld discover() attaches JsonLdDiscoveryUrl rows as listingPayload.
  const entry = item.listingPayload as Partial<JsonLdDiscoveryUrl> | undefined;
  const lastmod = entry?.lastmod?.trim();
  if (!(entry?.url && lastmod)) {
    return false;
  }
  const now = options.now?.() ?? new Date();
  if (isUnsettledDateOnly(lastmod, now)) {
    return false;
  }
  if (
    await isRevalidationDay(
      entry.url,
      now,
      options.revalidateEveryDays ?? LASTMOD_REVALIDATE_EVERY_DAYS
    )
  ) {
    return false;
  }
  return shouldSkipFetch(
    options.knownHashes,
    bronId,
    item.bronReferentie,
    item.contentHash
  );
};
