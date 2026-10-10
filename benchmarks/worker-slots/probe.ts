import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { SOURCES } from "@ji/application/sources";
import type { SupportedBronSlug } from "@ji/application/sources";
import {
  asmlConfig,
  bamConfig,
  bluetrailConfig,
  datajobsConfig,
  enecoConfig,
  heijmansConfig,
  heroConfig,
  nsConfig,
  proActConfig,
  unicaConfig,
  vattenfallConfig,
  volkerwesselsConfig,
  werkenVoorNederlandConfig,
} from "@ji/connectors/json-ld";
import type {
  JsonLdConnectorConfig,
  JsonLdDiscoveryUrl,
} from "@ji/connectors/json-ld";

/**
 * CTP-634 worker-slot load probe: corpus and aggregation logic.
 *
 * The probe answers "does one fetch-worker process have headroom, or does a
 * second worker pay for itself?" by running an identical ingest corpus at 2,
 * 4, 6 and 8 concurrent bron-slots (independent durable-queue consumers on
 * the real `runBronIngestPipeline` path) and comparing resource/DB metrics.
 *
 * Corpus contract — equal at every level:
 * - the same 13 JSON-LD bronnen (the cohort proven end-to-end by CTP-630 /
 *   CTP-637 / CTP-638), seeded identically into a fresh per-level database;
 * - each bron's listing serves `itemsPerBron` minted detail URLs; every minted
 *   URL resolves to one of the bron's committed fixture bodies, so each item
 *   does real pipeline work (fixture read → persist → normalise → curate)
 *   while `bronReferentie` stays unique per item;
 * - `corpusDigest` pins bronnen × items × fixture URLs so a level comparison
 *   can never silently compare different workloads.
 *
 * What is deliberately NOT realistic: content diversity (minted items share a
 * fixture body per bron) and production crawl pacing (the seeded limiter is
 * the spec-test pacing, not the politeness budget a live bron carries — the
 * probe measures pipeline+DB ceiling, not source etiquette).
 */

export interface ProbeBronSpec {
  readonly bronId: string;
  readonly bronSlug: SupportedBronSlug;
  readonly categorie: string;
  readonly config: JsonLdConnectorConfig;
  /** Detail URLs backed by committed fixtures (`config.detailFixtures` keys). */
  readonly fixtureDetailUrls: readonly string[];
  readonly naam: string;
}

const spec = (
  bronSlug: SupportedBronSlug,
  categorie: string,
  config: JsonLdConnectorConfig,
  naam: string
): ProbeBronSpec => {
  const fixtureDetailUrls = Object.keys(config.detailFixtures ?? {});
  if (fixtureDetailUrls.length === 0) {
    throw new Error(`${bronSlug} has no committed detail fixtures`);
  }
  return {
    bronId: SOURCES[bronSlug].bronId,
    bronSlug,
    categorie,
    config,
    fixtureDetailUrls,
    naam,
  };
};

/**
 * The 13 bronnen proven end-to-end on the durable ingest path by the cohort
 * integration specs. Slugs whose fixture corpora never produced a persisted
 * item (or are covered by open lanes: zzp-opdrachten / tenderned / inhuurdesk)
 * are excluded on purpose.
 */
export const PROBE_BRONNEN: readonly ProbeBronSpec[] = [
  spec("asml", "werkgever", asmlConfig, "ASML"),
  spec("bam", "werkgever", bamConfig, "BAM"),
  spec("bluetrail", "msp_broker", bluetrailConfig, "BlueTrail"),
  spec("datajobs", "jobboard", datajobsConfig, "DataJobs.nl"),
  spec("eneco", "werkgever", enecoConfig, "Eneco"),
  spec("heijmans", "werkgever", heijmansConfig, "Heijmans"),
  spec("hero", "msp_broker", heroConfig, "Hero.eu"),
  spec("ns", "werkgever", nsConfig, "NS"),
  spec("pro-act", "msp_broker", proActConfig, "Pro-Act IT"),
  spec("unica", "werkgever", unicaConfig, "Unica"),
  spec("vattenfall", "werkgever", vattenfallConfig, "Vattenfall"),
  spec("volkerwessels", "werkgever", volkerwesselsConfig, "VolkerWessels"),
  spec(
    "werken-voor-nederland",
    "overheidsportaal",
    werkenVoorNederlandConfig,
    "Werken voor Nederland"
  ),
];

/**
 * Slot counts the decision compares; level = concurrent ingest jobs.
 * Level 1 is the production-shaped baseline: `apps/worker` currently runs a
 * single `runDurableBronJobConsumer` loop, so a one-slot level measures the
 * deployed shape directly rather than extrapolating to it.
 */
export const PROBE_LEVELS = [1, 2, 4, 6, 8] as const;

/** Path segment appended to a fixture detail URL to mint a unique referentie. */
export const MINTED_URL_SEGMENT = "/k5-mint-";

const MINTED_URL_PATTERN = /\/k5-mint-(?<index>\d+)$/u;

/**
 * Builds the bron's listing for the probe: `items` minted detail URLs that
 * cycle over the committed fixture URLs. Each minted URL is pathname-unique,
 * so `urlSlugBronReferentie` yields a distinct `bronReferentie` per item —
 * the dedupe/replay keys see genuinely different records.
 */
export const mintedListing = (
  bronSpec: ProbeBronSpec,
  items: number
): JsonLdDiscoveryUrl[] => {
  if (!Number.isInteger(items) || items < 1) {
    throw new Error("items per bron must be a positive integer");
  }
  const urls: JsonLdDiscoveryUrl[] = [];
  for (let index = 0; index < items; index += 1) {
    const base =
      bronSpec.fixtureDetailUrls[index % bronSpec.fixtureDetailUrls.length];
    if (base === undefined) {
      throw new Error(`${bronSpec.bronSlug} has no fixture detail URL`);
    }
    urls.push({ url: `${base}${MINTED_URL_SEGMENT}${index}` });
  }
  return urls;
};

/**
 * Maps a minted detail URL back to the committed fixture URL it serves. A
 * non-minted URL returns null — the probe client refuses anything else, so a
 * fixture leak (an unscoped listing URL reaching fetchDetail) fails loudly.
 */
export const resolveMintedDetailUrl = (url: string): string | null => {
  const match = MINTED_URL_PATTERN.exec(url);
  if (match === null) {
    return null;
  }
  return url.slice(0, match.index);
};

/** Workspace-rooted fixtures dir, mirroring connectors/src/fixtures/load.ts. */
const fixturePath = (relativePath: string): string =>
  path.resolve(
    import.meta.dir,
    "..",
    "..",
    "fixtures",
    "connectors",
    relativePath
  );

/**
 * Deterministic workload identity: bronnen (slug + fixture URL→content hash)
 * × items-per-bron. Hashing the fixture BODIES — not just the URL keys —
 * keeps the digest honest when a committed fixture changes under the same
 * URL: payload size, rejection behaviour and DB work all change with the
 * body, so the corpus identity must too. Two levels only compare when their
 * digests match; the digest goes into the results JSON and the report.
 */
export const corpusDigest = async (itemsPerBron: number): Promise<string> => {
  const canonical = await Promise.all(
    PROBE_BRONNEN.map(async (bronSpec) => ({
      bronId: bronSpec.bronId,
      bronSlug: bronSpec.bronSlug,
      fixtures: await Promise.all(
        [...bronSpec.fixtureDetailUrls].toSorted().map(async (url) => {
          const relativePath = bronSpec.config.detailFixtures?.[url];
          if (relativePath === undefined) {
            throw new Error(
              `${bronSpec.bronSlug} fixture URL ${url} has no file`
            );
          }
          const body = await readFile(fixturePath(relativePath));
          return {
            contentSha256: createHash("sha256").update(body).digest("hex"),
            url,
          };
        })
      ),
    }))
  );
  const digest = createHash("sha256")
    .update(JSON.stringify({ bronnen: canonical, itemsPerBron }))
    .digest("hex");
  return `sha256:${digest}`;
};

export const parseLevels = (raw: string): readonly number[] => {
  const parsed = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map(Number);
  if (parsed.length === 0) {
    throw new Error("K5_LEVELS must list at least one slot count");
  }
  for (const level of parsed) {
    // SAFETY: widening the tuple to a number array for includes() only —
    // membership is still restricted to PROBE_LEVELS values.
    if (!(PROBE_LEVELS as readonly number[]).includes(level)) {
      throw new Error(
        `Unsupported slot level ${level}; expected one of ${PROBE_LEVELS.join("/")}`
      );
    }
    if (level > PROBE_BRONNEN.length) {
      throw new Error(
        `Slot level ${level} exceeds the ${PROBE_BRONNEN.length}-bron corpus`
      );
    }
  }
  return [...new Set(parsed)].toSorted((left, right) => left - right);
};

export interface SampleSummary {
  readonly count: number;
  readonly max: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
}

/** Nearest-rank percentile, matching scripts/performance/core.ts semantics. */
export const percentile = (
  values: readonly number[],
  quantile: number
): number => {
  if (values.length === 0) {
    throw new Error("Cannot calculate a percentile without values");
  }
  if (quantile < 0 || quantile > 1) {
    throw new Error("Percentile quantile must be between 0 and 1");
  }
  const sorted = values.toSorted((left, right) => left - right);
  const index = Math.ceil(quantile * sorted.length) - 1;
  const result = sorted[Math.max(0, index)];
  if (result === undefined) {
    throw new Error("Percentile calculation produced no result");
  }
  return result;
};

/** Summarizes a latency/wait sample set; null summary on empty input. */
export const summarizeSamples = (
  values: readonly number[]
): SampleSummary | null => {
  if (values.length === 0) {
    return null;
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    max: percentile(values, 1),
    mean: Math.round((total / values.length) * 1000) / 1000,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
  };
};

/** Per-job timing as observed inside the consumer (take → pipeline return). */
export interface JobTiming {
  readonly bronSlug: string;
  readonly durationMs: number;
  /** offer→pipeline-complete freshness signal for this job. */
  readonly freshnessMs: number;
  /**
   * Items the pipeline rejected (e.g. Heijmans' committed soft-404 fixture).
   * Rejections are real pipeline work — fetch → parse → reject record — and
   * are counted explicitly rather than mislabeled as dedupe.
   */
  readonly rejectedRecords: number;
  readonly scrapeRunId: string;
  readonly writtenRecords: number;
}

export interface LevelJobRollup {
  readonly duration: SampleSummary | null;
  readonly freshness: SampleSummary | null;
  readonly itemsRejected: number;
  readonly itemsWritten: number;
}

/** Aggregates the per-job timings of one level into its report row. */
export const buildLevelJobRollup = (
  timings: readonly JobTiming[]
): LevelJobRollup => ({
  duration: summarizeSamples(timings.map((timing) => timing.durationMs)),
  freshness: summarizeSamples(timings.map((timing) => timing.freshnessMs)),
  itemsRejected: timings.reduce(
    (total, timing) => total + timing.rejectedRecords,
    0
  ),
  itemsWritten: timings.reduce(
    (total, timing) => total + timing.writtenRecords,
    0
  ),
});
