/**
 * CTP-530 — ops-facing NVB/DPG bron-URL audit fetch.
 *
 * Uses an explicit consented Playwright storage-state jar supplied by ops.
 * Never invents consent, never auto-clicks the privacy gate, and never
 * scrapes behind the gate without that jar. Product auto-bypass is out of
 * scope; see docs/runbooks/nvb-dpg-privacy-gate-audit.md.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

const NVB_HOSTS = new Set([
  "nationalevacaturebank.nl",
  "www.nationalevacaturebank.nl",
]);

/** Markers observed on the DPG Media privacy / consent wall. */
const GATE_MARKERS = [
  /DPG\s*Media/iu,
  /privacy\s*(?:gate|voorkeuren|instellingen|instelling)/iu,
  /\bAkkoord\b/u,
  /cookie(?:s)?\s*(?:instellingen|voorkeuren|banner)/iu,
  /consent\.cookiebot\.com/iu,
  /OneTrust/iu,
] as const;

interface ApplicableCookie {
  readonly name: string;
  readonly value: string;
}

interface PrivacyGateDetection {
  readonly gated: boolean;
  readonly markers: readonly string[];
}

interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly text: () => Promise<string>;
}

const isSafeCookieValue = (value: string): boolean =>
  [...value].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint === 0x21 ||
      (codePoint >= 0x23 && codePoint <= 0x2b) ||
      (codePoint >= 0x2d && codePoint <= 0x3a) ||
      (codePoint >= 0x3c && codePoint <= 0x5b) ||
      (codePoint >= 0x5d && codePoint <= 0x7e)
    );
  });

const storageCookieSchema = z.object({
  domain: z.string().min(1),
  expires: z.number().finite().optional(),
  httpOnly: z.boolean().optional(),
  name: z.string().min(1),
  path: z.string().min(1),
  sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
  secure: z.boolean(),
  value: z.string().min(1).refine(isSafeCookieValue, {
    message: "cookie value contains unsafe characters",
  }),
});

const storageStateSchema = z.object({
  cookies: z.array(storageCookieSchema).min(1),
});

export type DpgStorageState = z.infer<typeof storageStateSchema>;

export type DpgFetchDisposition =
  | "ok"
  | "gated"
  | "http_error"
  | "missing_jar"
  | "invalid_jar"
  | "invalid_url";

export interface DpgFetchResult {
  readonly contentLength: number;
  readonly disposition: DpgFetchDisposition;
  readonly gateMarkers: readonly string[];
  readonly hasJobPosting: boolean;
  readonly status: number | null;
  readonly url: string;
}

export interface DpgFetchOutcome {
  readonly body: string;
  readonly result: DpgFetchResult;
}

export interface DpgFetchDependencies {
  readonly fetcher?: (
    input: string,
    init: RequestInit
  ) => Promise<FetchResponse>;
  readonly now?: () => Date;
  readonly readStorageState?: (jarPath: string) => Promise<DpgStorageState>;
  readonly worktreeRoot?: string;
}

const hostMatchesCookieDomain = (host: string, domain: string): boolean => {
  const normalised = domain.startsWith(".") ? domain.slice(1) : domain;
  return host === normalised || host.endsWith(`.${normalised}`);
};

const pathMatchesCookiePath = (urlPath: string, cookiePath: string): boolean =>
  urlPath === cookiePath ||
  urlPath.startsWith(cookiePath.endsWith("/") ? cookiePath : `${cookiePath}/`);

export const hasJobPostingLd = (body: string): boolean =>
  /"@type"\s*:\s*"JobPosting"/iu.test(body) ||
  /itemtype=["']https?:\/\/schema\.org\/JobPosting["']/iu.test(body);

export const assertConsentJarPath = (
  jarPath: string | undefined,
  worktreeRoot: string
): string => {
  if (!jarPath || jarPath.trim() === "") {
    throw new Error(
      "DPG_CONSENT_STORAGE_STATE is required (absolute path to a consented Playwright storage-state JSON outside the worktree)"
    );
  }
  const relativeToWorkingTree = path.relative(worktreeRoot, jarPath);
  const isOutsideWorkingTree =
    relativeToWorkingTree === ".." ||
    relativeToWorkingTree.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToWorkingTree);
  if (!path.isAbsolute(jarPath) || !isOutsideWorkingTree) {
    throw new Error(
      "DPG_CONSENT_STORAGE_STATE must be an absolute path outside the git worktree (never commit the jar)"
    );
  }
  return jarPath;
};

export const parseNationaleVacaturebankUrl = (raw: string): URL => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid URL: ${raw}`);
  }
  if (url.protocol !== "https:") {
    throw new Error("only https:// nationalevacaturebank.nl URLs are allowed");
  }
  if (!NVB_HOSTS.has(url.hostname)) {
    throw new Error(
      `host ${url.hostname} is not nationalevacaturebank.nl (audit fetch is NVB-scoped)`
    );
  }
  return url;
};

export const cookiesForUrl = (
  state: DpgStorageState,
  url: URL,
  now: Date = new Date()
): readonly ApplicableCookie[] => {
  const nowSeconds = now.getTime() / 1000;
  return state.cookies
    .filter((cookie) => {
      if (
        cookie.expires !== undefined &&
        cookie.expires > 0 &&
        cookie.expires <= nowSeconds
      ) {
        return false;
      }
      if (cookie.secure && url.protocol !== "https:") {
        return false;
      }
      if (!hostMatchesCookieDomain(url.hostname, cookie.domain)) {
        return false;
      }
      return pathMatchesCookiePath(url.pathname, cookie.path);
    })
    .map((cookie) => ({ name: cookie.name, value: cookie.value }));
};

export const detectPrivacyGate = (
  body: string,
  status: number
): PrivacyGateDetection => {
  if (status === 403 || status === 451) {
    return { gated: true, markers: [`http_${status}`] };
  }
  const markers = GATE_MARKERS.filter((pattern) => pattern.test(body)).map(
    (pattern) => pattern.source
  );
  const jobPosting = hasJobPostingLd(body);
  // Gate page is consent-heavy and lacks JobPosting; live vacancy has LD+JSON.
  if (markers.length > 0 && !jobPosting) {
    return { gated: true, markers };
  }
  return { gated: false, markers };
};

const defaultReadStorageState = async (
  jarPath: string
): Promise<DpgStorageState> => {
  const rawText = await readFile(jarPath, "utf-8");
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(rawText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`consent storage state is not JSON: ${message}`, {
      cause: error,
    });
  }
  const parsed = storageStateSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new Error(
      `invalid consent storage state at ${jarPath}: ${parsed.error.message}`
    );
  }
  return parsed.data;
};

export const loadConsentStorageState = (
  jarPath: string,
  readStorageState: (
    path: string
  ) => Promise<DpgStorageState> = defaultReadStorageState
): Promise<DpgStorageState> => readStorageState(jarPath);

const failureResult = (
  disposition: DpgFetchDisposition,
  url: string,
  message: string
): DpgFetchOutcome => ({
  body: "",
  result: {
    contentLength: 0,
    disposition,
    gateMarkers: [message],
    hasJobPosting: false,
    status: null,
    url,
  },
});

export const fetchBronUrlWithConsent = async (
  rawUrl: string,
  jarPath: string,
  dependencies: DpgFetchDependencies = {}
): Promise<DpgFetchOutcome> => {
  const worktreeRoot = dependencies.worktreeRoot ?? process.cwd();
  const fetcher = dependencies.fetcher ?? fetch;
  const now = dependencies.now ?? (() => new Date());
  const readStorageState =
    dependencies.readStorageState ?? defaultReadStorageState;

  let url: URL;
  try {
    url = parseNationaleVacaturebankUrl(rawUrl);
  } catch (error) {
    return failureResult(
      "invalid_url",
      rawUrl,
      error instanceof Error ? error.message : "invalid_url"
    );
  }

  let resolvedJar: string;
  try {
    resolvedJar = assertConsentJarPath(jarPath, worktreeRoot);
  } catch (error) {
    return failureResult(
      "missing_jar",
      url.href,
      error instanceof Error ? error.message : "missing_jar"
    );
  }

  let state: DpgStorageState;
  try {
    state = await loadConsentStorageState(resolvedJar, readStorageState);
  } catch (error) {
    return failureResult(
      "invalid_jar",
      url.href,
      error instanceof Error ? error.message : "invalid_jar"
    );
  }

  const cookies = cookiesForUrl(state, url, now());
  if (cookies.length === 0) {
    return failureResult(
      "invalid_jar",
      url.href,
      "consent jar has no cookies applicable to this NVB URL (re-capture after Akkoord)"
    );
  }

  const cookieHeader = cookies
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");

  const response = await fetcher(url.href, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      Cookie: cookieHeader,
      "User-Agent":
        "CatapulzeJobIntelligence-AuditFetch/1.0 (+ops consent jar; CTP-530)",
    },
    method: "GET",
    redirect: "follow",
  });

  const body = await response.text();
  const gate = detectPrivacyGate(body, response.status);
  const jobPosting = hasJobPostingLd(body);

  let disposition: DpgFetchDisposition = "ok";
  if (gate.gated) {
    disposition = "gated";
  } else if (response.ok) {
    disposition = "ok";
  } else {
    disposition = "http_error";
  }

  return {
    body,
    result: {
      contentLength: body.length,
      disposition,
      gateMarkers: gate.markers,
      hasJobPosting: jobPosting,
      status: response.status,
      url: url.href,
    },
  };
};

const printUsage = (): void => {
  process.stderr.write(`Usage:
  DPG_CONSENT_STORAGE_STATE=/abs/path/outside/repo/storage-state.json \\
    bun scripts/audit/dpg-consent-fetch.ts --url <https://www.nationalevacaturebank.nl/...> [--out <dir>]

Fails closed without an explicit consented jar. Does not click Akkoord.
See docs/runbooks/nvb-dpg-privacy-gate-audit.md.
`);
};

const runCli = async (): Promise<void> => {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  let urlArg: string | undefined;
  let outDir: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--url") {
      urlArg = args[index + 1];
      index += 1;
    } else if (arg === "--out") {
      outDir = args[index + 1];
      index += 1;
    }
  }

  if (!urlArg) {
    printUsage();
    process.exit(2);
  }

  const jarPath = process.env.DPG_CONSENT_STORAGE_STATE;
  const { body, result } = await fetchBronUrlWithConsent(urlArg, jarPath ?? "");

  // Never echo cookie values — report is disposition-only.
  const report = {
    contentLength: result.contentLength,
    disposition: result.disposition,
    gateMarkers: result.gateMarkers,
    hasJobPosting: result.hasJobPosting,
    status: result.status,
    url: result.url,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (outDir && result.disposition === "ok") {
    await mkdir(outDir, { recursive: true });
    const safeName = result.url
      .replaceAll(/^https?:\/\//gu, "")
      .replaceAll(/[^\w.-]+/gu, "_")
      .slice(0, 180);
    await writeFile(path.join(outDir, `${safeName}.html`), body, "utf-8");
    await writeFile(
      path.join(outDir, `${safeName}.report.json`),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf-8"
    );
  }

  process.exit(result.disposition === "ok" ? 0 : 1);
};

if (import.meta.main) {
  await runCli();
}
