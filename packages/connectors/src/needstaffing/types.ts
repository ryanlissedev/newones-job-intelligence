import type { SourceContact } from "../contract";

export interface NeedstaffingInfoFields {
  deadline?: string;
  locatie?: string;
  periode?: string;
  start?: string;
  tarief?: string;
  uren?: string;
  /** Derived from the same "Locatie" icon field, not a separate icon --
   * confirmed live 2026-09-16 (joborder 15599: "Den Haag/Hybride"; wider
   * listing capture also shows "<stad> (<toelichting>)" shapes like
   * "Maasland (volledig op locatie)"). See splitNeedstaffingLocatie in
   * client.ts. */
  werkvorm?: string;
}

/** Lightweight listing-row snapshot used for hashing/dedup before a detail fetch. */
export interface NeedstaffingListingItem extends NeedstaffingInfoFields {
  id: string;
  opdrachtgeverNaam?: string;
  titel: string;
}

export interface NeedstaffingListingPage {
  hasNextPage: boolean;
  items: NeedstaffingListingItem[];
}

/** Typed fields scraped from the detail page (`/Opdrachten/{id}`). */
export interface NeedstaffingDetail extends NeedstaffingInfoFields {
  id: string;
  /** Plain-text `<li>` items from the vacancy body's `<h2>Competenties</h2>`
   * list -- confirmed live 2026-09-16 (joborder 15599: "Eigenaarschap",
   * "Overtuigingskracht", "Inhoudelijke scherpte", "Analytisch sterk").
   * Absent when the detail page has no Competenties section. */
  competenties?: string[];
  /** CTP-610: the `.vacancy-contact-info` block is a real contact channel
   * published for aanbieders (name + mailto/tel links). It stays out of
   * `raw.html` (that field is description-only by contract) and is folded
   * here instead. Committed fixtures carry no block (mechanically
   * stripped), so populated entries only flow from live captures. */
  contactpersonen?: SourceContact[];
  referentie?: string;
  tariefMax?: string;
  tariefMin?: string;
  titel: string;
}

export interface NeedstaffingFetchedPayload {
  detail: NeedstaffingDetail;
  listing: NeedstaffingListingItem;
  /** Sanitised vacancy-description HTML (scripts/styles/contact-CTA stripped). */
  raw: { html: string };
}

export const NEEDSTAFFING_PARSER_VERSION = "needstaffing/v5" as const;

export const NEEDSTAFFING_OPDRACHTEN_PATH = "/Opdrachten";

/** ponytail: bounded pagination ceiling (site volume ~63 ⇒ ~4 pages of 20);
 * raise if listing volume grows past ~400. */
export const NEEDSTAFFING_MAX_LISTING_PAGES = 20;

/** Joborders with a committed detail recording: 15520, the one row of the
 * default `listing-page-0.json` (2026-08-31, truncated body -- the honesty
 * case in the normalise specs), plus every row of
 * `listing-live-2026-09-16.json`. Recorded
 * with `bun tools/fixtures/record.ts --source needstaffing --name detail-<id>`. */
export const NEEDSTAFFING_DETAIL_FIXTURES: Record<string, string> =
  Object.fromEntries(
    [
      "15520",
      "15574",
      "15581",
      "15582",
      "15583",
      "15584",
      "15585",
      "15586",
      "15587",
      "15588",
      "15589",
      "15590",
      "15591",
      "15593",
      "15594",
      "15596",
      "15597",
      "15598",
      "15599",
      "15600",
      "15601",
    ].map((id) => [id, `needstaffing/detail-${id}.json`])
  );
