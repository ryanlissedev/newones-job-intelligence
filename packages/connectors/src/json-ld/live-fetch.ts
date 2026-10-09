/**
 * Shared live-HTTP helpers for json-ld connectors (CTP-528).
 *
 * Werkzoeken (and similar Cloudflare-fronted boards) answer bare fetch with a
 * managed JS challenge (`cf-mitigated: challenge`). Browser-like headers alone
 * do not clear it — verified 2026-09-16 against www.werkzoeken.nl. Product
 * code must not solve CAPTCHAs or invent scrape hacks; the honest unblock is
 * an ops-supplied Cookie header from a consented browser session
 * (`cf_clearance`, …). See docs/sources/werkzoeken.md.
 */

import { SourceBlockedError } from "../source-blocked";

/** Named header bag for live json-ld fetches (optional ops Cookie). */
export interface LiveFetchHeaders {
  Accept: string;
  "Accept-Language": string;
  Cookie?: string;
  "User-Agent": string;
}

/** Realistic Accept / language / UA for public HTML fetches. Not a bypass. */
export const BROWSER_LIKE_HEADERS = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
} as const satisfies Omit<LiveFetchHeaders, "Cookie">;

const CF_CHALLENGE_BODY =
  /Just a moment\.\.\.|cdn-cgi\/challenge-platform|cf-mitigated/iu;

/**
 * Cookie env name paired with a `*_LIVE` gate (e.g. WERKZOEKEN_LIVE →
 * WERKZOEKEN_COOKIE). Empty / unset means no Cookie header.
 */
export const cookieEnvVarForLiveGate = (liveEnvVar?: string): string | null => {
  if (!liveEnvVar || !liveEnvVar.endsWith("_LIVE")) {
    return null;
  }
  return `${liveEnvVar.slice(0, -"_LIVE".length)}_COOKIE`;
};

/** Reads a non-empty Cookie header value from process.env, or null. */
export const readOpsCookieHeader = (
  cookieEnvVar: string | null | undefined
): string | null => {
  if (!cookieEnvVar) {
    return null;
  }
  const raw = process.env[cookieEnvVar];
  if (raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
};

export const isCloudflareChallenge = (
  response: Response,
  body?: string
): boolean => {
  if (response.headers.get("cf-mitigated") === "challenge") {
    return true;
  }
  if (response.status !== 403 || body === undefined) {
    return false;
  }
  return CF_CHALLENGE_BODY.test(body);
};

export const cloudflareChallengeError = (options: {
  cookieEnvVar: string | null;
  slug: string;
  url: string;
}): SourceBlockedError => {
  const cookieHint =
    options.cookieEnvVar === null
      ? "an ops Cookie header from a consented browser session"
      : `${options.cookieEnvVar} from a consented browser session (cf_clearance)`;
  return new SourceBlockedError({
    message:
      `${options.slug} fetch blocked by Cloudflare managed challenge at ${options.url}. ` +
      `Browser-like headers alone do not clear it. Ops: set ${cookieHint}; ` +
      `see docs/sources/werkzoeken.md. Do not use CAPTCHA solvers.`,
    url: options.url,
  });
};

export interface LiveFetchHeadersOptions {
  /** Explicit Cookie header; wins over env when both are set. */
  cookieHeader?: string | null;
  liveEnvVar?: string;
}

/** Merges browser-like defaults with an optional ops Cookie header. */
export const buildLiveFetchHeaders = (
  options: LiveFetchHeadersOptions = {}
): LiveFetchHeaders => {
  const cookieEnvVar = cookieEnvVarForLiveGate(options.liveEnvVar);
  const fromOption = options.cookieHeader?.trim() || null;
  const cookie =
    fromOption && fromOption.length > 0
      ? fromOption
      : readOpsCookieHeader(cookieEnvVar);
  if (cookie === null) {
    return { ...BROWSER_LIKE_HEADERS };
  }
  return {
    ...BROWSER_LIKE_HEADERS,
    Cookie: cookie,
  };
};

/** Converts the closed header bag into a HeadersInit fetch can accept. */
export const toLiveFetchHeadersInit = (
  headers: LiveFetchHeaders
): [string, string][] => {
  const entries: [string, string][] = [
    ["Accept", headers.Accept],
    ["Accept-Language", headers["Accept-Language"]],
    ["User-Agent", headers["User-Agent"]],
  ];
  if (headers.Cookie !== undefined) {
    entries.push(["Cookie", headers.Cookie]);
  }
  return entries;
};

const GZIP_MAGIC = 0x1f_8b;

/**
 * Decodes a live response body to text, transparently inflating gzip payloads
 * the server sent without `Content-Encoding` (e.g. Techniekwerkt's
 * `application/x-compressed` sitemap at `*.xml.gz`). Sniffing the two magic
 * bytes is safe: no text or XML body can start with 0x1f 0x8b.
 */
export const decodeLiveBodyBytes = async (
  bytes: ArrayBuffer
): Promise<string> => {
  const view = new DataView(bytes);
  if (bytes.byteLength >= 2 && view.getUint16(0, false) === GZIP_MAGIC) {
    const stream = new Blob([bytes])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    return await new Response(stream).text();
  }
  return new TextDecoder().decode(bytes);
};

/**
 * Typed non-2xx live-response error. Carrying `status` lets callers treat a
 * 404 detail page as "gone at source" instead of failing the whole run.
 */
export class HttpStatusError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(options: { slug: string; status: number; url: string }) {
    super(`${options.slug} request failed with status ${options.status}`);
    this.name = "HttpStatusError";
    this.status = options.status;
    this.url = options.url;
  }
}

/**
 * Reads a live response body, failing closed on Cloudflare challenges with an
 * ops-actionable message instead of a bare HTTP 403.
 */
export const readLiveHtmlOrThrow = async (options: {
  cookieEnvVar: string | null;
  response: Response;
  slug: string;
  url: string;
}): Promise<string> => {
  const body = await decodeLiveBodyBytes(await options.response.arrayBuffer());
  if (isCloudflareChallenge(options.response, body)) {
    throw cloudflareChallengeError({
      cookieEnvVar: options.cookieEnvVar,
      slug: options.slug,
      url: options.url,
    });
  }
  if (!options.response.ok) {
    throw new HttpStatusError({
      slug: options.slug,
      status: options.response.status,
      url: options.url,
    });
  }
  return body;
};
