import { hashContent } from "../object-store";
import type { MercellListingItem } from "./types";

/**
 * Canonical listing hash — covers every listing-visible field the normaliser
 * reads plus `ModifiedDate`, which bumps on any upstream edit and so forces a
 * detail re-fetch. It does NOT cover detail-only fields (EstimatedValue,
 * contact person, …): `listingHashCoversDetail` is false on the source
 * definition, so the known-hash store is never consulted for this bron.
 */
export const hashMercellListingItem = (
  item: MercellListingItem
): Promise<string> => {
  const canonical = JSON.stringify({
    deadline: item.Deadline ?? null,
    modifiedDate: item.ModifiedDate ?? null,
    opdrachtgever: item.OrganizationName ?? null,
    procedureType: item.ProcedureType ?? null,
    publicatieDatum: item.PublicationDate ?? null,
    specialNumber: item.SpecialNumber ?? null,
    status: item.Status ?? null,
    tenderId: item.TenderId,
    titel: item.TenderName,
  });
  return hashContent(new TextEncoder().encode(canonical));
};

export const hashMercellDetailPayload = (body: Uint8Array): Promise<string> =>
  hashContent(body);
