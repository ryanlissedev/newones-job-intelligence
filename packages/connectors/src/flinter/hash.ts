import { hashContent } from "../object-store";
import type { FlinterListingItem } from "./types";

export const hashFlinterListingItem = (
  item: FlinterListingItem
): Promise<string> => {
  const canonical = JSON.stringify({
    locatiePlaats: item.locatiePlaats ?? null,
    looptijdTekst: item.looptijdTekst ?? null,
    opdrachtgeverNaam: item.opdrachtgeverNaam ?? null,
    slug: item.slug,
    titel: item.titel,
  });
  return hashContent(new TextEncoder().encode(canonical));
};

export const hashFlinterPayload = (body: Uint8Array): Promise<string> =>
  hashContent(body);
