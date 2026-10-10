import { hashContent } from "../object-store";
import type { CtmEntry } from "./types";

/**
 * RJC-357/RJC-401: this listing hash covers EVERY `CtmEntry` field —
 * fetch() re-serialises the feed entry with no second request, so an
 * unchanged listing hash proves the whole payload (and everything the CTM
 * normaliser derives, `sluitingstijd` included) is unchanged. `link` was
 * added for that guarantee; keep this list in sync with `CtmEntry` or the
 * known-hash skip becomes unsafe (see docs/sources/ctm.md).
 */
export const hashCtmListingItem = (item: CtmEntry): Promise<string> => {
  const canonical = JSON.stringify({
    aanvraagnummer: item.aanvraagnummer,
    contactpersonen: item.contactpersonen ?? null,
    cpv: item.cpv ?? null,
    link: item.link,
    organisatie: item.organisatie ?? null,
    procedure: item.procedure ?? null,
    publicatiedatum: item.publicatiedatum ?? null,
    referentie: item.referentie ?? null,
    sluitingstijd: item.sluitingstijd ?? null,
    titel: item.titel,
  });
  return hashContent(new TextEncoder().encode(canonical));
};

export const hashCtmPayload = (body: Uint8Array): Promise<string> =>
  hashContent(body);
