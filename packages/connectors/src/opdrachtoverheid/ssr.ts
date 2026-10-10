import { extractJobPosting } from "../json-ld/extract";
/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof -- This is the Nuxt `__NUXT_DATA__` (devalue) I/O boundary: the payload is an untyped slot array whose shape is only known after hydration, and `isTenderRecord` establishes the `OpdrachtoverheidTender` contract before anything leaves this module. */
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- the public sitemap and the Nuxt SSR payload are untrusted third-party boundaries and are narrowed here before projection. */
/**
 * Market-wide discovery for Opdrachtoverheid (CTP-601).
 *
 * The private `POST /search` API only ever returns a ~400-record slice that
 * live shows to be almost exclusively one municipality, while the public
 * sitemap lists every `/inhuuropdracht/` detail page across ~200
 * organisations. Each detail page is a Nuxt SSR page whose `#__NUXT_DATA__`
 * script carries the same tender record shape the private API returns (under
 * `pinia.vacancyStore.vacancies[0]`), plus a JobPosting JSON-LD block.
 *
 * Both parsers are regex-light and DOM-free: connectors run in worker
 * contexts without a DOM, and only tag boundaries need to be located.
 */
import type { JsonLdNode } from "../json-ld/types";
import type { OpdrachtoverheidTender } from "./types";

export const OPDRACHTOVERHEID_SITE_BASE_URL = "https://www.opdrachtoverheid.nl";
export const OPDRACHTOVERHEID_SITEMAP_PATH = "/sitemap.xml";
const DETAIL_PATH_PREFIX = "/inhuuropdracht/";

export interface OpdrachtoverheidSitemapEntry {
  detailUrl: string;
  /** Organisation slug from the detail path, e.g. `gemeente-rotterdam`. */
  organisatieSlug: string;
  /** Upstream `web_key` (UUID) — the last path segment of the detail URL. */
  webKey: string;
}

export interface OpdrachtoverheidDetailPage {
  jobPosting: JsonLdNode | null;
  /** The SSR tender record, or `null` when the page carried no usable
   * `#__NUXT_DATA__` vacancy (e.g. a soft-404 or a redesigned page). */
  tender: OpdrachtoverheidTender | null;
}

const LOC_ELEMENT = /<loc>(?<loc>[\s\S]*?)<\/loc>/gu;

const parseDetailPath = (
  detailUrl: string
): OpdrachtoverheidSitemapEntry | null => {
  let pathname: string;
  try {
    ({ pathname } = new URL(detailUrl));
  } catch {
    return null;
  }
  if (!pathname.startsWith(DETAIL_PATH_PREFIX)) {
    return null;
  }
  const segments = pathname.slice(DETAIL_PATH_PREFIX.length).split("/");
  const [organisatieSlug, , webKey] = segments;
  if (segments.length !== 3 || !organisatieSlug || !webKey) {
    return null;
  }
  return { detailUrl, organisatieSlug, webKey };
};

/** Every `/inhuuropdracht/<org>/<slug>/<web_key>` URL in the sitemap, in
 * document order, deduplicated on `webKey`. Non-tender pages (articles,
 * organisation pages, static pages) are ignored. */
export const parseOpdrachtoverheidSitemap = (
  xml: string
): OpdrachtoverheidSitemapEntry[] => {
  const seen = new Set<string>();
  const entries: OpdrachtoverheidSitemapEntry[] = [];
  for (const match of xml.matchAll(LOC_ELEMENT)) {
    const entry = parseDetailPath((match.groups?.loc ?? "").trim());
    if (entry && !seen.has(entry.webKey)) {
      seen.add(entry.webKey);
      entries.push(entry);
    }
  }
  return entries;
};

const NUXT_DATA_MARKER = 'id="__NUXT_DATA__"';
const SCRIPT_CLOSE = "</script>";
/** devalue encodes `undefined` as the index -1. */
const UNDEFINED_REF = -1;
const REF_WRAPPERS = new Set([
  "Ref",
  "ShallowRef",
  "Reactive",
  "ShallowReactive",
]);
/** A hostile or broken payload must not recurse without bound. */
const MAX_HYDRATE_DEPTH = 32;

type DevalueValue = DevalueValue[] | Record<string, unknown> | unknown;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Resolves one devalue slot into a plain value. Only the wrapper shapes
 * Nuxt/Pinia emit for plain state are handled; anything else (Date, Map,
 * NaN markers, …) is returned as-is because the tender record is plain JSON. */
const hydrate = (
  values: readonly DevalueValue[],
  index: unknown,
  depth: number
): unknown => {
  if (typeof index !== "number" || index === UNDEFINED_REF) {
    return undefined;
  }
  if (depth > MAX_HYDRATE_DEPTH) {
    return undefined;
  }
  const value = values[index];
  if (Array.isArray(value)) {
    const [head, ...rest] = value;
    if (typeof head === "string" && REF_WRAPPERS.has(head)) {
      return hydrate(values, rest[0], depth + 1);
    }
    if (head === "Set") {
      return rest.map((entry) => hydrate(values, entry, depth + 1));
    }
    return value.map((entry) => hydrate(values, entry, depth + 1));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = hydrate(values, entry, depth + 1);
    }
    return out;
  }
  return value;
};

const extractNuxtData = (html: string): readonly DevalueValue[] | null => {
  const markerIndex = html.indexOf(NUXT_DATA_MARKER);
  if (markerIndex === -1) {
    return null;
  }
  const start = html.indexOf(">", markerIndex);
  const end = html.indexOf(SCRIPT_CLOSE, start);
  if (start === -1 || end === -1) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(html.slice(start + 1, end));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const isTenderRecord = (value: unknown): value is OpdrachtoverheidTender =>
  isRecord(value) &&
  typeof value.tender_id === "string" &&
  value.tender_id.trim().length > 0 &&
  typeof value.web_key === "string" &&
  value.web_key.trim().length > 0 &&
  typeof value.tender_name === "string";

/** `pinia.vacancyStore.vacancies[0]` of the hydrated Nuxt state, when it is a
 * tender record. The detail page store holds exactly the one vacancy being
 * shown (verified live 2026-09-17 on three organisations). */
export const extractOpdrachtoverheidSsrTender = (
  html: string
): OpdrachtoverheidTender | null => {
  const values = extractNuxtData(html);
  if (!values) {
    return null;
  }
  const root = hydrate(values, 0, 0);
  if (!isRecord(root) || !isRecord(root.pinia)) {
    return null;
  }
  const store = root.pinia.vacancyStore;
  if (!(isRecord(store) && Array.isArray(store.vacancies))) {
    return null;
  }
  const [first] = store.vacancies;
  return isTenderRecord(first) ? first : null;
};

/** Parses one SSR detail page. `detailUrl` is recorded as
 * `opdracht_overheid_url` when the SSR record does not carry it itself — the
 * page the record was read from is, by construction, its public URL. */
export const parseOpdrachtoverheidDetailPage = (
  html: string,
  detailUrl: string
): OpdrachtoverheidDetailPage => {
  const jobPosting = extractJobPosting(html);
  const ssrTender = extractOpdrachtoverheidSsrTender(html);
  const tender: OpdrachtoverheidTender | null = ssrTender
    ? {
        ...ssrTender,
        opdracht_overheid_url: ssrTender.opdracht_overheid_url ?? detailUrl,
      }
    : null;
  return { jobPosting, tender };
};
