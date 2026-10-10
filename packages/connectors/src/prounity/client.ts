import { resolveEgressFetch } from "../egress";
import { loadConnectorFixture } from "../fixtures/load";
import { decodeHtmlEntities } from "../html-entities";
import type {
  ProunityDetail,
  ProunityListingItem,
  ProunityRequirementTag,
} from "./types";
import {
  PROUNITY_DETAIL_FIXTURES,
  PROUNITY_JOB_SITEMAP_PATTERN,
  PROUNITY_JOB_URL_PATTERN,
  PROUNITY_SITEMAP_FIXTURES,
  PROUNITY_SITEMAP_INDEX_URL,
} from "./types";

interface ProunityRewriterElement {
  getAttribute: (name: string) => string | null;
}
interface ProunityRewriterTextChunk {
  text: string;
}
interface ProunityRewriterHandlers {
  element?: (element: ProunityRewriterElement) => void;
  text?: (chunk: ProunityRewriterTextChunk) => void;
}
interface ProunityRewriter {
  on: (
    selector: string,
    handlers: ProunityRewriterHandlers
  ) => ProunityRewriter;
  transform: (response: Response) => Response;
}
type ProunityRewriterConstructor = new () => ProunityRewriter;

/**
 * Bun ships `HTMLRewriter` as a runtime global (typed by `@types/bun`), but
 * this package's source is consumed directly (via package.json `exports`) by
 * apps/web's own `tsc` run, which has no Bun ambient types configured.
 * Reading it off `globalThis` through a locally-scoped type avoids a
 * duplicate-global-declaration clash in builds that DO have `@types/bun`
 * loaded, while still type-checking cleanly in ones that don't. Called
 * lazily inside parseProunityDetail (never at module scope) so a non-Bun
 * import of this module — e.g. the normaliser pulling a parser-version
 * constant — does not throw on Node/Next. Same pattern as
 * needstaffing/client.ts.
 */
const readGlobalProunityRewriter = (): ProunityRewriterConstructor => {
  // SAFETY: probing globalThis for a Bun-only ambient IS the I/O boundary —
  // there is no narrower source type to parse this from.
  const candidate = (globalThis as { HTMLRewriter?: unknown }).HTMLRewriter;
  // This typeof check is the I/O-boundary parse itself: narrowing an ambient
  // global we don't control to "callable or not" before use.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (typeof candidate !== "function") {
    throw new TypeError(
      "HTMLRewriter is not available on globalThis (this connector requires the Bun runtime)"
    );
  }
  // SAFETY: `typeof candidate === "function"` was just verified; Bun's real
  // HTMLRewriter constructor matches the narrowed shape this module calls.
  return candidate as ProunityRewriterConstructor;
};

export interface ProunityClient {
  fetchListing: () => Promise<ProunityListingItem[]>;
  fetchDetailHtml: (uuid: string) => Promise<string>;
}

export interface ProunityClientOptions {
  baseUrl?: string;
  detailFixtures?: Record<string, string>;
  fetchImpl?: typeof fetch;
  listingFixturePath?: string;
  liveEnabled?: boolean;
  sitemapFixtures?: Record<string, string>;
  sitemapIndexUrl?: string;
}

const DEFAULT_BASE_URL = "https://www.pro-unity.com";

/** HTMLRewriter text() chunks are NOT entity-decoded (confirmed across the
 * html-family sources, RJC-374); decode the handful this site actually uses
 * (`&#8217;`, `&#8211;`, `&eacute;` in the recorded French descriptions). */
export const decodeProunityEntities = decodeHtmlEntities;

const CDATA_PATTERN = /^\s*<!\[CDATA\[(?<inner>[\s\S]*?)\]\]>\s*$/u;

/** AIOSEO wraps every sitemap text node in CDATA; plain `<loc>url</loc>`
 * content is accepted too so a future unwrapped document still parses. */
const unwrapCdata = (raw: string): string => {
  const inner = CDATA_PATTERN.exec(raw)?.groups?.inner;
  return (inner ?? raw).trim();
};

const decodeXmlEntities = (value: string): string =>
  value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");

const SITEMAP_ENTRY_BLOCK_PATTERN = /<sitemap>(?<block>[\s\S]*?)<\/sitemap>/giu;
const SITEMAP_URL_BLOCK_PATTERN = /<url>(?<block>[\s\S]*?)<\/url>/giu;
const LOC_PATTERN = /<loc>(?<loc>[\s\S]*?)<\/loc>/u;
const LASTMOD_PATTERN = /<lastmod>(?<lastmod>[\s\S]*?)<\/lastmod>/u;

/** `<sitemap><loc>` children of the index that carry job missions. */
export const extractProunityJobSitemapUrls = (xml: string): string[] => {
  const children: string[] = [];
  SITEMAP_ENTRY_BLOCK_PATTERN.lastIndex = 0;
  let match = SITEMAP_ENTRY_BLOCK_PATTERN.exec(xml);
  while (match) {
    const raw = LOC_PATTERN.exec(match.groups?.block ?? "")?.groups?.loc;
    const loc = raw ? decodeXmlEntities(unwrapCdata(raw)) : "";
    if (loc && PROUNITY_JOB_SITEMAP_PATTERN.test(loc)) {
      children.push(loc);
    }
    match = SITEMAP_ENTRY_BLOCK_PATTERN.exec(xml);
  }
  return children;
};

/** `<url>` entries of one `pji_job` child sitemap — every entry is a
 * `/job/<uuid>/` mission, open or historical alike. */
export const parseProunityJobSitemap = (xml: string): ProunityListingItem[] => {
  const items: ProunityListingItem[] = [];
  const seen = new Set<string>();
  SITEMAP_URL_BLOCK_PATTERN.lastIndex = 0;
  let match = SITEMAP_URL_BLOCK_PATTERN.exec(xml);
  while (match) {
    const block = match.groups?.block ?? "";
    const rawLoc = LOC_PATTERN.exec(block)?.groups?.loc;
    const url = rawLoc ? decodeXmlEntities(unwrapCdata(rawLoc)) : "";
    const uuid = url ? PROUNITY_JOB_URL_PATTERN.exec(url)?.groups?.uuid : "";
    if (url && uuid && !seen.has(uuid)) {
      seen.add(uuid);
      const rawLastmod = LASTMOD_PATTERN.exec(block)?.groups?.lastmod;
      const lastmod = rawLastmod
        ? decodeXmlEntities(unwrapCdata(rawLastmod))
        : "";
      items.push(lastmod ? { lastmod, url, uuid } : { url, uuid });
    }
    match = SITEMAP_URL_BLOCK_PATTERN.exec(xml);
  }
  return items;
};

const REFERENTIE_PATTERN = /\((?<ref>K\d+)\)\s*$/u;

export const extractProunityReferentie = (titel: string): string | undefined =>
  REFERENTIE_PATTERN.exec(titel)?.groups?.ref;

type ProunitySection = "roles" | "skills" | "talen";

/** `<h6>` headings inside `.job` on the detail page, confirmed live
 * 2026-09-18 on two missions: Roles, Languages, Skills. Any other h6 text
 * resets the section so its tags are never attributed. */
const SECTION_HEADINGS = new Map<string, ProunitySection>([
  ["languages", "talen"],
  ["roles", "roles"],
  ["skills", "skills"],
]);

export const parseProunityDetail = async (
  html: string,
  uuid: string
): Promise<ProunityDetail> => {
  const detail: ProunityDetail = {
    roles: [],
    skills: [],
    talen: [],
    titel: "",
    uuid,
  };
  const infobarSpans: string[] = [];
  let currentInfobarIndex = -1;
  let pendingSection: ProunitySection | undefined;
  let h6Buffer = "";
  let h6Pending = false;
  let currentTag: ProunityRequirementTag | null = null;

  const finishTag = () => {
    if (currentTag && pendingSection) {
      const naam = decodeProunityEntities(currentTag.naam).trim();
      if (naam) {
        const status = decodeProunityEntities(currentTag.status ?? "").trim();
        detail[pendingSection].push(status ? { naam, status } : { naam });
      }
    }
    currentTag = null;
  };

  const rewriter = new (readGlobalProunityRewriter())()
    .on("h2.fusion-post-title", {
      text: (chunk) => {
        detail.titel = `${detail.titel}${chunk.text}`;
      },
    })
    .on(".post-content .putag", {
      text: (chunk) => {
        detail.duur = `${detail.duur ?? ""}${chunk.text}`;
      },
    })
    .on(".job__infobar span", {
      element: () => {
        currentInfobarIndex += 1;
        infobarSpans[currentInfobarIndex] = "";
      },
      text: (chunk) => {
        if (currentInfobarIndex >= 0) {
          infobarSpans[currentInfobarIndex] =
            `${infobarSpans[currentInfobarIndex] ?? ""}${chunk.text}`;
        }
      },
    })
    .on(".job h6", {
      element: () => {
        h6Buffer = "";
        h6Pending = true;
      },
      text: (chunk) => {
        h6Buffer = `${h6Buffer}${chunk.text}`;
      },
    })
    .on(".job .tags li", {
      element: () => {
        finishTag();
        if (h6Pending) {
          pendingSection = SECTION_HEADINGS.get(
            decodeProunityEntities(h6Buffer).trim().toLowerCase()
          );
          h6Pending = false;
        }
        currentTag = { naam: "" };
      },
    })
    .on(".job .tags li b", {
      text: (chunk) => {
        if (currentTag) {
          currentTag.naam = `${currentTag.naam}${chunk.text}`;
        }
      },
    })
    .on(".job .tags li .tag2", {
      text: (chunk) => {
        if (currentTag) {
          currentTag.status = `${currentTag.status ?? ""}${chunk.text}`;
        }
      },
    })
    .on("a.job__signin", {
      element: (el) => {
        const href = el.getAttribute("href");
        if (href) {
          detail.applyUrl = href;
        }
      },
    });

  await rewriter.transform(new Response(html)).text();
  finishTag();

  detail.titel = decodeProunityEntities(detail.titel).trim();
  detail.duur = detail.duur
    ? decodeProunityEntities(detail.duur).trim()
    : undefined;
  // Positional infobar: span 1 is the work period ("12/10/2026 - 31/12/2026"),
  // span 2 the country ("Belgium") — confirmed live 2026-09-18 on two open
  // missions and one 2023 page; no labels exist to match against (same
  // positional situation as flinter's icon rows).
  detail.periode = infobarSpans[0]
    ? decodeProunityEntities(infobarSpans[0]).trim()
    : undefined;
  detail.land = infobarSpans[1]
    ? decodeProunityEntities(infobarSpans[1]).trim()
    : undefined;
  detail.referentie = extractProunityReferentie(detail.titel);
  return detail;
};

const RICHTEXT_MARKER = '<div class="richtext">';
const DIV_TAG_PATTERN = /<div\b[^>]*>|<\/div>/giu;
const SCRIPT_OR_STYLE_PATTERN = /<(?<tag>script|style)[\s\S]*?<\/\k<tag>>/giu;

/** Grabs the balanced `div.richtext` description block (depth-counted) — the
 * only chunk of the detail page persisted: no header/footer/nav/scripts and
 * no "Sign in to apply" CTA (that anchor lives outside `.richtext`). */
export const buildProunityRawHtml = (html: string): string => {
  const start = html.indexOf(RICHTEXT_MARKER);
  if (start === -1) {
    return "";
  }
  const contentStart = start + RICHTEXT_MARKER.length;
  DIV_TAG_PATTERN.lastIndex = contentStart;
  let depth = 1;
  let match = DIV_TAG_PATTERN.exec(html);
  while (match) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) {
      return html
        .slice(contentStart, match.index)
        .replaceAll(SCRIPT_OR_STYLE_PATTERN, "")
        .trim();
    }
    match = DIV_TAG_PATTERN.exec(html);
  }
  return "";
};

export const createProunityClient = (
  options: ProunityClientOptions = {}
): ProunityClient => {
  const fetchImpl = options.fetchImpl ?? resolveEgressFetch("prounity");
  const liveEnabled = options.liveEnabled ?? process.env.PROUNITY_LIVE === "1";
  const listingFixturePath =
    options.listingFixturePath ?? "prounity/listing-page-0.json";
  const sitemapFixtures: Record<string, string> =
    options.sitemapFixtures ?? PROUNITY_SITEMAP_FIXTURES;
  const detailFixtures: Record<string, string> =
    options.detailFixtures ?? PROUNITY_DETAIL_FIXTURES;
  const sitemapIndexUrl = options.sitemapIndexUrl ?? PROUNITY_SITEMAP_INDEX_URL;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;

  const readText = async (url: string): Promise<string> => {
    const response = await fetchImpl(url);
    if (!response.ok) {
      throw new Error(
        `ProUnity request failed with status ${response.status} (${url})`
      );
    }
    return await response.text();
  };

  return {
    fetchDetailHtml: async (uuid) => {
      if (!liveEnabled) {
        const relativePath = detailFixtures[uuid];
        if (!relativePath) {
          throw new Error(`Missing ProUnity detail fixture for ${uuid}`);
        }
        const fixture = await loadConnectorFixture<string>(relativePath);
        return fixture.payload;
      }
      return await readText(`${baseUrl}/job/${uuid}/`);
    },
    fetchListing: async () => {
      if (!liveEnabled) {
        const indexFixture =
          await loadConnectorFixture<string>(listingFixturePath);
        const children = extractProunityJobSitemapUrls(indexFixture.payload);
        // Fixture mode only replays children that were recorded — the
        // index fixture keeps all five pji_job children while only the
        // newest was captured (trimmed to URLs with detail fixtures).
        const fixtures = await Promise.all(
          children
            .map((child) => sitemapFixtures[child])
            .filter((path): path is string => path !== undefined)
            .map((path) => loadConnectorFixture<string>(path))
        );
        return fixtures.flatMap((fixture) =>
          parseProunityJobSitemap(fixture.payload)
        );
      }
      const indexXml = await readText(sitemapIndexUrl);
      const children = extractProunityJobSitemapUrls(indexXml);
      const items: ProunityListingItem[] = [];
      for (const child of children) {
        // oxlint-disable-next-line no-await-in-loop -- robots.txt Crawl-delay: 10 requires sequential requests
        const childXml = await readText(child);
        items.push(...parseProunityJobSitemap(childXml));
      }
      return items;
    },
  };
};
