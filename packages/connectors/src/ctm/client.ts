/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- This is the CTM Atom/fast-xml-parser I/O boundary: parsed XML nodes arrive as `unknown` shapes (attributes vs. text nodes vs. omitted elements), so the string contract is established here. */
import { XMLParser, XMLValidator } from "fast-xml-parser";

import type { SourceContact } from "../contract";
import { resolveEgressFetch } from "../egress";
import { loadConnectorFixture } from "../fixtures/load";
import type { CtmCpvCode, CtmEntry, CtmListingPage } from "./types";
import { CTM_FEED_PATH } from "./types";

export interface CtmClient {
  fetchListing: () => Promise<CtmListingPage>;
}

export interface CtmClientOptions {
  baseUrl?: string;
  bulletin?: string;
  days?: number;
  fetchImpl?: typeof fetch;
  listingFixturePath?: string;
  liveEnabled?: boolean;
}

const DEFAULT_BASE_URL = "https://eu.eu-supply.com";
const DEFAULT_BULLETIN = "CTMSOLUTION";
const DEFAULT_DAYS = 30;

const parser = new XMLParser({
  attributeNamePrefix: "@_",
  ignoreAttributes: false,
  isArray: (name) => name === "entry" || name === "cpvCode",
  parseTagValue: false,
  textNodeName: "#text",
});

/** Atom entry ids look like `…rwlentrance_s.asp?PID=460057&PP=…`; PID is the stable reference. */
const PID_PATTERN = /[?&]PID=(?<pid>\d+)/u;

export const extractCtmAanvraagnummer = (entryId: string): string =>
  PID_PATTERN.exec(entryId)?.groups?.pid ?? entryId;

const asText = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return undefined;
};

const toCpvCodes = (value: unknown): CtmCpvCode[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const codes = value
    .map((raw) => {
      // SAFETY: fast-xml-parser attribute output for <cpvCode code="…" name="…" />.
      const record = raw as { "@_code"?: unknown; "@_name"?: unknown };
      const code = asText(record["@_code"]);
      if (!code) {
        return null;
      }
      const name = asText(record["@_name"]);
      return name ? { code, name } : { code };
    })
    .filter((entry): entry is CtmCpvCode => entry !== null);
  return codes.length > 0 ? codes : undefined;
};

interface ParsedCtmContactPerson {
  "@_firstName"?: unknown;
  "@_middleName"?: unknown;
  "@_lastName"?: unknown;
  "@_email"?: unknown;
  phone?: {
    "@_countryCode"?: unknown;
    "@_areaCode"?: unknown;
    // The feed's own attribute really is spelled "munber" (confirmed in
    // fixtures/connectors/ctm/listing-page-0.json's raw capture).
    "@_munber"?: unknown;
  };
}

interface ParsedCtmEntry {
  id?: string;
  link?: { "@_href"?: string };
  published?: string;
  title?: { "#text"?: string } | string;
  content?: {
    publication?: ParsedCtmPublication;
  };
}

interface ParsedCtmPublication {
  authority?: { "@_name"?: unknown };
  contactPerson?: ParsedCtmContactPerson;
  cpvCodes?: { cpvCode?: unknown };
  etq?: string;
  processTemplate?: string;
}

/** CTP-610: the publication's <contactPerson> element. Most CTM entries ship
 * it with every attribute empty; the contact is only emitted when at least one
 * of name/email/phone is actually populated. */
const toContactPerson = (
  raw: ParsedCtmContactPerson | undefined
): SourceContact | null => {
  if (!raw) {
    return null;
  }
  const naam = [
    asText(raw["@_firstName"]),
    asText(raw["@_middleName"]),
    asText(raw["@_lastName"]),
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ");
  const email = asText(raw["@_email"]);
  const { phone } = raw;
  const telefoon = [
    asText(phone?.["@_countryCode"]),
    asText(phone?.["@_areaCode"]),
    asText(phone?.["@_munber"]),
  ]
    .filter((part): part is string => part !== undefined)
    .join("");
  if (!(naam || email || telefoon)) {
    return null;
  }
  return {
    email: email ?? null,
    naam: naam || null,
    telefoon: telefoon || null,
  };
};

const applyPublicationFields = (
  ctmEntry: CtmEntry,
  publication: ParsedCtmPublication | undefined
): void => {
  const organisatie = asText(publication?.authority?.["@_name"]);
  if (organisatie) {
    ctmEntry.organisatie = organisatie;
  }
  if (publication?.etq) {
    ctmEntry.sluitingstijd = publication.etq;
  }
  if (publication?.processTemplate) {
    ctmEntry.procedure = publication.processTemplate;
  }
  const cpv = toCpvCodes(publication?.cpvCodes?.cpvCode);
  if (cpv) {
    ctmEntry.cpv = cpv;
  }
  const contactPerson = toContactPerson(publication?.contactPerson);
  if (contactPerson) {
    ctmEntry.contactpersonen = [contactPerson];
  }
};

const toCtmEntry = (raw: unknown): CtmEntry | null => {
  // SAFETY: Atom entry shape per eu-supply CTM feed sample (see docs/sources/ctm.md).
  const entry = raw as ParsedCtmEntry;
  const id = asText(entry.id);
  const titel =
    typeof entry.title === "string"
      ? entry.title
      : asText(entry.title?.["#text"]);
  if (!(id && titel)) {
    return null;
  }

  const ctmEntry: CtmEntry = {
    aanvraagnummer: extractCtmAanvraagnummer(id),
    link: asText(entry.link?.["@_href"]) ?? id,
    referentie: id,
    titel,
  };
  const publicatiedatum = asText(entry.published);
  if (publicatiedatum) {
    ctmEntry.publicatiedatum = publicatiedatum;
  }
  applyPublicationFields(ctmEntry, entry.content?.publication);
  return ctmEntry;
};

/** Parses the public CTM/EU-Supply Atom feed into typed entries. Throws on malformed XML. */
export const parseCtmFeed = (xml: string): CtmListingPage => {
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new Error(`Malformed CTM feed XML: ${validation.err.msg}`);
  }
  // SAFETY: XMLValidator confirmed well-formed XML above; shape is asserted per the Atom feed contract.
  const parsed = parser.parse(xml) as {
    feed?: { entry?: unknown[]; updated?: string };
  };
  const rawEntries = parsed.feed?.entry ?? [];
  const entries = rawEntries
    .map(toCtmEntry)
    .filter((entry): entry is CtmEntry => entry !== null);

  const listing: CtmListingPage = { entries };
  const updatedAt = asText(parsed.feed?.updated);
  if (updatedAt) {
    listing.updatedAt = updatedAt;
  }
  return listing;
};

export const createCtmClient = (options: CtmClientOptions = {}): CtmClient => {
  const fetchImpl = options.fetchImpl ?? resolveEgressFetch("ctm");
  const liveEnabled = options.liveEnabled ?? process.env.CTM_LIVE === "1";
  const listingFixturePath =
    options.listingFixturePath ?? "ctm/listing-page-0.json";
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const bulletin = options.bulletin ?? DEFAULT_BULLETIN;
  const days = options.days ?? DEFAULT_DAYS;

  return {
    fetchListing: async () => {
      if (!liveEnabled) {
        const fixture =
          await loadConnectorFixture<CtmListingPage>(listingFixturePath);
        return fixture.payload;
      }
      const url = `${baseUrl}${CTM_FEED_PATH}?days=${days}&b=${bulletin}`;
      const response = await fetchImpl(url);
      if (!response.ok) {
        throw new Error(
          `CTM feed request failed with status ${response.status}`
        );
      }
      return parseCtmFeed(await response.text());
    },
  };
};
