import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { promisify } from "node:util";

import type { CriticalPathLabel } from "../labels";
import { isCriticalPathLabel } from "../labels";
import { monotonicNowMs, readBunVersion } from "../monotonic";
import type { CriticalPathRecordSink } from "./sink";
import { resolveCriticalPathSink } from "./sink";

export type RunKind = "cold" | "unknown" | "warm";

export interface CriticalPathMetadata {
  branch?: string;
  "cache-state"?: string;
  commit?: string;
  concurrency?: string;
  dataset?: string;
  "dataset-digest"?: string;
  "error-count"?: string;
  "freshness-ms"?: string;
  "index-state"?: string;
  "item-count"?: string;
  job?: string;
  machine?: string;
  "percentile-p50"?: string;
  "percentile-p95"?: string;
  "percentile-p99"?: string;
  pipeline?: string;
  profile?: string;
  "postgres-image-digest"?: string;
  "postgres-version"?: string;
  provider?: string;
  "query-identity"?: string;
  "queryset-digest"?: string;
  region?: string;
  "records-per-second"?: string;
  "result-digest"?: string;
  runner?: string;
  "sequence-position"?: string;
  suite?: string;
  "timeout-count"?: string;
  toolchain?: string;
  "throughput-rps"?: string;
  "vacuum-state"?: string;
  "workload-version"?: string;
  workflow?: string;
  "instrumentation-overhead-ms"?: string;
}

export interface CriticalPathCohortDimensions {
  version: 2;
  label: CriticalPathLabel;
  executor: string;
  runKind: RunKind;
  commandFingerprint: string;
  provider: string | null;
  runner: string | null;
  machine: string;
  region: string | null;
  os: string;
  arch: string;
  bun: string;
  osRelease: string;
  cpuCount: number;
  cpuModel: string;
  memoryBytes: number;
  toolchain: string | null;
  cacheState: string | null;
  workflow: string | null;
  job: string | null;
  pipeline: string | null;
  suite: string | null;
  workloadVersion: string | null;
  workloadProfile: string | null;
  datasetDigest: string | null;
  querysetDigest: string | null;
  itemCount: number | null;
  concurrency: number | null;
  postgresImageDigest: string | null;
  postgresVersion: string | null;
  indexState: string | null;
  vacuumState: string | null;
}

export interface InProcessPerformanceRecord {
  schemaVersion: 1;
  id: string;
  attempt: number;
  retryOf: string | null;
  label: CriticalPathLabel;
  executor: string;
  runKind: RunKind;
  command: string[];
  commandFingerprint: string;
  cohortDimensions: CriticalPathCohortDimensions;
  cohortFingerprint: string;
  measurement: {
    boundary: CriticalPathLabel;
    kind: "in-process-monotonic";
    unit: "milliseconds";
  };
  startedAt: string;
  endedAt: string;
  durationMs: number;
  commandExitCode: number | null;
  commandStatus: "passed" | "failed" | "not-started";
  wrapperStatus: "complete";
  measurementError: null;
  git: { sha: string | null; dirty: boolean | null };
  runtime: {
    bun: string;
    os: string;
    osRelease: string;
    arch: string;
    cpuCount: number;
    cpuModel: string;
    memoryBytes: number;
  };
  resources: {
    cpuUserMicroseconds: number | null;
    cpuSystemMicroseconds: number | null;
    maxRssBytes: number | null;
    unsupportedReason: string | null;
  };
  metadata: CriticalPathMetadata;
}

export interface CriticalPathSessionOptions {
  attempt?: number;
  executor?: string;
  metadata?: CriticalPathMetadata;
  runKind?: RunKind;
  sink?: CriticalPathRecordSink;
}

interface PhaseSample {
  durationMs: number;
  endedAt: string;
  error?: string;
  label: CriticalPathLabel;
  startedAt: string;
  success: boolean;
}

const runtimeMetadata = (): InProcessPerformanceRecord["runtime"] => {
  const cpuList = cpus();
  return {
    arch: arch(),
    bun: readBunVersion(),
    cpuCount: cpuList.length,
    cpuModel: cpuList[0]?.model ?? "unavailable",
    memoryBytes: totalmem(),
    os: platform(),
    osRelease: release(),
  };
};

const fingerprintCommand = (command: string[]): string =>
  createHash("sha256").update(JSON.stringify(command)).digest("hex");

const syntheticCommand = (label: CriticalPathLabel): string[] => [
  "@ji/critical-path",
  label,
];

const execFileAsync = promisify(execFile);

const runGit = async (args: string[]): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync("git", args);
    return stdout.trim();
  } catch {
    return null;
  }
};

const collectGitMetadata = async (): Promise<
  InProcessPerformanceRecord["git"]
> => {
  const [sha, status] = await Promise.all([
    runGit(["rev-parse", "HEAD"]),
    runGit(["status", "--porcelain"]),
  ]);
  const dirty = status === null ? null : status.length > 0;
  const fullSha =
    sha !== null && /^(?:[a-f\d]{40}|[a-f\d]{64})$/iu.test(sha) ? sha : null;
  if (fullSha === null || dirty === null) {
    return { dirty: null, sha: null };
  }
  return { dirty, sha: fullSha };
};

const optionalMetadataInteger = (value: string | undefined): number | null => {
  if (value === undefined) {
    return null;
  }
  const parsed = Number(value);
  if (!/^(?:0|[1-9]\d*)$/u.test(value) || !Number.isSafeInteger(parsed)) {
    return null;
  }
  return parsed;
};

const createCohortDimensions = (input: {
  commandFingerprint: string;
  executor: string;
  label: CriticalPathLabel;
  metadata: CriticalPathMetadata;
  runKind: RunKind;
  runtime: InProcessPerformanceRecord["runtime"];
}): CriticalPathCohortDimensions => ({
  arch: input.runtime.arch,
  bun: input.runtime.bun,
  cacheState: input.metadata["cache-state"] ?? null,
  commandFingerprint: input.commandFingerprint,
  concurrency: optionalMetadataInteger(input.metadata.concurrency),
  cpuCount: input.runtime.cpuCount,
  cpuModel: input.runtime.cpuModel,
  datasetDigest: input.metadata["dataset-digest"] ?? null,
  executor: input.executor,
  indexState: input.metadata["index-state"] ?? null,
  itemCount: optionalMetadataInteger(input.metadata["item-count"]),
  job: input.metadata.job ?? null,
  label: input.label,
  machine:
    input.metadata.machine ??
    `${input.runtime.cpuCount}cpu-${input.runtime.memoryBytes}b`,
  memoryBytes: input.runtime.memoryBytes,
  os: input.runtime.os,
  osRelease: input.runtime.osRelease,
  pipeline: input.metadata.pipeline ?? null,
  postgresImageDigest: input.metadata["postgres-image-digest"] ?? null,
  postgresVersion: input.metadata["postgres-version"] ?? null,
  provider: input.metadata.provider ?? null,
  querysetDigest: input.metadata["queryset-digest"] ?? null,
  region: input.metadata.region ?? null,
  runKind: input.runKind,
  runner: input.metadata.runner ?? null,
  suite: input.metadata.suite ?? null,
  toolchain: input.metadata.toolchain ?? null,
  vacuumState: input.metadata["vacuum-state"] ?? null,
  version: 2,
  workflow: input.metadata.workflow ?? null,
  workloadProfile: input.metadata.profile ?? null,
  workloadVersion: input.metadata["workload-version"] ?? null,
});

const fingerprintCohort = (dimensions: CriticalPathCohortDimensions): string =>
  createHash("sha256").update(JSON.stringify(dimensions)).digest("hex");

const buildRecord = (input: {
  attempt: number;
  executor: string;
  git: InProcessPerformanceRecord["git"];
  metadata: CriticalPathMetadata;
  runKind: RunKind;
  runtime: InProcessPerformanceRecord["runtime"];
  sample: PhaseSample;
}): InProcessPerformanceRecord => {
  const command = syntheticCommand(input.sample.label);
  const commandFingerprint = fingerprintCommand(command);
  const cohortDimensions = createCohortDimensions({
    commandFingerprint,
    executor: input.executor,
    label: input.sample.label,
    metadata: input.metadata,
    runKind: input.runKind,
    runtime: input.runtime,
  });
  return {
    attempt: input.attempt,
    cohortDimensions,
    cohortFingerprint: fingerprintCohort(cohortDimensions),
    command,
    commandExitCode: input.sample.success ? 0 : 1,
    commandFingerprint,
    commandStatus: input.sample.success ? "passed" : "failed",
    durationMs: input.sample.durationMs,
    endedAt: input.sample.endedAt,
    executor: input.executor,
    git: input.git,
    id: randomUUID(),
    label: input.sample.label,
    measurement: {
      boundary: input.sample.label,
      kind: "in-process-monotonic",
      unit: "milliseconds",
    },
    measurementError: null,
    metadata: input.metadata,
    resources: {
      cpuSystemMicroseconds: null,
      cpuUserMicroseconds: null,
      maxRssBytes: null,
      unsupportedReason: "in-process-phase",
    },
    retryOf: null,
    runKind: input.runKind,
    runtime: input.runtime,
    schemaVersion: 1,
    startedAt: input.sample.startedAt,
    wrapperStatus: "complete",
  };
};

export class CriticalPathSession {
  private readonly attempt: number;
  private readonly executor: string;
  private gitPromise: Promise<InProcessPerformanceRecord["git"]> | undefined;
  private readonly metadata: CriticalPathMetadata;
  private readonly runKind: RunKind;
  private readonly runtime: InProcessPerformanceRecord["runtime"];
  private readonly samples: PhaseSample[] = [];
  private readonly sink: CriticalPathRecordSink;

  constructor(options: CriticalPathSessionOptions = {}) {
    this.attempt = options.attempt ?? 1;
    this.executor = options.executor ?? "runtime";
    this.metadata = options.metadata ?? {};
    this.runKind = options.runKind ?? "unknown";
    this.runtime = runtimeMetadata();
    this.sink = options.sink ?? resolveCriticalPathSink();
  }

  getSamples(): readonly PhaseSample[] {
    return this.samples;
  }

  mergeMetadata(metadata: CriticalPathMetadata): void {
    Object.assign(this.metadata, metadata);
  }

  async timePhase<Result>(
    label: CriticalPathLabel,
    operation: () => Promise<Result>
  ): Promise<Result> {
    const startedMs = monotonicNowMs();
    const startedAt = new Date().toISOString();
    try {
      const result = await operation();
      this.recordSample({
        durationMs: Math.round(monotonicNowMs() - startedMs),
        endedAt: new Date().toISOString(),
        label,
        startedAt,
        success: true,
      });
      return result;
    } catch (error) {
      this.recordSample({
        durationMs: Math.round(monotonicNowMs() - startedMs),
        endedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
        label,
        startedAt,
        success: false,
      });
      throw error;
    }
  }

  timePhaseSync<Result>(
    label: CriticalPathLabel,
    operation: () => Result
  ): Result {
    const startedMs = monotonicNowMs();
    const startedAt = new Date().toISOString();
    try {
      const result = operation();
      this.recordSample({
        durationMs: Math.round(monotonicNowMs() - startedMs),
        endedAt: new Date().toISOString(),
        label,
        startedAt,
        success: true,
      });
      return result;
    } catch (error) {
      this.recordSample({
        durationMs: Math.round(monotonicNowMs() - startedMs),
        endedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
        label,
        startedAt,
        success: false,
      });
      throw error;
    }
  }

  recordSample(sample: PhaseSample): void {
    if (!isCriticalPathLabel(sample.label)) {
      throw new Error(`Unsupported critical-path label: ${sample.label}`);
    }
    this.samples.push(sample);
  }

  async flush(): Promise<InProcessPerformanceRecord[]> {
    if (this.samples.length === 0) {
      return [];
    }
    this.gitPromise ??= collectGitMetadata();
    const git = await this.gitPromise;
    const records = this.samples.map((sample) =>
      buildRecord({
        attempt: this.attempt,
        executor: this.executor,
        git,
        metadata: this.metadata,
        runKind: this.runKind,
        runtime: this.runtime,
        sample,
      })
    );
    await this.sink.write(records);
    return records;
  }
}

export const createCriticalPathSession = (
  options?: CriticalPathSessionOptions
): CriticalPathSession => new CriticalPathSession(options);

export const resolveRunKind = (): RunKind => {
  const value = process.env.PERF_RUN_KIND;
  if (value === "cold" || value === "warm") {
    return value;
  }
  return "unknown";
};

export const buildWorkloadMetadata = (): CriticalPathMetadata => ({
  "cache-state": process.env.PERF_CACHE_STATE,
  concurrency: process.env.PERF_CONCURRENCY,
  dataset: process.env.PERF_DATASET,
  "dataset-digest": process.env.PERF_DATASET_DIGEST,
  "index-state": process.env.PERF_INDEX_STATE,
  "item-count": process.env.PERF_ITEM_COUNT,
  "postgres-image-digest": process.env.PERF_POSTGRES_IMAGE_DIGEST,
  "postgres-version": process.env.PERF_POSTGRES_VERSION,
  profile: process.env.PERF_PROFILE,
  "queryset-digest": process.env.PERF_QUERYSET_DIGEST,
  "vacuum-state": process.env.PERF_VACUUM_STATE,
  "workload-version": process.env.PERF_WORKLOAD_VERSION,
});

export const percentile = (values: number[], quantile: number): number => {
  if (values.length === 0) {
    throw new Error("Cannot calculate a percentile without values");
  }
  const sorted = values.toSorted((left, right) => left - right);
  const index = Math.ceil(quantile * sorted.length) - 1;
  const result = sorted[Math.max(0, index)];
  if (result === undefined) {
    throw new Error("Percentile calculation produced no result");
  }
  return result;
};

export const buildSearchSummaryRecord = async (input: {
  durationsMs: number[];
  errorCount: number;
  metadata: CriticalPathMetadata;
  timeoutCount: number;
}): Promise<InProcessPerformanceRecord | null> => {
  if (input.durationsMs.length === 0) {
    return null;
  }
  const p50 = percentile(input.durationsMs, 0.5);
  const p95 = percentile(input.durationsMs, 0.95);
  const p99 = percentile(input.durationsMs, 0.99);
  const totalMs = input.durationsMs.reduce((sum, value) => sum + value, 0);
  const throughput =
    totalMs > 0
      ? ((input.durationsMs.length * 1000) / totalMs).toFixed(3)
      : "0";
  const session = new CriticalPathSession({
    metadata: {
      ...input.metadata,
      "error-count": String(input.errorCount),
      "percentile-p50": String(Math.round(p50)),
      "percentile-p95": String(Math.round(p95)),
      "percentile-p99": String(Math.round(p99)),
      "throughput-rps": throughput,
      "timeout-count": String(input.timeoutCount),
    },
  });
  session.recordSample({
    durationMs: Math.round(p95),
    endedAt: new Date().toISOString(),
    label: "search-summary",
    startedAt: new Date().toISOString(),
    success: input.errorCount === 0 && input.timeoutCount === 0,
  });
  const [record] = await session.flush();
  return record ?? null;
};
