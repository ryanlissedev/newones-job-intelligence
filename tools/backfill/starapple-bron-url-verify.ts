/**
 * CTP-527 — bounded, idempotent Starapple bron-URL verification.
 *
 * The Motian backfill derives bron-URLs from `external_id`/`external_url`
 * slug hints and stores them without ever probing the live site. The CTP-514
 * audit found 4/5 Herkomst URLs returning HTTP 404 because Starapple renames
 * or delists vacancies (`next-gen-engineers`, `java-developer-33`), so the
 * recorded slug goes stale. Live verification does not fit the synchronous,
 * concurrent `runNeonV1Backfill` mapping contract, so it lands here as a
 * repair/verification step instead — the same reason the derived-field
 * repairs live in `tools/backfill/`:
 *
 *   1. fetch `vacancy-sitemap.xml` once (or read a recorded file) and build
 *      the {@link StarappleLiveIndex};
 *   2. resolve every input row deterministically via
 *      {@link resolveStarappleBronTarget} — live exact hit, unambiguous
 *      rematch, or Wayback archive redirect. Nothing is written to a
 *      database; existing-row repair stays with the ops repair lane
 *      (CTP-535). Re-running with the same inputs yields the same plan;
 *   3. optionally probe the resolved URLs live (bounded `--max-probes`,
 *      sequential, `--delay-ms` apart — the site serves plain 200s today but
 *      has no robots.txt to lean on) and, for live hits, extract the
 *      F02/F03/F08/F18 page facts the audit flagged
 *      ({@link extractStarapplePageFacts}).
 *
 * Usage:
 *   bun tools/backfill/starapple-bron-url-verify.ts --jobs rows.json \
 *     [--sitemap sitemap-or-fixture.json|xml] [--probe] [--pages] \
 *     [--max-probes 20] [--delay-ms 750] [--timeout-ms 15000] [--out receipt.json]
 */
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { z } from "zod";

import {
  buildStarappleLiveIndex,
  resolveMotianBronUrl,
  resolveStarappleBronTarget,
  STARAPPLE_VACANCY_SITEMAP_URL,
} from "../../packages/application/src/backfill/motian-bron-url";
import type {
  MotianBronUrlJob,
  StarappleBronResolution,
  StarappleLiveIndex,
} from "../../packages/application/src/backfill/motian-bron-url";
import { extractStarapplePageFacts } from "../../packages/application/src/normalise/starapple-page";
import type { StarapplePageFacts } from "../../packages/application/src/normalise/starapple-page";

export const STARAPPLE_BRON_URL_VERIFY_VERSION =
  "starapple-bron-url-verify/v1" as const;

const DEFAULT_MAX_PROBES = 20;
const DEFAULT_DELAY_MS = 750;
const DEFAULT_TIMEOUT_MS = 15_000;
const PROBE_USER_AGENT =
  "Catapulze-JI bron-url verification (CTP-527; one sequential pass)";

const isStarappleJob = (job: MotianBronUrlJob): boolean =>
  ["starapple", "starapple-nl"].includes(job.platform.trim().toLowerCase());

export interface StarappleBronVerificationEntry {
  readonly bronUrl: string;
  readonly externalId: string;
  /** URL the historical (index-less) mapping stored — the audit's 404s. */
  readonly previousUrl: string;
  readonly resolution: StarappleBronResolution;
}

/**
 * Deterministic verification plan: every Starapple row resolves against the
 * same live index, so the plan depends only on (jobs, sitemap), never on the
 * network. Non-Starapple rows are skipped — this tool is Starapple-scoped.
 */
export const planStarappleBronVerification = (input: {
  readonly jobs: readonly MotianBronUrlJob[];
  readonly liveIndex: StarappleLiveIndex;
}): readonly StarappleBronVerificationEntry[] =>
  input.jobs.filter(isStarappleJob).map((job) => {
    const resolution = resolveStarappleBronTarget(job, input.liveIndex);
    return {
      bronUrl: resolution.kind === "unknown" ? "" : resolution.url,
      externalId: job.external_id,
      previousUrl: resolveMotianBronUrl(job),
      resolution,
    };
  });

export interface StarappleBronProbeResult {
  readonly finalUrl: string | null;
  readonly status: number | null;
}

export interface StarappleBronVerificationResult extends StarappleBronVerificationEntry {
  readonly bronProbe?: StarappleBronProbeResult;
  readonly pageFacts?: StarapplePageFacts;
  readonly previousProbe?: StarappleBronProbeResult;
}

export interface StarappleBronVerificationReceipt {
  readonly contractVersion: typeof STARAPPLE_BRON_URL_VERIFY_VERSION;
  readonly counts: {
    readonly archive: number;
    readonly liveExact: number;
    readonly liveRematch: number;
    readonly probed: number;
    readonly unknown: number;
  };
  readonly results: readonly StarappleBronVerificationResult[];
  readonly runAt: string;
  readonly sitemap: {
    readonly slugCount: number;
    readonly source: "file" | "live";
    readonly url: string;
  };
}

type FetchImpl = (url: string) => Promise<{
  readonly ok: boolean;
  readonly redirected: boolean;
  readonly status: number;
  readonly url: string;
  text: () => Promise<string>;
}>;

const defaultFetch =
  (timeoutMs: number): FetchImpl =>
  (url) =>
    fetch(url, {
      headers: { "User-Agent": PROBE_USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });

const probeUrl = async (
  url: string,
  fetchImpl: FetchImpl
): Promise<{ probe: StarappleBronProbeResult; body: string | null }> => {
  try {
    const response = await fetchImpl(url);
    return {
      body: response.ok ? await response.text() : null,
      probe: {
        finalUrl: response.redirected ? response.url : null,
        status: response.status,
      },
    };
  } catch {
    return { body: null, probe: { finalUrl: null, status: null } };
  }
};

/** The normalized `/vacatures/<slug>` path a URL points at — used to prove
 * a redirect still landed on the vacancy the plan resolved. */
const vacancyPathname = (url: string): string | null => {
  try {
    const { pathname } = new URL(url);
    const normalized = pathname.replaceAll(/\/+$/gu, "");
    return normalized.startsWith("/vacatures/") ? normalized : null;
  } catch {
    return null;
  }
};

/** Probes one planned entry within the shared `probedSoFar` budget and
 * reports how many probes it spent, so the caller keeps the running count. */
const probeVerificationEntry = async (input: {
  readonly delayMs: number;
  readonly entry: StarappleBronVerificationEntry;
  readonly fetchImpl: FetchImpl;
  readonly maxProbes: number;
  readonly pages?: boolean;
  readonly probe?: boolean;
  readonly probedSoFar: number;
  readonly sleepImpl: (ms: number) => Promise<void>;
}): Promise<{
  readonly probesUsed: number;
  readonly result: StarappleBronVerificationResult;
}> => {
  const { entry } = input;
  // `unknown` resolutions carry no URL worth a request: bronUrl is "" and
  // previousUrl is the domain sentinel, so probing them would only burn
  // the bounded probe budget.
  if (!input.probe || entry.resolution.kind === "unknown") {
    return { probesUsed: 0, result: { ...entry } };
  }
  let probesUsed = 0;
  const budgetLeft = (): boolean =>
    input.probedSoFar + probesUsed < input.maxProbes;
  let previousProbe: StarappleBronProbeResult | undefined;
  let bronProbe: StarappleBronProbeResult | undefined;
  let pageFacts: StarapplePageFacts | undefined;
  if (
    entry.previousUrl.startsWith("http") &&
    entry.previousUrl !== entry.bronUrl &&
    budgetLeft()
  ) {
    probesUsed += 1;
    const probedPrevious = await probeUrl(entry.previousUrl, input.fetchImpl);
    previousProbe = probedPrevious.probe;
    await input.sleepImpl(input.delayMs);
  }
  if (entry.bronUrl && budgetLeft()) {
    probesUsed += 1;
    const probedBron = await probeUrl(entry.bronUrl, input.fetchImpl);
    bronProbe = probedBron.probe;
    // Page facts are live-vacancy evidence: archive resolutions can return
    // a Wayback toolbar or snapshot interstitial, and a redirect landing on
    // the homepage, a challenge page or a DIFFERENT vacancy must not have
    // its markup attributed to this row.
    const landedOnPlannedVacancy =
      probedBron.probe.finalUrl === null ||
      vacancyPathname(probedBron.probe.finalUrl) ===
        vacancyPathname(entry.bronUrl);
    if (
      input.pages &&
      probedBron.body !== null &&
      entry.resolution.kind === "live" &&
      landedOnPlannedVacancy
    ) {
      pageFacts = extractStarapplePageFacts(probedBron.body);
    }
    await input.sleepImpl(input.delayMs);
  }
  const result = { ...entry };
  const withPreviousProbe =
    previousProbe === undefined ? result : { ...result, previousProbe };
  const withBronProbe =
    bronProbe === undefined
      ? withPreviousProbe
      : { ...withPreviousProbe, bronProbe };
  return {
    probesUsed,
    result:
      pageFacts === undefined ? withBronProbe : { ...withBronProbe, pageFacts },
  };
};

/**
 * Runs the deterministic plan and — when `probe` is set — a bounded,
 * sequential live check of both the previously stored URL (audit evidence)
 * and the resolved bron-URL. `pages` additionally runs the Starapple page
 * extractor on bodies that answered 200. All network stays behind
 * `fetchImpl`/`sleepImpl` so the verification itself is testable offline.
 */
export const verifyStarappleBronUrls = async (input: {
  readonly delayMs?: number;
  readonly fetchImpl?: FetchImpl;
  readonly jobs: readonly MotianBronUrlJob[];
  readonly liveIndex: StarappleLiveIndex;
  readonly maxProbes?: number;
  readonly pages?: boolean;
  readonly probe?: boolean;
  readonly sitemapSource?: "file" | "live";
  readonly sitemapUrl?: string;
  readonly sleepImpl?: (ms: number) => Promise<void>;
  readonly timeoutMs?: number;
}): Promise<StarappleBronVerificationReceipt> => {
  const plan = planStarappleBronVerification({
    jobs: input.jobs,
    liveIndex: input.liveIndex,
  });
  const fetchImpl =
    input.fetchImpl ?? defaultFetch(input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const sleepImpl = input.sleepImpl ?? sleep;
  const maxProbes = input.maxProbes ?? DEFAULT_MAX_PROBES;
  const delayMs = input.delayMs ?? DEFAULT_DELAY_MS;

  let probed = 0;
  const results: StarappleBronVerificationResult[] = [];
  for (const entry of plan) {
    // oxlint-disable-next-line no-await-in-loop -- polite sequential probing is the contract
    const { probesUsed, result } = await probeVerificationEntry({
      delayMs,
      entry,
      fetchImpl,
      maxProbes,
      pages: input.pages,
      probe: input.probe,
      probedSoFar: probed,
      sleepImpl,
    });
    probed += probesUsed;
    results.push(result);
  }

  return {
    contractVersion: STARAPPLE_BRON_URL_VERIFY_VERSION,
    counts: {
      archive: results.filter((result) => result.resolution.kind === "archive")
        .length,
      liveExact: results.filter(
        (result) =>
          result.resolution.kind === "live" &&
          result.resolution.match === "exact"
      ).length,
      liveRematch: results.filter(
        (result) =>
          result.resolution.kind === "live" &&
          result.resolution.match === "rematch"
      ).length,
      probed,
      unknown: results.filter((result) => result.resolution.kind === "unknown")
        .length,
    },
    results,
    runAt: new Date().toISOString(),
    sitemap: {
      slugCount: input.liveIndex.slugs.size,
      source: input.sitemapSource ?? "live",
      url: input.sitemapUrl ?? STARAPPLE_VACANCY_SITEMAP_URL,
    },
  };
};

/** I/O boundary parse for the operator-supplied jobs export. */
const jobRowSchema = z.object({
  archived_at: z.string().nullable().optional(),
  deleted_at: z.string().nullable().optional(),
  external_id: z.string().trim().min(1),
  external_url: z.string().nullable().optional(),
  platform: z.string().min(1),
  status: z.string().nullable().optional(),
  title: z.string(),
});

const jobsFileSchema = z.union([
  z.array(jobRowSchema),
  z.object({ jobs: z.array(jobRowSchema) }),
]);

const parseJobsFile = (raw: string): MotianBronUrlJob[] => {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(
      "--jobs file must be a JSON array or {jobs:[...]} of Motian rows"
    );
  }
  const parsed = jobsFileSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(
      "--jobs file must be a JSON array or {jobs:[...]} of Motian rows"
    );
  }
  return Array.isArray(parsed.data) ? parsed.data : parsed.data.jobs;
};

/** A recorded fixture is a JSON envelope whose payload is the sitemap text. */
const fixtureEnvelopeSchema = z.object({ payload: z.string() }).loose();

const readSitemapXml = async (sitemapPath: string): Promise<string> => {
  const raw = await readFile(sitemapPath, "utf-8");
  try {
    const parsed = fixtureEnvelopeSchema.safeParse(JSON.parse(raw));
    if (parsed.success) {
      return parsed.data.payload;
    }
  } catch {
    // Not JSON — the file IS the raw sitemap.
  }
  return raw;
};

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "delay-ms": { type: "string" },
      jobs: { type: "string" },
      "max-probes": { type: "string" },
      out: { type: "string" },
      pages: { type: "boolean" },
      probe: { type: "boolean" },
      sitemap: { type: "string" },
      "timeout-ms": { type: "string" },
    },
  });
  if (!values.jobs) {
    throw new Error("--jobs <file.json> is required");
  }
  if (values.pages && !values.probe) {
    throw new Error(
      "--pages extracts facts from probed bodies and requires --probe"
    );
  }
  const timeoutMs = values["timeout-ms"]
    ? Number(values["timeout-ms"])
    : DEFAULT_TIMEOUT_MS;
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    throw new Error("--timeout-ms must be a positive number");
  }
  const maxProbes = values["max-probes"]
    ? Number(values["max-probes"])
    : DEFAULT_MAX_PROBES;
  if (!(Number.isInteger(maxProbes) && maxProbes >= 1)) {
    throw new Error("--max-probes must be a positive integer");
  }
  const delayMs = values["delay-ms"]
    ? Number(values["delay-ms"])
    : DEFAULT_DELAY_MS;
  if (!(Number.isFinite(delayMs) && delayMs >= 0)) {
    throw new Error("--delay-ms must be a non-negative number");
  }
  const jobs = parseJobsFile(await readFile(values.jobs, "utf-8"));

  let liveIndex: StarappleLiveIndex;
  let sitemapSource: "file" | "live";
  let sitemapUrl: string;
  if (values.sitemap) {
    liveIndex = buildStarappleLiveIndex(await readSitemapXml(values.sitemap));
    sitemapSource = "file";
    sitemapUrl = values.sitemap;
  } else {
    sitemapUrl = STARAPPLE_VACANCY_SITEMAP_URL;
    const response = await fetch(sitemapUrl, {
      headers: { "User-Agent": PROBE_USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`${sitemapUrl} answered HTTP ${response.status}`);
    }
    liveIndex = buildStarappleLiveIndex(await response.text());
    sitemapSource = "live";
  }

  const receipt = await verifyStarappleBronUrls({
    delayMs,
    jobs,
    liveIndex,
    maxProbes,
    pages: values.pages,
    probe: values.probe,
    sitemapSource,
    sitemapUrl,
    timeoutMs,
  });
  const json = `${JSON.stringify(receipt, null, 2)}\n`;
  if (values.out) {
    await writeFile(values.out, json);
    console.log(
      `${values.out}: ${receipt.counts.liveExact} exact, ${receipt.counts.liveRematch} rematch, ${receipt.counts.archive} archive, ${receipt.counts.unknown} unknown, ${receipt.counts.probed} probed`
    );
  } else {
    console.log(json);
  }
}
