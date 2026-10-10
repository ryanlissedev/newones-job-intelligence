import { hashContent } from "../object-store";
import type { JsonLdDiscoveryUrl } from "./types";

/**
 * Listing-tier hash of a sitemap row. A connector that skips unchanged
 * lastmods passes its parser version, so a parser bump re-fetches every page
 * once instead of leaving them on the old extraction until lastmod moves.
 */
export const hashJsonLdListingItem = (
  item: JsonLdDiscoveryUrl,
  parserVersion?: string
): Promise<string> =>
  hashContent(
    new TextEncoder().encode(
      JSON.stringify(
        parserVersion === undefined
          ? { lastmod: item.lastmod ?? null, url: item.url }
          : { lastmod: item.lastmod ?? null, parserVersion, url: item.url }
      )
    )
  );

export const hashJsonLdPayload = (body: Uint8Array): Promise<string> =>
  hashContent(body);
