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
  buildProunityRawHtml,
  createProunityClient,
  parseProunityDetail,
} from "./client";
import type { ProunityClient } from "./client";
import { hashProunityListingItem, hashProunityPayload } from "./hash";
import type { ProunityFetchedPayload, ProunityListingItem } from "./types";

export interface ProunityConnectorOptions {
  bronId: BronId;
  client?: ProunityClient;
  knownHashes?: KnownHashStore;
}

/**
 * ProUnity (HeadFirst Group, BE) connector: sitemap-driven discovery
 * (`sitemap.xml` → `pji_job-sitemap*.xml` children → `/job/<uuid>/` URLs,
 * including history) + SSR detail extraction. Detail pages carry no
 * JobPosting JSON-LD (only BreadcrumbList/WebPage, verified live
 * 2026-09-18), so fields come from `.post-content` markup: `h2.fusion-post-title`,
 * `span.putag`, `.job__infobar` spans, `.job h6`+`.tags` requirement lists
 * and `div.richtext` for the description. Single-pass discover, matching the
 * json-ld family's non-paginated sitemap pattern.
 */
export const createProunityConnector = (
  options: ProunityConnectorOptions
): Connector => {
  const client = options.client ?? createProunityClient();
  const { knownHashes } = options;

  return {
    bronId: options.bronId,
    discover: async (
      _checkpoint: ConnectorCheckpoint | null
    ): Promise<ConnectorDiscoverResult> => {
      const listing = await client.fetchListing();
      const items: DiscoverItem[] = await Promise.all(
        listing.map(async (entry) => ({
          bronReferentie: entry.uuid,
          contentHash: await hashProunityListingItem(entry),
          listingPayload: entry,
        }))
      );
      return {
        checkpoint: {},
        hasMore: false,
        items,
      };
    },
    fetch: async (item) => {
      // SAFETY: discover() attaches parsed Prounity sitemap rows as listingPayload.
      const listing = item.listingPayload as ProunityListingItem | undefined;
      if (!(listing?.uuid && listing.url)) {
        return {
          bronReferentie: item.bronReferentie,
          reason: "listing payload missing uuid/url",
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

      const detailHtml = await client.fetchDetailHtml(listing.uuid);
      const detail = await parseProunityDetail(detailHtml, listing.uuid);
      if (!detail.titel) {
        return {
          bronReferentie: item.bronReferentie,
          reason: "detail page missing titel",
          status: "rejected" as const,
        };
      }

      // DEC-008: rebuild the payload naming every field — unlisted upstream
      // markup must not reach the stored body.
      const payload: ProunityFetchedPayload = {
        detail: {
          applyUrl: detail.applyUrl,
          duur: detail.duur,
          land: detail.land,
          periode: detail.periode,
          referentie: detail.referentie,
          roles: detail.roles,
          skills: detail.skills,
          talen: detail.talen,
          titel: detail.titel,
          uuid: detail.uuid,
        },
        listing: {
          lastmod: listing.lastmod,
          url: listing.url,
          uuid: listing.uuid,
        },
        raw: { html: buildProunityRawHtml(detailHtml) },
      };
      const body = new TextEncoder().encode(JSON.stringify(payload));
      const contentHash = await hashProunityPayload(body);
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
