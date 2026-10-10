import type { SourceContact } from "../contract";
import { resolveEgressFetch } from "../egress";
import { loadConnectorFixture } from "../fixtures/load";
import { decodeHtmlEntities } from "../html-entities";
import type {
  NeedstaffingDetail,
  NeedstaffingInfoFields,
  NeedstaffingListingItem,
  NeedstaffingListingPage,
} from "./types";
import {
  NEEDSTAFFING_DETAIL_FIXTURES,
  NEEDSTAFFING_OPDRACHTEN_PATH,
} from "./types";

interface NeedstaffingRewriterElement {
  getAttribute: (name: string) => string | null;
}
interface NeedstaffingRewriterTextChunk {
  text: string;
}
interface NeedstaffingRewriterHandlers {
  element?: (element: NeedstaffingRewriterElement) => void;
  text?: (chunk: NeedstaffingRewriterTextChunk) => void;
}
interface NeedstaffingRewriter {
  on: (
    selector: string,
    handlers: NeedstaffingRewriterHandlers
  ) => NeedstaffingRewriter;
  transform: (response: Response) => Response;
}
type NeedstaffingRewriterConstructor = new () => NeedstaffingRewriter;

/**
 * Bun ships `HTMLRewriter` as a runtime global (typed by `@types/bun`), but
 * this package's source is consumed directly (via package.json `exports`) by
 * apps/web's own `tsc` run, which has no Bun ambient types configured — and
 * shouldn't gain them, since web itself doesn't run on Bun. Reading it off
 * `globalThis` through a locally-scoped type (instead of the ambient
 * `HTMLRewriter` name) avoids a duplicate-global-declaration clash in builds
 * that DO have `@types/bun` loaded, while still type-checking cleanly in ones
 * that don't.
 *
 * Called lazily inside parseNeedstaffingListing/parseNeedstaffingDetail
 * (never at module scope): `normalise/needstaffing.ts` value-imports
 * `NEEDSTAFFING_PARSER_VERSION` from `@ji/connectors/needstaffing`, so a
 * module-scope call here would run — and throw on non-Bun runtimes — the
 * moment any Node/Next process imports the normaliser, even without ever
 * parsing HTML.
 */
const readGlobalNeedstaffingRewriter = (): NeedstaffingRewriterConstructor => {
  // SAFETY: probing globalThis for a Bun-only ambient IS the I/O boundary —
  // there is no narrower source type to parse this from.
  const candidate = (globalThis as { HTMLRewriter?: unknown }).HTMLRewriter;
  // This typeof check is the I/O-boundary parse itself: narrowing an ambient
  // global we don't control to "callable or not" before use (same pattern as
  // ctm/client.ts's parsed-XML boundary).
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (typeof candidate !== "function") {
    throw new TypeError(
      "HTMLRewriter is not available on globalThis (this connector requires the Bun runtime)"
    );
  }
  // SAFETY: `typeof candidate === "function"` was just verified; Bun's real
  // HTMLRewriter constructor matches the narrowed shape this module calls.
  return candidate as NeedstaffingRewriterConstructor;
};

export interface NeedstaffingClient {
  fetchListing: (page: number) => Promise<NeedstaffingListingPage>;
  /** Returns the raw detail-page HTML; connector.ts derives both the typed
   * NeedstaffingDetail and the sanitised vacancy-text HTML from it. */
  fetchDetailHtml: (id: string) => Promise<string>;
}

export interface NeedstaffingClientOptions {
  baseUrl?: string;
  detailFixtures?: Record<string, string>;
  fetchImpl?: typeof fetch;
  listingFixturePath?: string;
  liveEnabled?: boolean;
}

const DEFAULT_BASE_URL = "https://www.needstaffing.nl";

/** HTMLRewriter text() chunks are NOT entity-decoded (confirmed against Bun
 * 1.3.14 and the live site, which serves numeric entities like `&#x20AC;` in
 * text nodes) — decode the handful this site actually uses. Decoding itself
 * is shared with flinter via `../html-entities` (RJC-374: both were
 * byte-identical copies with the same unguarded code-point ceiling). */
export const decodeNeedstaffingEntities = decodeHtmlEntities;

const ID_PATTERN = /\/Opdrachten\/(?<id>\d+)/u;

export const extractNeedstaffingId = (href: string): string | undefined =>
  ID_PATTERN.exec(href)?.groups?.id;

const REFERENTIE_PATTERN = /(?<ref>\d{4}-[A-Z]{2,6}-\d{3,6}[A-Z]?)\s*$/u;

export const extractNeedstaffingReferentie = (
  titel: string
): string | undefined => REFERENTIE_PATTERN.exec(titel)?.groups?.ref;

const TARIEF_BAND_PATTERN =
  /€\s*(?<min>\d+(?:[.,]\d+)?)(?:,\s*-)?\s*(?:-|\/)\s*€?\s*(?<max>\d+(?:[.,]\d+)?)(?:,\s*-)?/u;

const normalizeTariefAmount = (value: string): string =>
  value.replace(",", ".");

export const parseNeedstaffingTariefBand = (raw: string | undefined) => {
  const match = raw ? TARIEF_BAND_PATTERN.exec(raw) : null;
  const min = match?.groups?.min;
  const max = match?.groups?.max;
  if (!(min && max)) {
    return { max: undefined, min: undefined };
  }
  return { max: normalizeTariefAmount(max), min: normalizeTariefAmount(min) };
};

/** Icon `alt` text -> the info field it labels. Same repeated icon+text pattern
 * on both the listing cards and the detail page header. Map, not a Record
 * literal, so lookups by an arbitrary alt string stay type-safe without widening. */
const ALT_TO_FIELD = new Map<string, keyof NeedstaffingInfoFields>([
  ["Deadline voor reageren", "deadline"],
  ["Locatie", "locatie"],
  ["Verwacht aantal uren per week", "uren"],
  ["Verwachte compensatie", "tarief"],
  ["Verwachte periode", "periode"],
  ["Verwachte startdatum", "start"],
]);

/** Fields whose value we take from a `data-date-utc` epoch attribute instead of
 * the visible text (dd-mm-yyyy text is locale-formatted and lossy vs. the epoch). */
const DATE_EPOCH_FIELDS = new Set<keyof NeedstaffingInfoFields>([
  "deadline",
  "start",
]);

const TRIMMABLE_FIELDS = [
  "deadline",
  "locatie",
  "periode",
  "start",
  "tarief",
  "uren",
] as const;

const trimFields = <Item extends NeedstaffingInfoFields>(item: Item): Item => {
  const trimmed = { ...item };
  for (const key of TRIMMABLE_FIELDS) {
    const value = trimmed[key];
    if (value !== undefined) {
      // SAFETY: TRIMMABLE_FIELDS keys are all typed `string | undefined` on
      // NeedstaffingInfoFields, so a defined value here is always a string.
      trimmed[key] = decodeNeedstaffingEntities(
        value
      ).trim() as Item[typeof key];
    }
  }
  return trimmed;
};

/** The "Locatie" icon field carries both city and werkvorm in one string --
 * confirmed live 2026-09-16 across the current listing: a slash form
 * ("Leeuwarden/Hybride") and a trailing-parenthetical form ("Maasland
 * (volledig op locatie)", "Huis ter Heide (2 dagen op locatie)", "Utrecht
 * (op locatie)"). Both are structural delimiters around the same field, not
 * prose to mine -- split on them and keep the remainder verbatim as
 * werkvorm text (CTP-514 F07: "free text as published"). But the delimiter
 * alone isn't proof of werkvorm content: "Utrecht/Amersfoort" (two cities)
 * or "Amsterdam (Zuidas)" (a district) would otherwise misread as werkvorm
 * (advisor review). Gate the second half on a werkvorm keyword; when it
 * doesn't match, keep the whole string as locatie and leave werkvorm
 * undefined -- never a guess. Neither shape observed in the wider listing
 * capture -> same fallback. */
const LOCATIE_PAREN_PATTERN = /^(?<locatie>.*?)\s*\((?<werkvorm>[^)]+)\)\s*$/u;
const WERKVORM_KEYWORD_PATTERN =
  /hybride|remote|thuis|locatie|kantoor|afstand/iu;

export interface NeedstaffingLocatieSplit {
  locatie: string | undefined;
  werkvorm: string | undefined;
}

export const splitNeedstaffingLocatie = (
  raw?: string
): NeedstaffingLocatieSplit => {
  if (!raw) {
    return { locatie: raw, werkvorm: undefined };
  }
  const slashIndex = raw.indexOf("/");
  if (slashIndex !== -1) {
    const locatie = raw.slice(0, slashIndex).trim();
    const werkvorm = raw.slice(slashIndex + 1).trim();
    if (werkvorm && WERKVORM_KEYWORD_PATTERN.test(werkvorm)) {
      return { locatie: locatie || undefined, werkvorm };
    }
    return { locatie: raw, werkvorm: undefined };
  }
  const parenMatch = LOCATIE_PAREN_PATTERN.exec(raw);
  if (parenMatch?.groups?.locatie && parenMatch.groups.werkvorm) {
    const werkvorm = parenMatch.groups.werkvorm.trim();
    if (WERKVORM_KEYWORD_PATTERN.test(werkvorm)) {
      return { locatie: parenMatch.groups.locatie.trim(), werkvorm };
    }
    return { locatie: raw, werkvorm: undefined };
  }
  return { locatie: raw, werkvorm: undefined };
};

const applyLocatieWerkvormSplit = <Item extends NeedstaffingInfoFields>(
  item: Item
): Item => {
  const { locatie, werkvorm } = splitNeedstaffingLocatie(item.locatie);
  return { ...item, locatie, werkvorm: werkvorm ?? item.werkvorm };
};

const COMPETENTIES_HEADING_PATTERN = /<h2>\s*Competenties\s*<\/h2>\s*<ul>/iu;
const LIST_ITEM_PATTERN = /<li>(?<text>.*?)<\/li>/gsu;
const STRIP_TAGS_PATTERN = /<[^>]+>/gu;

/** Reads the vacancy body's `<h2>Competenties</h2>` list (structured,
 * contract-allowed -- CTP-514 F15 names "competenties" explicitly) into
 * plain skill strings. Confirmed live 2026-09-16, joborder 15599. Absent
 * heading/list -> empty array, never a guess. */
export const extractNeedstaffingCompetenties = (html: string): string[] => {
  const headingMatch = COMPETENTIES_HEADING_PATTERN.exec(html);
  if (!headingMatch) {
    return [];
  }
  const listStart = headingMatch.index + headingMatch[0].length;
  const listEnd = html.indexOf("</ul>", listStart);
  if (listEnd === -1) {
    return [];
  }
  const listHtml = html.slice(listStart, listEnd);
  const items: string[] = [];
  for (const match of listHtml.matchAll(LIST_ITEM_PATTERN)) {
    const text = decodeNeedstaffingEntities(
      (match.groups?.text ?? "").replaceAll(STRIP_TAGS_PATTERN, "")
    ).trim();
    if (text) {
      items.push(text);
    }
  }
  return items;
};

export const parseNeedstaffingListing = async (
  html: string
): Promise<NeedstaffingListingPage> => {
  const items: NeedstaffingListingItem[] = [];
  let current: Partial<NeedstaffingListingItem> | null = null;
  let pendingField: keyof NeedstaffingInfoFields | undefined;
  let hasNextPage = false;

  const finishCurrent = () => {
    if (current?.id && current.titel) {
      current.titel = decodeNeedstaffingEntities(current.titel).trim();
      // SAFETY: the guard above confirmed `id` and `titel` are set, the only
      // required fields of NeedstaffingListingItem.
      items.push(
        applyLocatieWerkvormSplit(
          trimFields(current as NeedstaffingListingItem)
        )
      );
    }
    current = null;
  };

  const rewriter = new (readGlobalNeedstaffingRewriter())()
    .on("div.vacancies-overview-item", {
      element: () => {
        finishCurrent();
        current = {};
      },
    })
    .on('div.vacancies-overview-item a[href^="/Opdrachten/"]', {
      element: (el) => {
        const href = el.getAttribute("href");
        const id = href ? extractNeedstaffingId(href) : undefined;
        if (current && id) {
          current.id = id;
        }
      },
    })
    .on(".vacancies-overview-item-logo img", {
      element: (el) => {
        const alt = el.getAttribute("alt");
        if (current && alt) {
          current.opdrachtgeverNaam = decodeNeedstaffingEntities(alt).trim();
        }
      },
    })
    .on(".vacancies-overview-item-summary h2", {
      text: (chunk) => {
        if (current) {
          current.titel = `${current.titel ?? ""}${chunk.text}`;
        }
      },
    })
    .on(".vacancies-overview-item-information-item", {
      // Reset before each info-item's own <img alt> (if any) is seen, so an
      // item with no recognised icon doesn't silently append its text onto
      // whatever field the PREVIOUS item last set.
      element: () => {
        pendingField = undefined;
      },
    })
    .on(".vacancies-overview-item-information-item img", {
      element: (el) => {
        const alt = el.getAttribute("alt");
        pendingField = alt ? ALT_TO_FIELD.get(alt) : undefined;
      },
    })
    .on(".vacancies-overview-item-information-item span[data-date-utc]", {
      element: (el) => {
        if (current && pendingField && DATE_EPOCH_FIELDS.has(pendingField)) {
          // oxlint-disable-next-line unicorn/prefer-dom-node-dataset -- Bun HTMLRewriter Element has no `.dataset`; getAttribute is the only accessor.
          const epoch = el.getAttribute("data-date-utc");
          if (epoch) {
            current[pendingField] = epoch;
          }
        }
      },
    })
    .on(".vacancies-overview-item-information-item p", {
      text: (chunk) => {
        if (current && pendingField && !DATE_EPOCH_FIELDS.has(pendingField)) {
          current[pendingField] = `${current[pendingField] ?? ""}${chunk.text}`;
        }
      },
    })
    .on(".vacancies-overview-pagination a", {
      element: (el) => {
        if (el.getAttribute("title") === "Volgende pagina") {
          hasNextPage = true;
        }
      },
    });

  await rewriter.transform(new Response(html)).text();
  finishCurrent();

  return { hasNextPage, items };
};

const VACANCY_TEXT_MARKER = '<div class="vacancy-text">';
const VACANCY_CONTACT_MARKER = '<div class="vacancy-contact-info">';

/** Grabs the balanced `div` opened by `marker` (depth-counted) and returns
 * its inner HTML. */
const extractBalancedDiv = (
  html: string,
  marker: string
): string | undefined => {
  const start = html.indexOf(marker);
  if (start === -1) {
    return;
  }
  const contentStart = start + marker.length;
  const tagPattern = /<\/?div\b[^>]*>/giu;
  tagPattern.lastIndex = contentStart;
  let depth = 1;
  let match = tagPattern.exec(html);
  while (match) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) {
      return html.slice(contentStart, match.index);
    }
    match = tagPattern.exec(html);
  }
};

const extractVacancyTextHtml = (html: string): string | undefined =>
  extractBalancedDiv(html, VACANCY_TEXT_MARKER);

const PARAGRAPH_PATTERN = /<p[^>]*>(?<inner>[\s\S]*?)<\/p>/giu;
const MAILTO_PATTERN = /href="mailto:(?<email>[^"?]+)/iu;
const TEL_PATTERN = /href="tel:(?<telefoon>[^"]+)/iu;
const TAG_PATTERN = /<[^>]+>/gu;

const stripTags = (html: string): string =>
  decodeNeedstaffingEntities(html.replaceAll(TAG_PATTERN, "")).trim();

/** CTP-610: reads the `.vacancy-contact-info` block (published for
 * aanbieders). Shape confirmed against the spec fixture: one `<p>` per
 * contact name plus `mailto:`/`tel:` links. Committed detail fixtures carry
 * no block (mechanically stripped), so this only yields contacts from live
 * captures. */
export const extractNeedstaffingContactpersonen = (
  html: string
): SourceContact[] | undefined => {
  const block = extractBalancedDiv(html, VACANCY_CONTACT_MARKER);
  if (!block) {
    return;
  }
  const naam =
    [...block.matchAll(PARAGRAPH_PATTERN)]
      .map((m) => stripTags(m.groups?.inner ?? ""))
      .find((name) => name.length > 0) ?? null;
  const email = MAILTO_PATTERN.exec(block)?.groups?.email?.trim();
  const telefoon = TEL_PATTERN.exec(block)?.groups?.telefoon?.trim();
  if (!(naam || email || telefoon)) {
    return;
  }
  return [{ email: email ?? null, naam, telefoon: telefoon ?? null }];
};

export const parseNeedstaffingDetail = async (
  html: string,
  id: string
): Promise<NeedstaffingDetail> => {
  const detail: Partial<NeedstaffingDetail> = { id };
  let pendingField: keyof NeedstaffingInfoFields | undefined;

  const rewriter = new (readGlobalNeedstaffingRewriter())()
    .on(".page-header-vacancy h1", {
      text: (chunk) => {
        detail.titel = `${detail.titel ?? ""}${chunk.text}`;
      },
    })
    .on(".page-header-vacancy-details-item", {
      // Same reset as the listing parser: an info-item with no recognised
      // icon must not inherit the previous item's field.
      element: () => {
        pendingField = undefined;
      },
    })
    .on(".page-header-vacancy-details-item img", {
      element: (el) => {
        const alt = el.getAttribute("alt");
        pendingField = alt ? ALT_TO_FIELD.get(alt) : undefined;
      },
    })
    .on(".page-header-vacancy-details-item span[data-date-utc]", {
      element: (el) => {
        if (pendingField && DATE_EPOCH_FIELDS.has(pendingField)) {
          // oxlint-disable-next-line unicorn/prefer-dom-node-dataset -- Bun HTMLRewriter Element has no `.dataset`; getAttribute is the only accessor.
          const epoch = el.getAttribute("data-date-utc");
          if (epoch) {
            detail[pendingField] = epoch;
          }
        }
      },
    })
    .on(".page-header-vacancy-details-item p", {
      text: (chunk) => {
        if (pendingField && !DATE_EPOCH_FIELDS.has(pendingField)) {
          detail[pendingField] = `${detail[pendingField] ?? ""}${chunk.text}`;
        }
      },
    });

  await rewriter.transform(new Response(html)).text();

  const titel = decodeNeedstaffingEntities(detail.titel ?? "").trim();
  // SAFETY: `id` was set at construction; the rewriter above only ever adds
  // the remaining NeedstaffingDetail fields.
  const trimmed = applyLocatieWerkvormSplit(
    trimFields(detail as NeedstaffingDetail)
  );
  const { min: tariefMin, max: tariefMax } = parseNeedstaffingTariefBand(
    trimmed.tarief
  );
  const competenties = extractNeedstaffingCompetenties(html);
  const contactpersonen = extractNeedstaffingContactpersonen(html);

  return {
    ...trimmed,
    competenties: competenties.length > 0 ? competenties : undefined,
    contactpersonen,
    id,
    referentie: extractNeedstaffingReferentie(titel),
    tariefMax,
    tariefMin,
    titel,
  };
};

const RESPOND_CTA_PATTERN = /<a[^>]*\/RESPOND"[^>]*>[\s\S]*?<\/a>/giu;
const SCRIPT_OR_STYLE_PATTERN = /<(?<tag>script|style)[\s\S]*?<\/\k<tag>>/giu;

const sanitizeNeedstaffingVacancyHtml = (html: string): string =>
  html
    .replaceAll(SCRIPT_OR_STYLE_PATTERN, "")
    .replaceAll(RESPOND_CTA_PATTERN, "")
    .trim();

/** Extracts and sanitises the description block from a raw detail-page HTML
 * string. Returns "" if the page has no recognisable vacancy-text block. */
export const buildNeedstaffingRawHtml = (detailHtml: string): string => {
  const vacancyText = extractVacancyTextHtml(detailHtml);
  return vacancyText ? sanitizeNeedstaffingVacancyHtml(vacancyText) : "";
};

export const createNeedstaffingClient = (
  options: NeedstaffingClientOptions = {}
): NeedstaffingClient => {
  const fetchImpl = options.fetchImpl ?? resolveEgressFetch("needstaffing");
  const liveEnabled =
    options.liveEnabled ?? process.env.NEEDSTAFFING_LIVE === "1";
  const listingFixturePath =
    options.listingFixturePath ?? "needstaffing/listing-page-0.json";
  const detailFixtures = options.detailFixtures ?? NEEDSTAFFING_DETAIL_FIXTURES;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;

  return {
    fetchDetailHtml: async (id) => {
      if (!liveEnabled) {
        const relativePath = detailFixtures[id];
        if (!relativePath) {
          throw new Error(`Missing Needstaffing detail fixture for ${id}`);
        }
        const fixture = await loadConnectorFixture<string>(relativePath);
        return fixture.payload;
      }
      const response = await fetchImpl(
        `${baseUrl}${NEEDSTAFFING_OPDRACHTEN_PATH}/${id}`
      );
      if (!response.ok) {
        throw new Error(
          `Needstaffing detail request failed with status ${response.status}`
        );
      }
      return await response.text();
    },
    fetchListing: async (page) => {
      if (!liveEnabled) {
        if (page > 0) {
          return { hasNextPage: false, items: [] };
        }
        const fixture = await loadConnectorFixture<string>(listingFixturePath);
        return parseNeedstaffingListing(fixture.payload);
      }
      const params = new URLSearchParams({
        PageNumber: String(page + 1),
        SortOrder: "NewestFirst",
      });
      const response = await fetchImpl(
        `${baseUrl}${NEEDSTAFFING_OPDRACHTEN_PATH}?${params.toString()}`
      );
      if (!response.ok) {
        throw new Error(
          `Needstaffing listing request failed with status ${response.status}`
        );
      }
      return parseNeedstaffingListing(await response.text());
    },
  };
};
