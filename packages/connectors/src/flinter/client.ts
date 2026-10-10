import { resolveEgressFetch } from "../egress";
import { loadConnectorFixture } from "../fixtures/load";
import { decodeHtmlEntities } from "../html-entities";
import type { FlinterDetail, FlinterListingItem } from "./types";
import { FLINTER_OPDRACHTEN_PATH } from "./types";

export interface FlinterClient {
  fetchListing: () => Promise<FlinterListingItem[]>;
  fetchDetailHtml: (slug: string) => Promise<string>;
}

export interface FlinterClientOptions {
  baseUrl?: string;
  detailFixtures?: Record<string, string>;
  fetchImpl?: typeof fetch;
  listingFixturePath?: string;
  liveEnabled?: boolean;
}

const DEFAULT_BASE_URL = "https://www.flinter.nl";

/** Same numeric/named-entity gap as needstaffing's HTMLRewriter text nodes,
 * but here we parse raw response text with regex, not a rewriter -- entities
 * confirmed live in listing text: `&amp;`, `&gt;`, `&#039;`. Decoding itself
 * is shared with needstaffing via `../html-entities` (RJC-374: both were
 * byte-identical copies with the same unguarded code-point ceiling). */
export const decodeFlinterEntities = decodeHtmlEntities;

const cleanText = (raw: string): string =>
  decodeFlinterEntities(raw.replaceAll(/<[^>]+>/gu, " "))
    .replaceAll(/\s+/gu, " ")
    .trim();

const DIV_TAG_PATTERN = /<div\b[^>]*>|<\/div>/giu;

/** Depth-balanced extraction of one `<div ...>...</div>` block starting at
 * `markerStart` (the index of the opening `<div ...>` tag itself). Real
 * Flinter markup nests further divs inside both `.vacancy-item` cards and
 * the detail-page description blocks, so a non-greedy `.*?</div>` regex
 * would close on the FIRST nested `</div>` rather than the block's own --
 * same reasoning as needstaffing's extractVacancyTextHtml. */
const extractBalancedDivBlock = (
  html: string,
  markerStart: number
): { content: string; end: number } | undefined => {
  DIV_TAG_PATTERN.lastIndex = markerStart;
  let depth = 0;
  let contentStart: number | undefined;
  let match = DIV_TAG_PATTERN.exec(html);
  while (match) {
    if (match[0].startsWith("</div")) {
      depth -= 1;
    } else {
      depth += 1;
      if (contentStart === undefined) {
        contentStart = match.index + match[0].length;
      }
    }
    if (depth === 0 && contentStart !== undefined) {
      return {
        content: html.slice(contentStart, match.index),
        end: match.index,
      };
    }
    match = DIV_TAG_PATTERN.exec(html);
  }
  return undefined;
};

/** Finds every top-level `<div class="vacancy-item">...</div>` card on the
 * listing page and returns each one's inner HTML, depth-balanced. */
const extractVacancyItemBlocks = (html: string): string[] => {
  const marker = '<div class="vacancy-item">';
  const blocks: string[] = [];
  let searchFrom = 0;
  let markerIndex = html.indexOf(marker, searchFrom);
  while (markerIndex !== -1) {
    const block = extractBalancedDivBlock(html, markerIndex);
    if (block) {
      blocks.push(block.content);
      searchFrom = block.end;
    } else {
      searchFrom = markerIndex + marker.length;
    }
    markerIndex = html.indexOf(marker, searchFrom);
  }
  return blocks;
};

const HREF_LEES_MEER_PATTERN =
  /<a\s+href="(?<href>[^"]+)">\s*Lees meer\s*<\/a>/u;

/** Flinter's only stable identifier is the URL path segment, e.g.
 * `/opdrachten/vergunningverlener-agrarisch` -> "vergunningverlener-agrarisch". */
export const extractFlinterSlug = (href: string): string | undefined => {
  try {
    const { pathname } = new URL(href, DEFAULT_BASE_URL);
    const segments = pathname.split("/").filter(Boolean);
    return segments.at(-1);
  } catch {
    return undefined;
  }
};

const LI_PATTERN = /<li>(?<text>[\s\S]*?)<\/li>/gu;
const H2_PATTERN = /<h2>(?<text>[\s\S]*?)<\/h2>/u;

/** RJC-375: matches the real observed looptijd durations ("1 jr", ">1 jr",
 * "6 mnd") plus reasonable neighbours -- an optional `>`/`<` prefix, a
 * number (optionally decimal with `,` or `.`), and a Dutch duration unit.
 * Anchored against the whole trimmed text so a locatie or opdrachtgever
 * name (always digit-free free text in every card observed live) cannot
 * accidentally satisfy it. */
const LOOPTIJD_DURATION_PATTERN =
  /^[<>]?\s*\d+(?:[.,]\d+)?\s*(?:jr|jaar|mnd|maand|maanden|wk|week|weken)$/iu;

/** RJC-375 field-order guard. Flinter's `.vacancy-item` cards carry exactly
 * 3 icon+text rows in a fixed order across all 18 cards in the live
 * 2026-08-31 capture: locatie, looptijd, eindklant (opdrachtgever).
 * Flinter labels these rows by icon only (no `alt`/label text to match
 * against, unlike needstaffing/harveynash), so position is the only signal
 * this source offers -- and locatie and opdrachtgever are both free text,
 * indistinguishable from each other. Looptijd is the one row with a
 * recognisable duration format, so this guard checks the MIDDLE row
 * against it. If Flinter ever reorders these rows, the guard fails and
 * `parseFlinterListing` marks the card `looptijdValid: false`; the
 * connector then REJECTS the card outright (see connector.ts) instead of
 * remapping fields -- if the order changed we still cannot tell which of
 * the remaining two rows is the place and which is the client, so
 * remapping would just be a quieter guess. Deliberate consequence of a
 * future layout change: the source yields zero records with a visible
 * rejected count, not silently swapped opdrachtgever_naam/locatie_plaats
 * values. Loud failure over silent corruption. */
export const isFlinterLooptijdDuration = (text?: string): boolean =>
  text !== undefined && LOOPTIJD_DURATION_PATTERN.test(text.trim());

export const parseFlinterListing = (html: string): FlinterListingItem[] => {
  const items: FlinterListingItem[] = [];
  for (const block of extractVacancyItemBlocks(html)) {
    const titelMatch = H2_PATTERN.exec(block);
    const hrefMatch = HREF_LEES_MEER_PATTERN.exec(block);
    const slug = hrefMatch?.groups?.href
      ? extractFlinterSlug(hrefMatch.groups.href)
      : undefined;
    const titel = titelMatch
      ? cleanText(titelMatch.groups?.text ?? "")
      : undefined;
    if (!(slug && titel)) {
      continue;
    }
    const liTexts = [...block.matchAll(LI_PATTERN)].map((match) =>
      cleanText(match.groups?.text ?? "")
    );
    items.push({
      locatiePlaats: liTexts[0] || undefined,
      looptijdTekst: liTexts[1] || undefined,
      looptijdValid: isFlinterLooptijdDuration(liTexts[1]),
      opdrachtgeverNaam: liTexts[2] || undefined,
      slug,
      titel,
    });
  }
  return items;
};

const SCRIPT_OR_STYLE_PATTERN = /<(?<tag>script|style)[\s\S]*?<\/\k<tag>>/giu;

/** Extracts one detail-page section's inner HTML by its wrapping div class,
 * with scripts/styles stripped -- the description sections carry only
 * job-content markup (headings, paragraphs, lists), never scripts. */
const extractDetailSection = (
  html: string,
  className: string
): string | undefined => {
  const markerIndex = html.indexOf(`<div class="${className}">`);
  if (markerIndex === -1) {
    return undefined;
  }
  const block = extractBalancedDivBlock(html, markerIndex);
  return block
    ? block.content.replaceAll(SCRIPT_OR_STYLE_PATTERN, "").trim()
    : undefined;
};

const HOURS_RANGE_PATTERN = /\d{1,3}\s*(?:-|tot)\s*\d{1,3}\s*uur/iu;
const HOURS_SINGLE_PATTERN =
  /(?<hours>\d{1,3})\s*uur\s*(?:p\/w|per\s*week)\b/iu;

/** `uren_per_week` is only partially present at this source, buried in the
 * function-description's free "Praktische zaken" prose (see
 * docs/sources/flinter.md) -- extracted ONLY when a single unambiguous
 * "<n> uur p/w" / "<n> uur per week" phrase appears. A range ("32-40 uur",
 * "32 tot 40 uur per week") is genuinely ambiguous and must resolve to
 * UNKNOWN (via normalise/flinter.ts), never silently narrowed to one end. */
export const extractFlinterUrenPerWeek = (text: string): string | undefined => {
  if (HOURS_RANGE_PATTERN.test(text)) {
    return undefined;
  }
  return HOURS_SINGLE_PATTERN.exec(text)?.groups?.hours;
};

/** Flinter risk 3 (docs/sources/flinter.md): `/opdrachten` can mix in a
 * permanent-employment vacancy among the interim assignments -- confirmed
 * live 2026-08-31 ("Bedrijfsjurist" @ Oasen: a salaried role with "Een
 * dienstverband van 32 tot 40 uur per week" and "Een salaris tussen
 * € 4.238,- en € 6.635,- bruto per maand", no "Duur opdracht" line at all,
 * versus every real assignment's "Duur opdracht: <duur>" practische-zaken
 * line). Both phrases together is the signal: assignments quote a day/hour
 * rate or CAO schaal, never a monthly gross salary band tied to a
 * "dienstverband". */
export const isFlinterPermanentVacancy = (text: string): boolean => {
  const lower = text.toLowerCase();
  return (
    lower.includes("dienstverband van") && lower.includes("bruto per maand")
  );
};

const parseDetailHtml = (html: string, slug: string): FlinterDetail => {
  const heroIndex = html.indexOf('<div class="block-hero-content">');
  const heroTitelMatch =
    heroIndex === -1 ? null : H2_PATTERN.exec(html.slice(heroIndex));
  const jobDescriptionHtml =
    extractDetailSection(html, "vacancy-show-job-description") ?? "";
  const functionDescriptionHtml =
    extractDetailSection(html, "vacancy-show-function-description") ?? "";
  const beschrijvingHtml = [jobDescriptionHtml, functionDescriptionHtml]
    .filter(Boolean)
    .join("\n");
  const combinedText = cleanText(beschrijvingHtml);

  return {
    beschrijvingHtml,
    isPermanentVacancy: isFlinterPermanentVacancy(combinedText),
    slug,
    titel: heroTitelMatch ? cleanText(heroTitelMatch.groups?.text ?? "") : "",
    urenPerWeek: extractFlinterUrenPerWeek(combinedText),
  };
};

export const createFlinterClient = (
  options: FlinterClientOptions = {}
): FlinterClient => {
  const fetchImpl = options.fetchImpl ?? resolveEgressFetch("flinter");
  const liveEnabled = options.liveEnabled ?? process.env.FLINTER_LIVE === "1";
  const listingFixturePath =
    options.listingFixturePath ?? "flinter/listing-page-0.json";
  const detailFixtures = options.detailFixtures ?? {
    bedrijfsjurist: "flinter/detail-bedrijfsjurist.json",
    "vergunningverlener-agrarisch":
      "flinter/detail-vergunningverlener-agrarisch.json",
  };
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;

  return {
    fetchDetailHtml: async (slug) => {
      if (!liveEnabled) {
        const relativePath = detailFixtures[slug];
        if (!relativePath) {
          throw new Error(`Missing Flinter detail fixture for ${slug}`);
        }
        const fixture = await loadConnectorFixture<string>(relativePath);
        return fixture.payload;
      }
      const response = await fetchImpl(
        `${baseUrl}${FLINTER_OPDRACHTEN_PATH}/${slug}`
      );
      if (!response.ok) {
        throw new Error(
          `Flinter detail request failed with status ${response.status}`
        );
      }
      return await response.text();
    },
    fetchListing: async () => {
      if (!liveEnabled) {
        const fixture = await loadConnectorFixture<string>(listingFixturePath);
        return parseFlinterListing(fixture.payload);
      }
      const response = await fetchImpl(`${baseUrl}${FLINTER_OPDRACHTEN_PATH}`);
      if (!response.ok) {
        throw new Error(
          `Flinter listing request failed with status ${response.status}`
        );
      }
      return parseFlinterListing(await response.text());
    },
  };
};

export const parseFlinterDetail = (html: string, slug: string): FlinterDetail =>
  parseDetailHtml(html, slug);
