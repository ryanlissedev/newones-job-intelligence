import { hashContent } from "../object-store";
import type { ProunityListingItem } from "./types";

export const hashProunityListingItem = (
  item: ProunityListingItem
): Promise<string> => {
  const canonical = JSON.stringify({
    lastmod: item.lastmod ?? null,
    url: item.url,
    uuid: item.uuid,
  });
  return hashContent(new TextEncoder().encode(canonical));
};

export const hashProunityPayload = (body: Uint8Array): Promise<string> =>
  hashContent(body);
