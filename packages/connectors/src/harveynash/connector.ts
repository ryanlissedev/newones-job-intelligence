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
  createHarveyNashClient,
  harveyNashBronReferentie,
  harveyNashEindklant,
  resolveHarveyNashDetailUrl,
} from "./client";
import type { HarveyNashClient } from "./client";
import { hashHarveyNashListingItem, hashHarveyNashPayload } from "./hash";
import type {
  HarveyNashDetail,
  HarveyNashFetchedPayload,
  HarveyNashSearchItem,
} from "./types";

export interface HarveyNashConnectorOptions {
  bronId: BronId;
  client?: HarveyNashClient;
  knownHashes?: KnownHashStore;
}

/** Bounded page cap so a stale/misreported total_size can never spin
 * discover() into an unbounded loop against the live site. 31 results / 15
 * per page is 3 pages at capture time; this leaves ample headroom. */
export const HARVEYNASH_MAX_DISCOVER_PAGES = 50;

export const createHarveyNashConnector = (
  options: HarveyNashConnectorOptions
): Connector => {
  const client = options.client ?? createHarveyNashClient();
  const { knownHashes } = options;

  return {
    bronId: options.bronId,
    discover: async (
      checkpoint: ConnectorCheckpoint | null
    ): Promise<ConnectorDiscoverResult> => {
      const page = checkpoint?.page ?? 0;
      const listing = await client.fetchListing(page);
      let pageSize = checkpoint?.pageSize ?? 0;
      if (pageSize <= 0) {
        pageSize = listing.results.length > 0 ? listing.results.length : 1;
      }
      const items: DiscoverItem[] = await Promise.all(
        listing.results.map(async (result) => ({
          bronReferentie: harveyNashBronReferentie(result.job),
          contentHash: await hashHarveyNashListingItem(result.job),
          listingPayload: result.job,
        }))
      );
      const nextPage = page + 1;
      const sourceHasMore =
        listing.results.length > 0 && nextPage * pageSize < listing.total_size;
      const hasMore = sourceHasMore && nextPage < HARVEYNASH_MAX_DISCOVER_PAGES;
      return {
        checkpoint: { page: nextPage, pageSize },
        hasMore,
        items,
        // RJC-397: the cap stopped us while total_size says there is more.
        truncated: sourceHasMore && !hasMore,
      };
    },
    fetch: async (item) => {
      // SAFETY: discover() attaches Harvey Nash search rows as listingPayload.
      const job = item.listingPayload as HarveyNashSearchItem | undefined;
      const jobId = harveyNashBronReferentie(job ?? {});
      const detailUrl = resolveHarveyNashDetailUrl(job?.url_slug);
      if (!jobId || !job?.title) {
        return {
          bronReferentie: item.bronReferentie,
          reason: "listing payload missing job id/title",
          status: "rejected" as const,
        };
      }
      if (!detailUrl) {
        return {
          bronReferentie: item.bronReferentie,
          reason: "listing payload missing detail url slug",
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

      const fragment = await client.fetchDetail(jobId, detailUrl);
      // Fall back to the listing's own salary_package/addresses[0] when the
      // detail page's post-info block didn't parse (template drift, a
      // missing field on this particular posting, etc.) -- the listing
      // carries both verbatim, so this is a same-source fallback, not a
      // guess.
      const detail: HarveyNashDetail = {
        eindklant: harveyNashEindklant(job),
        facts: {
          ...fragment.facts,
          locatie: fragment.facts.locatie ?? job.addresses?.[0],
          richttarief: fragment.facts.richttarief ?? job.salary_package,
        },
        jobId,
        jsonLd: fragment.jsonLd,
        publishedAt: job.published_at,
        // Observed 2026-08-31: `external_reference` is `<BBBH code>_<published_at - 1>`
        // (e.g. "BBBH121494_1788161094" against published_at 1788161095) --
        // the timestamp suffix is derived from the posting time, so this
        // fallback reference is not stable across a republish/re-post of the
        // same job. `job.id` (the UUID) is the stable identifier in that
        // case, but its stability across a real republish is unproven from
        // a single capture -- worth a second capture a few days out to
        // confirm before relying on it for long-term dedup.
        reference: job.external_reference?.trim() || jobId,
        title: job.title,
        url: detailUrl,
      };
      const payload: HarveyNashFetchedPayload = { detail };
      const body = new TextEncoder().encode(JSON.stringify(payload));
      const contentHash = await hashHarveyNashPayload(body);
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
