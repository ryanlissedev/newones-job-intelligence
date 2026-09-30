import type { BronId } from "@ji/domain";

import type {
  Connector,
  ConnectorCheckpoint,
  ConnectorDiscoverResult,
  DiscoverItem,
} from "../contract";
import { NotFoundFault } from "../effect-runtime";
import { shouldSkipFetch } from "../known-hash";
import type { KnownHashStore } from "../known-hash";
import { hashContent } from "../object-store";
import { createJsonLdClient, MissingDetailFixtureError } from "./client";
import type { JsonLdClient } from "./client";
import { applyExcludes, dedupeUrls } from "./discovery";
import { hashJsonLdListingItem, hashJsonLdPayload } from "./hash";
import { HttpStatusError } from "./live-fetch";
import type {
  JsonLdConnectorConfig,
  JsonLdDiscoveryUrl,
  JsonLdFetchedPayload,
} from "./types";

export interface JsonLdConnectorOptions {
  bronId: BronId;
  client?: JsonLdClient;
  config: JsonLdConnectorConfig;
  knownHashes?: KnownHashStore;
}

/** Stable per-source reference: the decoded URL path with leading/trailing slashes
 * stripped (e.g. `Interim/ciam-tester` for BlueTrail, `interim-opdrachten/devops-engineer-1f2fde9f`
 * for Hero, `vacatures/senior-azure-operations-engineer-8793` for Pro-Act). Assigned once at
 * discover() time from the URL alone (no detail fetch yet), so it stays stable across
 * discover -> fetch for known-hash lookups. */
export const urlSlugBronReferentie = (url: string): string => {
  const { pathname } = new URL(url);
  return decodeURIComponent(pathname).replaceAll(/^\/+|\/+$/gu, "");
};

/**
 * CTP-624: a batched sitemap-index walk checkpoints as
 * `cursor: "sitemap-index:<fingerprint>:<child>:<offset>"` — the position in
 * the selected corpus (which child sitemap, offset within its filtered
 * entries) plus a fingerprint of the index's ordered selected-child list
 * (SHA-256, first 16 hex chars). Any other checkpoint — absent, malformed, a
 * legacy `{}` from the whole-corpus pages, or a fingerprint that no longer
 * matches the freshly read index — starts the walk at position 0, so a
 * resumed run in a fresh process detects a re-based index and re-observes
 * instead of skipping into a shifted corpus.
 */
const SITEMAP_INDEX_CURSOR_PREFIX = "sitemap-index:";
const SITEMAP_INDEX_FINGERPRINT_HEX = 16;

interface SitemapIndexPosition {
  child: number;
  fingerprint: string;
  offset: number;
}

interface SitemapIndexPager {
  batchSize: number;
  fetchChild: (
    url: string,
    signal?: AbortSignal
  ) => Promise<JsonLdDiscoveryUrl[]>;
  fetchIndex: (signal?: AbortSignal) => Promise<string[]>;
}

const sitemapIndexCheckpoint = (
  fingerprint: string,
  child: number,
  offset: number
): ConnectorCheckpoint => ({
  cursor: `${SITEMAP_INDEX_CURSOR_PREFIX}${fingerprint}:${child}:${offset}`,
});

const SITEMAP_INDEX_CURSOR_PATTERN =
  /^sitemap-index:(?<fingerprint>[0-9a-f]{16}):(?<child>\d+):(?<offset>\d+)$/u;

const readSitemapIndexPosition = (
  checkpoint: ConnectorCheckpoint | null
): SitemapIndexPosition | null => {
  const match = SITEMAP_INDEX_CURSOR_PATTERN.exec(checkpoint?.cursor ?? "");
  const child = Number(match?.groups?.child);
  const offset = Number(match?.groups?.offset);
  if (
    !match?.groups ||
    !Number.isSafeInteger(child) ||
    !Number.isSafeInteger(offset)
  ) {
    return null;
  }
  return { child, fingerprint: match.groups.fingerprint ?? "", offset };
};

/**
 * Generic JSON-LD connector: discover() enumerates detail-page URLs from either a
 * sitemap or a listing page (bounded, single pass -- hasMore is always false, matching
 * the CTM connector's non-paginated feed pattern), and fetch() retrieves each detail
 * page and extracts its JobPosting JSON-LD node plus any configured label-block fields.
 *
 * A `sitemap-index` source that sets `discovery.batchSize` pages instead: each
 * discover() emits at most that many items and checkpoints its corpus position,
 * so the run loop's per-page checkpoint survives an abort or durable retry
 * mid-corpus. Child sitemap reads stay sequential under the run's shared host
 * limiter — resumability comes from bounded pages, not connector parallelism.
 */
export const createJsonLdConnector = (
  options: JsonLdConnectorOptions
): Connector => {
  const { config } = options;
  const client = options.client ?? createJsonLdClient({ config });
  const { knownHashes } = options;

  const batchSize =
    config.discovery.kind === "sitemap-index"
      ? config.discovery.batchSize
      : undefined;
  const sitemapIndexPager =
    batchSize !== undefined &&
    client.fetchSitemapIndex !== undefined &&
    client.fetchSitemapChild !== undefined
      ? ({
          batchSize,
          fetchChild: client.fetchSitemapChild,
          fetchIndex: client.fetchSitemapIndex,
        } satisfies SitemapIndexPager)
      : undefined;
  if (batchSize !== undefined) {
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new Error(
        `${config.slug} discovery.batchSize must be a positive integer`
      );
    }
    if (sitemapIndexPager === undefined) {
      throw new Error(
        `${config.slug} discovery.batchSize requires a client exposing fetchSitemapIndex/fetchSitemapChild`
      );
    }
  }

  // The index snapshot and per-child corpus walked by the current run. Held in
  // memory only: a run resumed in a fresh process re-reads the index and the
  // child holding its cursor position, and the fingerprint decides whether the
  // recorded position still addresses the same corpus.
  let indexSnapshot: { children: string[]; fingerprint: string } | null = null;
  const childCorpusCache = new Map<string, JsonLdDiscoveryUrl[]>();
  let emittedUrls = new Set<string>();

  const toDiscoverItem = async (
    entry: JsonLdDiscoveryUrl
  ): Promise<DiscoverItem> => ({
    bronReferentie: urlSlugBronReferentie(entry.url),
    contentHash: await hashJsonLdListingItem(entry),
    listingPayload: entry,
  });

  /** One bounded page of the selected sitemap-index corpus. A child sitemap
   * read that fails aborts the whole discover: the persisted checkpoint then
   * still points at this page's start and the durable retry re-reads it. */
  const discoverSitemapIndexBatch = async (
    checkpoint: ConnectorCheckpoint | null,
    pager: SitemapIndexPager,
    signal?: AbortSignal
  ): Promise<ConnectorDiscoverResult> => {
    const parsed = readSitemapIndexPosition(checkpoint);
    if (
      indexSnapshot === null ||
      parsed === null ||
      parsed.fingerprint !== indexSnapshot.fingerprint
    ) {
      const children = await pager.fetchIndex(signal);
      const digest = await hashContent(
        new TextEncoder().encode(children.join("\n"))
      );
      indexSnapshot = {
        children,
        fingerprint: digest.slice(0, SITEMAP_INDEX_FINGERPRINT_HEX),
      };
    }
    const { children, fingerprint } = indexSnapshot;
    const resume = parsed !== null && parsed.fingerprint === fingerprint;
    if (!resume) {
      // A fresh walk drops cached child pages so a child whose contents changed
      // since the previous run is re-read; cross-child dedupe restarts too.
      emittedUrls = new Set();
      childCorpusCache.clear();
    }
    let child = resume ? Math.min(parsed.child, children.length) : 0;
    let offset = resume ? parsed.offset : 0;
    const batch: JsonLdDiscoveryUrl[] = [];
    while (batch.length < pager.batchSize && child < children.length) {
      const childUrl = children[child];
      if (childUrl === undefined) {
        break;
      }
      let entries = childCorpusCache.get(childUrl);
      if (!entries) {
        // oxlint-disable-next-line no-await-in-loop -- corpus order is sequential by contract
        const childEntries = await pager.fetchChild(childUrl, signal);
        entries = applyExcludes(
          dedupeUrls(childEntries),
          config.excludePatterns
        );
        childCorpusCache.set(childUrl, entries);
      }
      while (offset < entries.length && batch.length < pager.batchSize) {
        const entry = entries[offset];
        offset += 1;
        if (entry === undefined || emittedUrls.has(entry.url)) {
          continue;
        }
        batch.push(entry);
      }
      if (offset >= entries.length) {
        child += 1;
        offset = 0;
      }
    }
    const items = await Promise.all(batch.map(toDiscoverItem));
    // Commit only once the page is fully assembled: the run loop retries a
    // failed discover() on this same connector instance, and a partially
    // committed dedupe set would make the retried page silently skip the
    // items it had already buffered — dropping them from a run that still
    // completes `complete: true` and can tombstone live records.
    for (const entry of batch) {
      emittedUrls.add(entry.url);
    }
    return {
      checkpoint: sitemapIndexCheckpoint(fingerprint, child, offset),
      hasMore: child < children.length,
      items,
    };
  };

  return {
    bronId: options.bronId,
    discover: async (
      checkpoint: ConnectorCheckpoint | null,
      signal?: AbortSignal
    ): Promise<ConnectorDiscoverResult> => {
      if (sitemapIndexPager !== undefined) {
        return await discoverSitemapIndexBatch(
          checkpoint,
          sitemapIndexPager,
          signal
        );
      }
      const urls = await client.fetchListing(signal);
      const items: DiscoverItem[] = await Promise.all(urls.map(toDiscoverItem));
      return {
        checkpoint: {},
        hasMore: false,
        items,
      };
    },
    fetch: async (item, signal) => {
      // SAFETY: discover() attaches JsonLdDiscoveryUrl rows as listingPayload.
      const entry = item.listingPayload as { url?: string } | undefined;
      if (!entry?.url) {
        return {
          bronReferentie: item.bronReferentie,
          reason: "listing payload missing url",
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

      let detail;
      try {
        detail = await client.fetchDetail(entry.url, signal);
      } catch (error) {
        // Replay-scope skip: the audit scripts configure the fixture client
        // with `onMissingDetailFixture: "skip"` so discovered URLs without a
        // committed detail fixture count as skipped, never as errors.
        if (error instanceof MissingDetailFixtureError) {
          return null;
        }
        // A URL in the source's own sitemap can already be gone: reject that
        // item instead of failing the whole run (CTP-608: one dead
        // datajobs.nl detail URL was killing every 244-item poll).
        const gone =
          (error instanceof HttpStatusError && error.status === 404) ||
          error instanceof NotFoundFault;
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
          reason: "no JobPosting JSON-LD found on detail page",
          status: "rejected" as const,
        };
      }

      const payload: JsonLdFetchedPayload = {
        jobPosting: detail.jobPosting,
        labelBlock: detail.labelBlock,
        parserVersion: config.parserVersion,
        slug: config.slug,
        url: entry.url,
      };
      if (detail.contactpersonen && detail.contactpersonen.length > 0) {
        payload.contactpersonen = detail.contactpersonen;
      }
      const body = new TextEncoder().encode(JSON.stringify(payload));
      const contentHash = await hashJsonLdPayload(body);
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
