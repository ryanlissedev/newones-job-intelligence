import { UNKNOWN } from "@ji/domain";

import type { NeonV1JobRow } from "./neon-v1-types";

const STARAPPLE_HOST = "www.starapple.nl";
const STARAPPLE_HOST_WITHOUT_WWW = "starapple.nl";
const STARAPPLE_VACATURES_PATH = /^\/vacatures\/(?<slug>[^/]+)\/?$/iu;
const STARAPPLE_LIVE_URL_PREFIX = "https://www.starapple.nl/vacatures/";
const WAYBACK_URL_PREFIX = "https://web.archive.org/web/";

/**
 * The site's own vacancy sitemap. One bounded GET yields the complete set of
 * slugs the live site currently advertises (382 entries on 2026-09-20), which
 * is the only rematch source this module trusts: a slug listed there resolves
 * to a live vacature, and no amount of slug arithmetic can prove the same for
 * a slug that is absent.
 */
export const STARAPPLE_VACANCY_SITEMAP_URL =
  "https://www.starapple.nl/vacancy-sitemap.xml";

type MotianLifecycleJob = Pick<
  NeonV1JobRow,
  "archived_at" | "deleted_at" | "status"
>;

/**
 * The slice of a Motian row bron-URL resolution reads: slug hints, the title
 * rematch signal, lifecycle flags and the platform gate. A full
 * {@link NeonV1JobRow} satisfies it, and so does a minimally parsed jobs
 * export — that is what lets the verification tool feed rows without
 * fabricating the rest of the row contract.
 */
export type MotianBronUrlJob = Pick<
  NeonV1JobRow,
  | "archived_at"
  | "deleted_at"
  | "external_id"
  | "external_url"
  | "platform"
  | "status"
  | "title"
>;

const decodeOnce = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const normalizeStarappleSlug = (value: string): string =>
  decodeOnce(value.trim())
    .replaceAll(/[\s_]+/gu, "-")
    .replaceAll(/-+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .toLowerCase();

const isStarapplePlatform = (platform: string): boolean => {
  const normalized = platform.trim().toLowerCase();
  return normalized === "starapple" || normalized === "starapple-nl";
};

const slugFromExternalUrl = (externalUrl: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(externalUrl);
  } catch {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== STARAPPLE_HOST && hostname !== STARAPPLE_HOST_WITHOUT_WWW) {
    return null;
  }

  const match = STARAPPLE_VACATURES_PATH.exec(parsed.pathname);
  return match?.groups?.slug ?? null;
};

const slugForJob = (job: MotianBronUrlJob): string | null => {
  const externalUrl = job.external_url?.trim();
  const urlSlug = externalUrl ? slugFromExternalUrl(externalUrl) : null;
  const rawSlug = urlSlug ?? job.external_id;
  const slug = normalizeStarappleSlug(rawSlug);
  return slug.length > 0 ? slug : null;
};

/** Keep this predicate aligned with the lifecycle used by the Neon backfill. */
export const isMotianJobClosed = (
  job: MotianLifecycleJob,
  sourceStatus = job.status?.trim() || null
): boolean => {
  const sourceHasArchiveSignal =
    (job.archived_at !== null && job.archived_at !== undefined) ||
    (job.deleted_at !== null && job.deleted_at !== undefined);
  const sourceIsClosed =
    sourceHasArchiveSignal ||
    (sourceStatus !== null && sourceStatus.toLowerCase() !== "open");
  return sourceIsClosed;
};

const liveUrlForSlug = (slug: string): string =>
  `${STARAPPLE_LIVE_URL_PREFIX}${slug}/`;

const waybackUrlForSlug = (slug: string): string =>
  `${WAYBACK_URL_PREFIX}${liveUrlForSlug(slug)}`;

const SITEMAP_LOC_PATTERN = /<loc>(?<loc>[^<]+)<\/loc>/giu;

/**
 * Live slugs advertised by `vacancy-sitemap.xml`. The index is a plain input
 * value: whoever supplies it fetched (or recorded) the sitemap, so resolution
 * itself stays deterministic and testable offline.
 */
export interface StarappleLiveIndex {
  readonly slugs: ReadonlySet<string>;
}

/**
 * Parses every `/vacatures/<slug>/` loc out of a recorded or live sitemap.
 *
 * Throws on a document that cannot be a usable index — a 200 challenge or
 * error page, a sitemapindex, or truncated XML. An empty index is worse than
 * no index: every open Starapple row would resolve `archive/unresolvable`
 * and rewrite otherwise valid live URLs to Wayback on one transiently bad
 * response.
 */
export const buildStarappleLiveIndex = (
  sitemapXml: string
): StarappleLiveIndex => {
  if (!/<urlset[\s>]/iu.test(sitemapXml) || !/<\/urlset>/iu.test(sitemapXml)) {
    throw new Error(
      "Starapple vacancy sitemap is not a complete <urlset> document"
    );
  }
  const slugs = new Set<string>();
  for (const match of sitemapXml.matchAll(SITEMAP_LOC_PATTERN)) {
    const loc = match.groups?.loc?.trim();
    if (!loc) {
      continue;
    }
    let parsed: URL;
    try {
      parsed = new URL(loc);
    } catch {
      continue;
    }
    const hostname = parsed.hostname.toLowerCase();
    if (
      hostname !== STARAPPLE_HOST &&
      hostname !== STARAPPLE_HOST_WITHOUT_WWW
    ) {
      continue;
    }
    const slug = STARAPPLE_VACATURES_PATH.exec(parsed.pathname)?.groups?.slug;
    const normalized = slug ? normalizeStarappleSlug(slug) : "";
    if (normalized) {
      slugs.add(normalized);
    }
  }
  if (slugs.size === 0) {
    throw new Error(
      "Starapple vacancy sitemap contains no /vacatures/ entries"
    );
  }
  return { slugs };
};

const TRAILING_INDEX_PATTERN = /-\d+$/u;
const NUMERIC_SUFFIX_PATTERN = /^-\d+$/u;

/** `java-developer-33` → `java-developer`; slugs without a trailing site
 * sequence number keep their own value. */
const slugWithoutTrailingIndex = (slug: string): string =>
  slug.replace(TRAILING_INDEX_PATTERN, "");

/**
 * A candidate's match set is every live slug equal to it OR carrying it
 * plus the site's numeric repost suffix. Only a match set of exactly ONE
 * slug is usable: two or more live slugs for the same base means sibling
 * reposts of the same title, and the sitemap cannot tell them apart —
 * that candidate is ambiguous and resolution moves on rather than
 * guessing. Zero hits falls through the same way. Anything looser
 * (token overlap, fuzzy renames like `next-gen-engineers` →
 * `next-generation-software-engineers-gezocht-5`) would fabricate a link to
 * a vacature the source never named — a wrong-vacancy link is worse than an
 * archive redirect.
 */
const rematchLiveSlug = (
  liveIndex: StarappleLiveIndex,
  candidate: string
): string | null => {
  const matches = [...liveIndex.slugs].filter(
    (liveSlug) =>
      liveSlug === candidate ||
      (liveSlug.startsWith(`${candidate}-`) &&
        NUMERIC_SUFFIX_PATTERN.test(liveSlug.slice(candidate.length)))
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
};

/**
 * The one live slug a stale derived slug may rematch to, or null.
 *
 * Only slug evidence the source itself recorded is trusted:
 *
 * - the derived slug's own repost family (`open-sollicitatie` →
 *   `open-sollicitatie-3643`): the live slug literally extends the URL
 *   Motian recorded for this vacancy, so no second signal is needed;
 * - its de-numbered base (`devops-engineer-linux-44` →
 *   `devops-engineer-linux`), but only when the vacancy title folds back
 *   into the same family — that second identity signal is what proves the
 *   trailing digits were a site sequence number. Without it `office-365`
 *   would collapse onto an unrelated `office-2`, and a generic title
 *   alone must never link a stale row to a vacancy that merely shares
 *   its words.
 */
const resolveRematchSlug = (
  job: MotianBronUrlJob,
  liveIndex: StarappleLiveIndex,
  derived: string
): string | null => {
  const ownFamily = rematchLiveSlug(liveIndex, derived);
  if (ownFamily !== null) {
    return ownFamily;
  }
  const base = slugWithoutTrailingIndex(derived);
  if (base === derived) {
    return null;
  }
  const baseMatch = rematchLiveSlug(liveIndex, base);
  if (baseMatch === null) {
    return null;
  }
  const foldedTitle = job.title ? normalizeStarappleSlug(job.title) : "";
  const titleAgrees =
    foldedTitle.length > 0 &&
    (foldedTitle === base ||
      rematchLiveSlug(liveIndex, foldedTitle) === baseMatch);
  return titleAgrees ? baseMatch : null;
};

export type StarappleBronResolution =
  | {
      readonly fromSlug: string;
      readonly kind: "archive";
      readonly reason: "closed" | "unresolvable";
      readonly url: string;
    }
  | {
      readonly fromSlug: string;
      readonly kind: "live";
      readonly match: "exact" | "rematch";
      readonly slug: string;
      readonly url: string;
    }
  | { readonly kind: "unknown" };

/**
 * Resolves one Starapple Motian row against the live index:
 *
 * - closed/archived/deleted rows → `archive` (Wayback redirect for the
 *   derived canonical URL; unchanged pre-index behaviour);
 * - a derived slug still advertised in the sitemap → `live`/`exact`;
 * - a stale slug with exactly one unambiguous rematch → `live`/`rematch` at
 *   the rematched slug;
 * - anything else → `archive` with reason `unresolvable`, wrapping the
 *   DERIVED slug (the only URL Motian actually recorded). An open row whose
 *   slug is gone therefore resolves to an archive redirect — exactly the
 *   fallback CTP-527's done-when allows — and no plausible-looking slug is
 *   ever invented.
 */
export const resolveStarappleBronTarget = (
  job: MotianBronUrlJob,
  liveIndex: StarappleLiveIndex
): StarappleBronResolution => {
  const derived = slugForJob(job);
  if (!derived) {
    return { kind: "unknown" };
  }
  if (isMotianJobClosed(job)) {
    return {
      fromSlug: derived,
      kind: "archive",
      reason: "closed",
      url: waybackUrlForSlug(derived),
    };
  }
  if (liveIndex.slugs.has(derived)) {
    return {
      fromSlug: derived,
      kind: "live",
      match: "exact",
      slug: derived,
      url: liveUrlForSlug(derived),
    };
  }
  const rematched = resolveRematchSlug(job, liveIndex, derived);
  if (rematched !== null) {
    return {
      fromSlug: derived,
      kind: "live",
      match: "rematch",
      slug: rematched,
      url: liveUrlForSlug(rematched),
    };
  }
  return {
    fromSlug: derived,
    kind: "archive",
    reason: "unresolvable",
    url: waybackUrlForSlug(derived),
  };
};

/**
 * Resolve a Motian row to the canonical source URL used by Catapulze.
 * Starapple's external URL is treated as a slug hint only; other platforms
 * retain the existing Motian URL behavior until their templates are known.
 *
 * When a `liveIndex` built from the live vacancy sitemap is supplied, open
 * Starapple rows are verified against it: listed slugs keep their live URL,
 * an unambiguous rematch is followed, and unresolvable slugs fall back to the
 * same Wayback archive redirect closed rows get. Without an index the
 * historical behaviour is preserved verbatim (derived live URL, Wayback for
 * closed rows) so callers that cannot fetch the sitemap see no change.
 */
export const resolveMotianBronUrl = (
  job: MotianBronUrlJob,
  liveIndex?: StarappleLiveIndex
): string | typeof UNKNOWN => {
  if (!isStarapplePlatform(job.platform)) {
    return job.external_url?.trim() || UNKNOWN;
  }

  if (liveIndex !== undefined) {
    const target = resolveStarappleBronTarget(job, liveIndex);
    return target.kind === "unknown" ? UNKNOWN : target.url;
  }

  const slug = slugForJob(job);
  if (!slug) {
    return UNKNOWN;
  }

  return isMotianJobClosed(job)
    ? waybackUrlForSlug(slug)
    : liveUrlForSlug(slug);
};
