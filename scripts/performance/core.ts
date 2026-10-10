import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { arch, cpus, platform, release, totalmem } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  isDatasetDigest,
  parsePerformanceRecord,
  PerformanceSchemaError,
} from "./record";
import type {
  CohortDimensions,
  JsonValue,
  PerformanceMetadata,
  PerformanceRecord,
  RunKind,
} from "./record";

export type {
  CohortDimensions,
  PerformanceMetadata,
  PerformanceRecord,
  RunKind,
} from "./record";

export const DEFAULT_OUTPUT_DIR = ".artifacts/performance";

const SECRET_KEY_PATTERN =
  /(?:^|[-_])(?:api[-_]?key|auth(?:orization)?|cookie|credential|database[-_]?url|dsn|password|secret|token)$/iu;
const CLOUD_CREDENTIAL_KEY_PATTERN =
  /^(?:aws[-_]?(?:access[-_]?key[-_]?id|secret[-_]?access[-_]?key|session[-_]?token)|x[-_]?(?:amz|goog)[-_]?(?:credential|security[-_]?token))$/iu;
const COMPACT_DATABASE_CREDENTIAL_KEY_PATTERN = /^(?:MYSQL_PWD|PGPASSWORD)$/iu;
const SENSITIVE_CREDENTIAL_FLAG_PATTERN =
  /^(?:-u|--user|--proxy-user|--(?:[a-z\d]+[-_])*(?:api[-_]?key|auth(?:orization)?|cookie|credential|database[-_]?url|dsn|password|secret|token)|--(?:aws[-_]?(?:access[-_]?key[-_]?id|secret[-_]?access[-_]?key|session[-_]?token)|x[-_]?(?:amz|goog)[-_]?(?:credential|security[-_]?token)))$/iu;
const CREDENTIAL_URL_PATTERN = /(?<scheme>[a-z][a-z\d+.-]*:\/\/)[^/\s@]+@/giu;
const INLINE_CREDENTIAL_FLAG_PATTERN =
  /(?<prefix>(?:^|\s)(?:-u|--user|--proxy-user|--(?:[a-z\d]+[-_])*(?:api[-_]?key|auth(?:orization)?|cookie|credential|database[-_]?url|dsn|password|secret|token))(?:=|\s+))[^\s]+/giu;
const SECRET_QUERY_PATTERN =
  /(?<prefix>[?&](?:access[-_]?token|api[-_]?key|auth|aws[-_]?access[-_]?key[-_]?id|client[-_]?secret|credential|id[-_]?token|oauth[-_]?(?:consumer[-_]?key|nonce|signature|token)|password|refresh[-_]?token|secret|sig|signature|token|x[-_]?(?:amz|goog)[-_]?(?:credential|security[-_]?token|signature))=)[^&\s]+/giu;
const SENSITIVE_HEADER_NAME_SOURCE =
  "(?:authorization|cookie|proxy-authorization|set-cookie|x[-_]?api[-_]?key|(?:[a-z\\d]+[-_])*(?:api[-_]?key|access[-_]?token|auth[-_]?token|client[-_]?secret|key|secret|token))";
const SENSITIVE_HEADER_PATTERN = new RegExp(
  `^${SENSITIVE_HEADER_NAME_SOURCE}\\s*:`,
  "iu"
);
const INLINE_SENSITIVE_HEADER_PATTERN = new RegExp(
  `(?<prefix>(?<![a-z\\d_-])${SENSITIVE_HEADER_NAME_SOURCE}\\s*:)\\s*[^\\r\\n]*`,
  "giu"
);
const ARBITRARY_URL_PATTERN = /\b[a-z][a-z\d+.-]*:\/\/\S+/giu;
const FULL_GIT_SHA_PATTERN = /^(?:[a-f\d]{40}|[a-f\d]{64})$/iu;
const INLINE_SECRET_VALUE_PATTERN =
  /(?<prefix>\b(?:access[-_]?token|api[-_]?key|auth(?:orization)?|client[-_]?secret|credential|database[-_]?url|dsn|password|refresh[-_]?token|secret|token)(?:=|:|\/))[^/\s?&]+/giu;
const INLINE_COMPACT_DATABASE_CREDENTIAL_PATTERN =
  /(?<prefix>\b(?:MYSQL_PWD|PGPASSWORD)=)[^\r\n]*/giu;
const SAFE_METADATA_VALUE_PATTERN = /^[\w./:@+?&=% -]+$/u;
const SAFE_METADATA_KEYS = new Set([
  "branch",
  "cache-state",
  "commit",
  "concurrency",
  "dataset",
  "dataset-digest",
  "error-count",
  "freshness-ms",
  "instrumentation-overhead-ms",
  "item-count",
  "index-state",
  "job",
  "machine",
  "percentile-p50",
  "percentile-p95",
  "percentile-p99",
  "pipeline",
  "profile",
  "postgres-image-digest",
  "postgres-version",
  "provider",
  "query-identity",
  "queryset-digest",
  "records-per-second",
  "region",
  "result-digest",
  "runner",
  "sequence-position",
  "suite",
  "timeout-count",
  "throughput-rps",
  "toolchain",
  "vacuum-state",
  "workload-version",
  "workflow",
]);

export interface AggregateRow {
  label: string;
  cohort: string;
  samples: number;
  passed: number;
  failed: number;
  successfulTotalMs: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

const shellQuote = (value: string): string => {
  if (/^[\w./:@%+=,-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
};

export const redactEvidenceText = (value: string): string =>
  value
    .replaceAll(ARBITRARY_URL_PATTERN, "[REDACTED_URL]")
    .replaceAll(CREDENTIAL_URL_PATTERN, "$<scheme>[REDACTED]@")
    .replaceAll(SECRET_QUERY_PATTERN, "$<prefix>[REDACTED]")
    .replaceAll(INLINE_CREDENTIAL_FLAG_PATTERN, "$<prefix>[REDACTED]")
    .replaceAll(INLINE_SENSITIVE_HEADER_PATTERN, "$<prefix> [REDACTED]")
    .replaceAll(/\bBearer\s+[^\s'";,]+/giu, "Bearer [REDACTED]")
    .replaceAll(
      INLINE_COMPACT_DATABASE_CREDENTIAL_PATTERN,
      "$<prefix>[REDACTED]"
    )
    .replaceAll(INLINE_SECRET_VALUE_PATTERN, "$<prefix>[REDACTED]");

const isSensitiveAssignmentKey = (key: string): boolean =>
  key.startsWith("-")
    ? SENSITIVE_CREDENTIAL_FLAG_PATTERN.test(key)
    : SECRET_KEY_PATTERN.test(key) ||
      CLOUD_CREDENTIAL_KEY_PATTERN.test(key) ||
      COMPACT_DATABASE_CREDENTIAL_KEY_PATTERN.test(key);

const redactCompactDatabaseAssignment = (value: string): string | null => {
  const openingQuote = value[0] === '"' || value[0] === "'" ? value[0] : null;
  const hasClosingQuote =
    openingQuote !== null && value.length > 1 && value.endsWith(openingQuote);
  const assignment =
    openingQuote === null
      ? value
      : value.slice(1, hasClosingQuote ? -1 : undefined);
  const separator = assignment.indexOf("=");
  if (separator < 1) {
    return null;
  }
  const key = assignment.slice(0, separator);
  if (!COMPACT_DATABASE_CREDENTIAL_KEY_PATTERN.test(key)) {
    return null;
  }
  const opening = openingQuote ?? "";
  const closing = hasClosingQuote ? (openingQuote ?? "") : "";
  return `${opening}${key}=[REDACTED]${closing}`;
};

const redactSensitiveHeader = (value: string): string | null => {
  const openingQuote = value[0] === '"' || value[0] === "'" ? value[0] : null;
  const hasClosingQuote =
    openingQuote !== null && value.length > 1 && value.endsWith(openingQuote);
  const header =
    openingQuote === null
      ? value
      : value.slice(1, hasClosingQuote ? -1 : undefined);
  if (!SENSITIVE_HEADER_PATTERN.test(header)) {
    return null;
  }
  const name = header.slice(0, header.indexOf(":"));
  const opening = openingQuote ?? "";
  const closing = hasClosingQuote ? (openingQuote ?? "") : "";
  return `${opening}${name}: [REDACTED]${closing}`;
};

const redactAssignmentArgument = (argument: string): string | null => {
  const directCompactDatabaseAssignment =
    redactCompactDatabaseAssignment(argument);
  if (directCompactDatabaseAssignment !== null) {
    return directCompactDatabaseAssignment;
  }

  const equalsIndex = argument.indexOf("=");
  if (equalsIndex < 1) {
    return null;
  }
  const key = argument.slice(0, equalsIndex);
  const value = argument.slice(equalsIndex + 1);
  const isAssignmentKey = /^(?:--?)?[a-z_][a-z\d_-]*$/iu.test(key);
  if (isAssignmentKey && isSensitiveAssignmentKey(key)) {
    return `${key}=[REDACTED]`;
  }
  const nestedCompactDatabaseAssignment =
    redactCompactDatabaseAssignment(value);
  if (isAssignmentKey && nestedCompactDatabaseAssignment !== null) {
    return `${key}=${nestedCompactDatabaseAssignment}`;
  }
  if (key === "--header" || key === "--proxy-header") {
    const redactedHeader = redactSensitiveHeader(value);
    return redactedHeader === null ? null : `${key}=${redactedHeader}`;
  }
  return null;
};

export const redactCommand = (command: string[]): string[] => {
  const redacted: string[] = [];
  let redactNext = false;

  let redactHeaderNext = false;
  for (const argument of command) {
    if (redactNext) {
      redacted.push("[REDACTED]");
      redactNext = false;
      continue;
    }
    if (redactHeaderNext) {
      redacted.push(
        redactSensitiveHeader(argument) ?? redactEvidenceText(argument)
      );
      redactHeaderNext = false;
      continue;
    }
    const directSensitiveHeader = redactSensitiveHeader(argument);
    if (directSensitiveHeader !== null) {
      redacted.push(directSensitiveHeader);
      continue;
    }

    const redactedAssignment = redactAssignmentArgument(argument);
    if (redactedAssignment !== null) {
      redacted.push(redactedAssignment);
      continue;
    }

    if (
      argument === "-H" ||
      argument === "--header" ||
      argument === "--proxy-header"
    ) {
      redacted.push(argument);
      redactHeaderNext = true;
      continue;
    }

    if (SENSITIVE_CREDENTIAL_FLAG_PATTERN.test(argument)) {
      redacted.push(argument);
      redactNext = true;
      continue;
    }

    if (/^-u[^-]/u.test(argument)) {
      redacted.push("-u[REDACTED]");
      continue;
    }
    if (argument.startsWith("-H")) {
      const redactedHeader = redactSensitiveHeader(argument.slice(2));
      if (redactedHeader !== null) {
        redacted.push(`-H${redactedHeader}`);
        continue;
      }
    }

    redacted.push(redactEvidenceText(argument));
  }

  return redacted;
};

export const fingerprintCommand = (redactedCommand: string[]): string =>
  createHash("sha256").update(JSON.stringify(redactedCommand)).digest("hex");

export const validateDatasetIdentity = (
  metadata: PerformanceMetadata
): void => {
  const datasetDigest = metadata["dataset-digest"];
  if (metadata.dataset !== undefined && datasetDigest === undefined) {
    throw new Error("Metadata dataset requires dataset-digest");
  }
  if (datasetDigest !== undefined && !isDatasetDigest(datasetDigest)) {
    throw new Error(
      "Metadata dataset-digest must match <algorithm>:<digest> using safe characters"
    );
  }
};

const NON_NEGATIVE_INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/u;

const optionalMetadataInteger = (
  value: string | undefined,
  key: "concurrency" | "item-count"
): number | null => {
  if (value === undefined) {
    return null;
  }
  const parsed = Number(value);
  if (
    !NON_NEGATIVE_INTEGER_PATTERN.test(value) ||
    !Number.isSafeInteger(parsed)
  ) {
    throw new Error(`Metadata ${key} must be a non-negative safe integer`);
  }
  return parsed;
};

export const parseMetadata = (entries: string[]): PerformanceMetadata => {
  const metadata: PerformanceMetadata = {};

  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator < 1) {
      throw new Error(`Metadata must use key=value: ${entry}`);
    }
    const unsafeKey = entry.slice(0, separator);
    const value = entry.slice(separator + 1);
    if (!SAFE_METADATA_KEYS.has(unsafeKey)) {
      throw new Error(`Metadata key is not allowlisted: ${unsafeKey}`);
    }
    const isDatasetDigestEntry = unsafeKey === "dataset-digest";
    if (
      (!value || !SAFE_METADATA_VALUE_PATTERN.test(value)) &&
      !isDatasetDigestEntry
    ) {
      throw new Error(`Metadata contains unsupported characters: ${unsafeKey}`);
    }
    // SAFETY: Set membership above narrows this runtime string to the explicit
    // PerformanceMetadata allowlist owned by this module.
    const key = unsafeKey as keyof PerformanceMetadata;
    if (key === "sequence-position") {
      const sequencePosition = Number(value);
      if (
        !Number.isInteger(sequencePosition) ||
        sequencePosition < 1 ||
        sequencePosition > 10_000
      ) {
        throw new Error(
          "Metadata sequence-position must be an integer from 1 through 10000"
        );
      }
    }
    if (key === "concurrency" || key === "item-count") {
      optionalMetadataInteger(value, key);
    }
    metadata[key] = redactEvidenceText(value);
  }

  validateDatasetIdentity(metadata);
  return metadata;
};

export const createCohortDimensions = (input: {
  label: string;
  executor: string;
  runKind: RunKind;
  commandFingerprint: string;
  runtime: PerformanceRecord["runtime"];
  metadata: PerformanceMetadata;
}): CohortDimensions => {
  validateDatasetIdentity(input.metadata);
  return {
    arch: input.runtime.arch,
    bun: input.runtime.bun,
    cacheState: input.metadata["cache-state"] ?? null,
    commandFingerprint: input.commandFingerprint,
    concurrency: optionalMetadataInteger(
      input.metadata.concurrency,
      "concurrency"
    ),
    cpuCount: input.runtime.cpuCount,
    cpuModel: input.runtime.cpuModel,
    datasetDigest: input.metadata["dataset-digest"] ?? null,
    executor: input.executor,
    indexState: input.metadata["index-state"] ?? null,
    itemCount: optionalMetadataInteger(
      input.metadata["item-count"],
      "item-count"
    ),
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
  };
};

export const fingerprintCohort = (dimensions: CohortDimensions): string =>
  createHash("sha256").update(JSON.stringify(dimensions)).digest("hex");

const runGit = async (args: string[]): Promise<string | null> => {
  try {
    const process = Bun.spawn(["git", ...args], {
      stderr: "ignore",
      stdout: "pipe",
    });
    const output = await new Response(process.stdout).text();
    const exitCode = await process.exited;
    return exitCode === 0 ? output.trim() : null;
  } catch {
    return null;
  }
};

export const isGitBound = (git: PerformanceRecord["git"]): boolean =>
  git.dirty !== null && git.sha !== null && FULL_GIT_SHA_PATTERN.test(git.sha);

export const collectGitMetadata = async (): Promise<
  PerformanceRecord["git"]
> => {
  const [sha, status] = await Promise.all([
    runGit(["rev-parse", "HEAD"]),
    runGit(["status", "--porcelain"]),
  ]);
  const git = {
    dirty: status === null ? null : status.length > 0,
    sha: sha || null,
  };
  return isGitBound(git) ? git : { dirty: null, sha: null };
};

export const percentile = (values: number[], quantile: number): number => {
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

export const aggregateRecords = (
  records: PerformanceRecord[]
): AggregateRow[] => {
  const groups = new Map<
    string,
    { label: string; cohort: string; records: PerformanceRecord[] }
  >();
  for (const record of records) {
    if (!isGitBound(record.git)) {
      continue;
    }
    const dimensions = record.cohortDimensions;
    const cohort = `v${dimensions.version}:${record.cohortFingerprint.slice(0, 12)} · ${dimensions.runKind} · ${dimensions.executor} · ${dimensions.os}/${dimensions.arch}`;
    const key = `${record.label}\u0000${record.cohortFingerprint}`;
    const group = groups.get(key) ?? {
      cohort,
      label: record.label,
      records: [],
    };
    group.records.push(record);
    groups.set(key, group);
  }

  return [...groups.values()]
    .toSorted((left, right) =>
      `${left.label}\u0000${left.cohort}`.localeCompare(
        `${right.label}\u0000${right.cohort}`
      )
    )
    .map(({ label, cohort, records: samples }) => {
      const successfulDurations = samples
        .filter(
          (sample) =>
            sample.commandExitCode === 0 && sample.wrapperStatus === "complete"
        )
        .map((sample) => sample.durationMs);
      return {
        cohort,
        failed: samples.filter(
          (sample) =>
            sample.commandExitCode !== 0 || sample.wrapperStatus !== "complete"
        ).length,
        label,
        p50Ms:
          successfulDurations.length > 0
            ? percentile(successfulDurations, 0.5)
            : null,
        p95Ms:
          successfulDurations.length > 0
            ? percentile(successfulDurations, 0.95)
            : null,
        passed: successfulDurations.length,
        samples: samples.length,
        successfulTotalMs: successfulDurations.reduce(
          (total, duration) => total + duration,
          0
        ),
      };
    });
};

const formatDuration = (durationMs: number): string =>
  durationMs < 1000
    ? `${durationMs} ms`
    : `${(durationMs / 1000).toFixed(2)} s`;

const formatOptionalDuration = (durationMs: number | null): string =>
  durationMs === null ? "n/a" : formatDuration(durationMs);

const escapeMarkdownTableCell = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll(/\r\n?|\n/gu, " ");

const renderMarkdownCodeBlock = (value: string): string => {
  const longestBacktickRun = Math.max(
    0,
    ...(value.match(/`+/gu) ?? []).map((run) => run.length)
  );
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}text\n${value}\n${fence}`;
};

export const renderRecordMarkdown = (record: PerformanceRecord): string => {
  const command = record.command.map(shellQuote).join(" ");
  return `# Performance: ${record.label}

| Metric | Value |
| --- | --- |
| Command status | ${record.commandStatus} |
| Wrapper status | ${record.wrapperStatus} |
| Duration | ${formatDuration(record.durationMs)} |
| Started | ${record.startedAt} |
| Executor | ${record.executor} |
| Run kind | ${record.runKind} |
| Git SHA | ${record.git.sha ?? "unavailable"} |
| Dirty | ${record.git.dirty ?? "unavailable"} |

${renderMarkdownCodeBlock(command)}
`;
};

export const renderAggregateMarkdown = (
  records: PerformanceRecord[]
): string => {
  const comparableRecords = records.filter((record) => isGitBound(record.git));
  const excludedRecords = records.length - comparableRecords.length;
  const rows = aggregateRecords(comparableRecords);
  const totalMs = comparableRecords.reduce(
    (total, record) => total + record.durationMs,
    0
  );
  const tableRows = rows
    .map(
      (row) =>
        `| ${escapeMarkdownTableCell(row.label)} | ${escapeMarkdownTableCell(row.cohort)} | ${row.failed === 0 ? "passed" : "failed"} | ${row.samples} | ${row.passed} | ${row.failed} | ${formatDuration(row.successfulTotalMs)} | ${formatOptionalDuration(row.p50Ms)} | ${formatOptionalDuration(row.p95Ms)} | ${row.passed < 100 ? "low N" : "stable N"} |`
    )
    .join("\n");

  return `# Performance report

| Phase | Cohort | Status | N | Passed | Failed | Successful duration sum | p50 | p95 | Tail signal |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
${tableRows || "| No records | - | - | 0 | 0 | 0 | 0 ms | n/a | n/a | low N |"}

**Sum of recorded durations (not end-to-end wall-clock):** ${formatDuration(totalMs)}

**Excluded as non-comparable:** ${excludedRecords} record(s) without a complete Git SHA and dirty/clean binding.

> p95 is an unstable tail signal when fewer than 100 successful samples are available in a cohort. Always compare N and failure count.
`;
};

export const atomicWrite = async (
  destination: string,
  content: string
): Promise<void> => {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(temporary, content);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
};

export const writeRecord = async (
  outputDirectory: string,
  record: PerformanceRecord
): Promise<{ json: string; markdown: string }> => {
  await mkdir(outputDirectory, { recursive: true });
  const stem = `${record.startedAt.replaceAll(/[:.]/gu, "-")}-${record.label.replaceAll(/[^a-zA-Z0-9_-]/gu, "-")}-${record.id}`;
  const json = path.join(outputDirectory, `${stem}.json`);
  const markdown = path.join(outputDirectory, `${stem}.md`);
  try {
    await atomicWrite(markdown, renderRecordMarkdown(record));
    await atomicWrite(json, `${JSON.stringify(record, null, 2)}\n`);
  } catch (error) {
    await Promise.all([
      rm(json, { force: true }),
      rm(markdown, { force: true }),
    ]);
    throw error;
  }
  return { json, markdown };
};

const validateCredentialRedaction = (
  record: PerformanceRecord,
  filename: string
): void => {
  if (
    JSON.stringify(redactCommand(record.command)) !==
    JSON.stringify(record.command)
  ) {
    throw new PerformanceSchemaError(
      filename,
      "command contains unredacted credentials"
    );
  }
  if (
    Object.values(record.metadata).some(
      (value) => value !== undefined && redactEvidenceText(value) !== value
    )
  ) {
    throw new PerformanceSchemaError(
      filename,
      "metadata contains unredacted credentials"
    );
  }
  if (
    record.measurementError !== null &&
    redactEvidenceText(record.measurementError.message) !==
      record.measurementError.message
  ) {
    throw new PerformanceSchemaError(
      filename,
      "measurementError contains unredacted evidence text"
    );
  }
};

const cohortIdentityMatchesRecord = (
  record: PerformanceRecord,
  filename: string
): boolean => {
  try {
    return isDeepStrictEqual(
      record.cohortDimensions,
      createCohortDimensions({
        commandFingerprint: record.commandFingerprint,
        executor: record.executor,
        label: record.label,
        metadata: record.metadata,
        runKind: record.runKind,
        runtime: record.runtime,
      })
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PerformanceSchemaError(filename, detail);
  }
};

const validateRecordInvariants = (
  record: PerformanceRecord,
  filename: string
): PerformanceRecord => {
  let expectedCommandStatus: PerformanceRecord["commandStatus"] = "not-started";
  if (record.commandExitCode !== null) {
    expectedCommandStatus = record.commandExitCode === 0 ? "passed" : "failed";
  }
  if (record.commandStatus !== expectedCommandStatus) {
    throw new PerformanceSchemaError(
      filename,
      "commandStatus does not match commandExitCode"
    );
  }
  if (fingerprintCommand(record.command) !== record.commandFingerprint) {
    throw new PerformanceSchemaError(filename, "commandFingerprint mismatch");
  }
  validateCredentialRedaction(record, filename);
  const isExplicitlyUnbound =
    record.git.sha === null && record.git.dirty === null;
  if (!(isGitBound(record.git) || isExplicitlyUnbound)) {
    throw new PerformanceSchemaError(
      filename,
      "git must be fully unbound or contain a full SHA-1/SHA-256 and dirty state"
    );
  }
  if (fingerprintCohort(record.cohortDimensions) !== record.cohortFingerprint) {
    throw new PerformanceSchemaError(filename, "cohortFingerprint mismatch");
  }
  if (!cohortIdentityMatchesRecord(record, filename)) {
    throw new PerformanceSchemaError(
      filename,
      "cohortDimensions do not match record identity"
    );
  }
  if (Date.parse(record.endedAt) < Date.parse(record.startedAt)) {
    throw new PerformanceSchemaError(
      filename,
      "endedAt must not be earlier than startedAt"
    );
  }
  if (
    (record.wrapperStatus === "complete") !==
    (record.measurementError === null)
  ) {
    throw new PerformanceSchemaError(
      filename,
      "wrapperStatus and measurementError are inconsistent"
    );
  }
  let expectedErrorStage: "spawn" | "evidence-write" | null = null;
  if (record.wrapperStatus === "spawn-failed") {
    expectedErrorStage = "spawn";
  } else if (record.wrapperStatus === "evidence-write-failed") {
    expectedErrorStage = "evidence-write";
  }
  if (
    expectedErrorStage !== null &&
    record.measurementError?.stage !== expectedErrorStage
  ) {
    throw new PerformanceSchemaError(
      filename,
      "wrapperStatus and measurementError stage are inconsistent"
    );
  }
  return record;
};

export interface ReadRecordsOptions {
  /**
   * Called once per record that fails to parse or validate, instead of
   * rejecting the whole read. Omit to preserve the strict default: any
   * invalid record rejects the entire call.
   */
  onInvalidRecord?: (error: PerformanceSchemaError) => void;
}

export const readRecords = async (
  outputDirectory: string,
  options: ReadRecordsOptions = {}
): Promise<PerformanceRecord[]> => {
  if (!existsSync(outputDirectory)) {
    return [];
  }
  const entries = await readdir(outputDirectory);
  const recordResults = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .toSorted()
      .map(async (entry) => {
        const filename = path.join(outputDirectory, entry);
        try {
          let value: JsonValue;
          try {
            value = await Bun.file(filename).json();
          } catch (error) {
            const detail =
              error instanceof Error ? error.message : String(error);
            throw new PerformanceSchemaError(entry, `invalid JSON: ${detail}`);
          }
          return validateRecordInvariants(
            parsePerformanceRecord(value, entry),
            entry
          );
        } catch (error) {
          if (!options.onInvalidRecord) {
            throw error;
          }
          const schemaError =
            error instanceof PerformanceSchemaError
              ? error
              : new PerformanceSchemaError(
                  entry,
                  error instanceof Error ? error.message : String(error)
                );
          options.onInvalidRecord(schemaError);
          return null;
        }
      })
  );
  return recordResults.filter(
    (record): record is PerformanceRecord => record !== null
  );
};

export const runtimeMetadata = (): PerformanceRecord["runtime"] => {
  const cpuList = cpus();
  return {
    arch: arch(),
    bun: Bun.version,
    cpuCount: cpuList.length,
    cpuModel: cpuList[0]?.model ?? "unavailable",
    memoryBytes: totalmem(),
    os: platform(),
    osRelease: release(),
  };
};
