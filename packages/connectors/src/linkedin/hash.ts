import { hashContent } from "../object-store";
import type { LinkedinListingItem } from "./types";

export const hashLinkedinListingItem = (
  item: LinkedinListingItem
): Promise<string> =>
  hashContent(
    new TextEncoder().encode(
      JSON.stringify({
        bronReferentie: item.bronReferentie,
        geplaatst: item.geplaatst ?? null,
        jobId: item.jobId,
        locatie: item.locatie ?? null,
        opdrachtgever: item.opdrachtgever ?? null,
        titel: item.titel,
        url: item.url,
      })
    )
  );

export const hashLinkedinPayload = (body: Uint8Array): Promise<string> =>
  hashContent(body);
