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

/**
 * Share of would-be-skipped pages that are fetched anyway each day to check
 * whether the source's `<lastmod>` is honest. The sample changes daily, so
 * over time the whole corpus gets probed, on top of the weekly revalidation.
 */
export const LASTMOD_HONESTY_PROBE_PERCENT = 2;

/**
 * When more than this share of probed pages changed although their lastmod
 * did not, the source's lastmod is not trusted for the rest of the run.
 * Every remaining page is then fetched. Fail-safe: one lie in a small sample trips it.
 */
export const LASTMOD_DISTRUST_RATIO = 0.01;

export interface LastmodHonestyReport {
  /** Probed pages whose payload changed while their lastmod did not. */
  dishonest: number;
  /** True once the run stopped trusting lastmod and fetches everything. */
  distrusted: boolean;
  /** Would-be-skipped pages fetched anyway as honesty probes. */
  probes: number;
  /** Pages actually skipped on an unchanged lastmod. */
  skipped: number;
}

export interface LastmodSkipGuard {
  /** Call after every successful detail fetch with the fetched payload hash. */
  observeFetched: (bronReferentie: string, payloadHash: string) => void;
  report: () => LastmodHonestyReport;
  shouldSkip: (bronId: BronId, item: DiscoverItem) => Promise<boolean>;
}

export interface LastmodGuardOptions extends LastmodSkipOptions {
  /** Called once when the run stops trusting lastmod (for logs/alerts). */
  readonly onDistrust?: (report: LastmodHonestyReport) => void;
  readonly probePercent?: number;
}

const isHonestyProbe = async (
  url: string,
  now: Date,
  percent: number
): Promise<boolean> => {
  if (percent <= 0) {
    return false;
  }
  const day = Math.floor(now.getTime() / DAY_MS);
  const digest = await hashContent(new TextEncoder().encode(`${day}\0${url}`));
  return Number.parseInt(digest.slice(0, 8), 16) % 10_000 < percent * 100;
};

/**
 * Per-run wrapper around `shouldSkipUnchangedLastmod` that adds the lastmod
 * honesty probe (PR2, invariant C2: a skip signal is only safe if it moves
 * when the detail does):
 *
 * - A daily ~2% sample of pages that WOULD be skipped is fetched anyway.
 * - After the fetch, the payload hash is compared with the one persisted at
 *   the last fetch. Different payload with the same lastmod means the source's
 *   lastmod lied.
 * - Once lies exceed `LASTMOD_DISTRUST_RATIO` of the probes, nothing else is
 *   skipped in this run.
 *
 * Probes without a stored payload hash (no `getPayloadHash`, or a new record)
 * are fetched but cannot be judged.
 */
export const createLastmodSkipGuard = (
  options: LastmodGuardOptions
): LastmodSkipGuard => {
  const pendingProbes = new Map<string, string | null>();
  const state: LastmodHonestyReport = {
    dishonest: 0,
    distrusted: false,
    probes: 0,
    skipped: 0,
  };
  const percent = options.probePercent ?? LASTMOD_HONESTY_PROBE_PERCENT;

  const shouldSkip = async (
    bronId: BronId,
    item: DiscoverItem
  ): Promise<boolean> => {
    if (state.distrusted) {
      return false;
    }
    if (!(await shouldSkipUnchangedLastmod(options, bronId, item))) {
      return false;
    }
    // SAFETY: shouldSkipUnchangedLastmod only returns true for a JsonLdDiscoveryUrl payload with a url.
    const { url } = item.listingPayload as JsonLdDiscoveryUrl;
    const now = options.now?.() ?? new Date();
    if (await isHonestyProbe(url, now, percent)) {
      const stored =
        (await options.knownHashes.getPayloadHash?.(
          bronId,
          item.bronReferentie
        )) ?? null;
      pendingProbes.set(item.bronReferentie, stored);
      return false;
    }
    state.skipped += 1;
    return true;
  };

  const observeFetched = (bronReferentie: string, payloadHash: string) => {
    if (!pendingProbes.has(bronReferentie)) {
      return;
    }
    const stored = pendingProbes.get(bronReferentie) ?? null;
    pendingProbes.delete(bronReferentie);
    if (stored === null) {
      return;
    }
    state.probes += 1;
    if (stored !== payloadHash) {
      state.dishonest += 1;
    }
    if (
      !state.distrusted &&
      state.dishonest / state.probes > LASTMOD_DISTRUST_RATIO
    ) {
      state.distrusted = true;
      options.onDistrust?.({ ...state });
    }
  };

  return {
    observeFetched,
    report: () => ({ ...state }),
    shouldSkip,
  };
};
