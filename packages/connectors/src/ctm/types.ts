import type { SourceContact } from "../contract";

export interface CtmCpvCode {
  code: string;
  name?: string;
}

export interface CtmEntry {
  aanvraagnummer: string;
  /** CTP-610: the publication's <contactPerson> block (name, email, phone).
   * Absent when the feed leaves every attribute empty, as most CTM entries
   * do. */
  contactpersonen?: SourceContact[];
  cpv?: CtmCpvCode[];
  link: string;
  organisatie?: string;
  procedure?: string;
  publicatiedatum?: string;
  referentie?: string;
  sluitingstijd?: string;
  titel: string;
}

export interface CtmListingPage {
  entries: CtmEntry[];
  updatedAt?: string;
}

export interface CtmFetchedPayload {
  entry: CtmEntry;
}

export const CTM_PARSER_VERSION = "ctm/v2" as const;

export const CTM_FEED_PATH = "/ctm/rss/Rss.ashx";
