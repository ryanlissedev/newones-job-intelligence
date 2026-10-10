import { hashContent } from "../object-store";
import type { NeedstaffingListingItem } from "./types";

export const hashNeedstaffingListingItem = (
  item: NeedstaffingListingItem
): Promise<string> => {
  const canonical = JSON.stringify({
    deadline: item.deadline ?? null,
    id: item.id,
    locatie: item.locatie ?? null,
    opdrachtgeverNaam: item.opdrachtgeverNaam ?? null,
    periode: item.periode ?? null,
    start: item.start ?? null,
    tarief: item.tarief ?? null,
    titel: item.titel,
    uren: item.uren ?? null,
    werkvorm: item.werkvorm ?? null,
  });
  return hashContent(new TextEncoder().encode(canonical));
};

export const hashNeedstaffingPayload = (body: Uint8Array): Promise<string> =>
  hashContent(body);
