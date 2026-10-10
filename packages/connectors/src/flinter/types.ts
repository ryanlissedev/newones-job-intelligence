/** Flinter (www.flinter.nl) is a custom SSR site with a single `/opdrachten`
 * listing (no pagination, no JSON-LD anywhere -- confirmed live 2026-08-31)
 * and plain SSR detail pages at `/opdrachten/<slug>`. Field mapping recorded
 * in docs/sources/flinter.md.
 *
 * tarief, startdatum and sluitingsdatum are genuinely ABSENT at this source
 * -- not a parsing gap. The listing/detail pages never render a rate, a
 * start date, or an application deadline anywhere (confirmed against a live
 * capture of all 18 listed assignments); normalise/flinter.ts must resolve
 * all three to UNKNOWN rather than inferring them from prose. */
export interface FlinterListingItem {
  /** URL path segment from the card's "Lees meer" link, e.g.
   * "vergunningverlener-agrarisch". The only stable identifier Flinter
   * exposes -- there is no numeric id. */
  slug: string;
  titel: string;
  /** First `<li>` in the card's icon list. */
  locatiePlaats?: string;
  /** Second `<li>`: a coarse duration string ("1 jr", ">1 jr", "6 mnd") --
   * kept as text per docs/sources/flinter.md, never converted to months. */
  looptijdTekst?: string;
  /** Third `<li>`: the hiring organisation ("eindklant"). */
  opdrachtgeverNaam?: string;
  /** RJC-375 field-order guard: true when `looptijdTekst` (the middle icon
   * row) matches the expected looptijd duration format, false when it does
   * not (the card is then rejected by the connector rather than ingested
   * with possibly-swapped fields -- see isFlinterLooptijdDuration in
   * client.ts). Only `parseFlinterListing` sets this field; it is left
   * undefined on hand-built listing items (as in tests exercising other
   * rejection paths) so the guard never interferes with payloads it did
   * not itself parse. */
  looptijdValid?: boolean;
}

export interface FlinterDetail {
  slug: string;
  titel: string;
  /** Sanitised HTML from `.vacancy-show-job-description` +
   * `.vacancy-show-function-description` -- the recruiter contact block
   * (`.vacancy-show-aside`, name/email/phone) is never read or kept. */
  beschrijvingHtml: string;
  /** Extracted only when a single unambiguous "<n> uur p/w" / "<n> uur per
   * week" phrase appears in the function-description's free text; UNKNOWN
   * (via normalise/flinter.ts) otherwise. Never guessed from a range or
   * multiple candidates. */
  urenPerWeek?: string;
  /** True when the detail page reads as a permanent-employment vacancy
   * (salaried "dienstverband", not a temporary assignment) rather than an
   * interim opdracht -- see isFlinterPermanentVacancy in client.ts and
   * docs/sources/flinter.md risk 3. The connector rejects these instead of
   * ingesting them as an aanvraag. */
  isPermanentVacancy: boolean;
}

export interface FlinterFetchedPayload {
  listing: FlinterListingItem;
  detail: FlinterDetail;
}

export const FLINTER_PARSER_VERSION = "flinter/v1" as const;

export const FLINTER_OPDRACHTEN_PATH = "/opdrachten";
