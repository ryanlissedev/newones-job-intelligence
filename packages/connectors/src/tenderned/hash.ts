import { hashContent } from "../object-store";
import type { TenderNedListingItem } from "./types";

export const hashTenderNedListingItem = (
  item: TenderNedListingItem
): Promise<string> => {
  const canonical = JSON.stringify({
    aankondigingCode: item.aankondigingCode?.code ?? null,
    kenmerk: item.kenmerk,
    numberOfDaysBeforeAanmeldenInschrijven:
      item.numberOfDaysBeforeAanmeldenInschrijven ?? null,
    publicatieDatum: item.publicatieDatum ?? null,
    publicatieId: item.publicatieId,
    titel: item.aanbestedingNaam,
  });
  return hashContent(new TextEncoder().encode(canonical));
};

export const hashTenderNedDetailPayload = (body: Uint8Array): Promise<string> =>
  hashContent(body);
