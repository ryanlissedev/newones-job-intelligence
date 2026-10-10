import { hashContent } from "../object-store";
import type { FreelancerNlListingItem } from "./types";

export const hashFreelancerNlListingItem = (
  item: FreelancerNlListingItem
): Promise<string> =>
  hashContent(
    new TextEncoder().encode(
      JSON.stringify({
        bronReferentie: item.bronReferentie,
        budget: item.budget ?? null,
        geplaatst: item.geplaatst ?? null,
        locatie: item.locatie ?? null,
        reacties: item.reacties ?? null,
        titel: item.titel,
        url: item.url,
      })
    )
  );

export const hashFreelancerNlPayload = (body: Uint8Array): Promise<string> =>
  hashContent(body);
