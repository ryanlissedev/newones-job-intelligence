import type { JsonLdNode } from "../json-ld/types";

/**
 * Opdrachtoverheid is an AGGREGATOR of other brokers (RJC-360 probe,
 * 2026-08-31): every tender carries `tender_source` / `tender_url` pointing
 * back at the originating site (e.g. Harvey Nash, or a municipal
 * "<gemeente>huurtin" portal). Both fields are kept in `bronSpecifiek` so the
 * application layer can cross-source dedup against the original listing.
 */
export interface OpdrachtoverheidLocationDetail {
  company_address?: string;
  company_display_name?: string;
  province?: string;
}

export interface OpdrachtoverheidEducationLevel {
  education_level_label?: string | null;
  id?: number | null;
}

export interface OpdrachtoverheidTender {
  tender_id: string;
  web_key: string;
  tender_name: string;
  tender_buying_organization?: string | null;
  tender_source?: string | null;
  tender_url?: string | null;
  opdracht_overheid_url?: string | null;
  tender_job_location?: string | null;
  organization_location?: OpdrachtoverheidLocationDetail | null;
  vacancies_location?: OpdrachtoverheidLocationDetail | null;
  tender_min_hours?: number | null;
  tender_max_hours?: number | null;
  tender_hours_week?: string | null;
  tender_maximum_tariff?: number | null;
  /** Free-text tariff fallback, e.g. `"95"`, `"€70"`, `"maximaal 100"`,
   * `"106,50"`, `"Geen maximum"`. Confirmed live 2026-08-31: populated on
   * all 400 sampled records, including the 92 (23%) that also had a numeric
   * `tender_maximum_tariff` — this field is the superset. */
  tender_tariff?: string | null;
  tender_no_max_tariff?: boolean | null;
  contract_type?: string | null;
  tender_start_date?: string | null;
  tender_end_date?: string | null;
  tender_offline_date?: string | null;
  tender_first_seen?: string | null;
  tender_last_seen?: string | null;
  /** Lifecycle fields (RJC-360 rebuild, 2026-08-31): every record in the
   * recorded fixture carries `tender_status: "closed"` / `tender_active:
   * false` — the bron's own signal that the tender is no longer open. */
  tender_status?: string | null;
  tender_active?: boolean | null;
  remote_work_description?: string | null;
  /** Live-verified 2026-09-15 (CTP-526): the source's own level label
   * ("MBO"/"HBO"/"WO"), with `"Onbekend"` as its not-published marker. */
  education_level_obj?: OpdrachtoverheidEducationLevel | null;
  /** HTML block with a "Wensen" list of weighted requirement prose and a
   * "Competenties"/"Vaardigheden" list of tag-like competences; only the
   * latter is read downstream (CTP-526). */
  tender_competences?: string | null;
  /** The source's hybrid-work flag, rendered on the detail page as
   * "Hybride werken: Ja/Nee". */
  tender_hybrid_working?: boolean | null;
  extension_option_description?: string | null;
  tender_description?: string | null;
  tender_description_html?: string | null;
  tender_description_tk?: string | null;
  exclusive?: boolean | null;
}

/** Mirrors `isTenderNedListingOpen`: the bron's own closed signal takes
 * precedence over any date math. `tender_active === false` or
 * `tender_status === "closed"` (case-insensitive) both mean the bron
 * considers the tender closed, independent of `tender_offline_date`. */
export const isOpdrachtoverheidTenderOpen = (
  tender: Pick<OpdrachtoverheidTender, "tender_active" | "tender_status">
): boolean => {
  if (tender.tender_active === false) {
    return false;
  }
  if (tender.tender_status?.trim().toLowerCase() === "closed") {
    return false;
  }
  return true;
};

/** The observed shape of `POST /search`: a flat object keyed by
 * `negometrix_tenders` (confirmed by a live probe on 2026-08-31, see
 * `docs/sources/opdrachtoverheid.md`). Undocumented, private endpoint — this
 * shape can change without notice. */
export interface OpdrachtoverheidListingResponse {
  negometrix_tenders: OpdrachtoverheidTender[];
}

export interface OpdrachtoverheidFetchedPayload {
  tender: OpdrachtoverheidTender;
  /** Parsed JobPosting JSON-LD node from the SSR detail page, when the
   * documented fallback path was used to enrich the record. `null` when the
   * connector relied on the listing API alone (fixtures, or live runs that
   * skip the detail fetch). */
  jobPosting: JsonLdNode | null;
}

export const OPDRACHTOVERHEID_PARSER_VERSION = "opdrachtoverheid/v3" as const;

export const OPDRACHTOVERHEID_SEARCH_PATH = "/search";

/** Historical page size observed live; retained for the existing 400-record
 * snapshot budget. */
export const OPDRACHTOVERHEID_PAGE_SIZE = 25;

/** Existing row bound for one request. It preserves the prior 16 * 25 = 400
 * budget while avoiding unstable cumulative-limit pagination. */
export const OPDRACHTOVERHEID_MAX_PAGES = 16;

export const OPDRACHTOVERHEID_MAX_RECORDS =
  OPDRACHTOVERHEID_PAGE_SIZE * OPDRACHTOVERHEID_MAX_PAGES;

/** Byte bound for the private listing response before JSON parsing. This is
 * deliberately independent from the 400-record completeness bound because
 * upstream fields are not size constrained. */
export const OPDRACHTOVERHEID_MAX_LISTING_BODY_BYTES = 8 * 1024 * 1024;
