#!/usr/bin/env bun
import { tmpdir } from "node:os";
import path from "node:path";

import {
  collectGitMetadata,
  createCohortDimensions,
  DEFAULT_OUTPUT_DIR,
  fingerprintCohort,
  fingerprintCommand,
  parseMetadata,
  redactCommand,
  redactEvidenceText,
  runtimeMetadata,
  writeRecord,
} from "./core";
import type { PerformanceMetadata, PerformanceRecord, RunKind } from "./core";

interface Options {
  attempt: number;
  command: string[];
  executor: string;
  label: string;
  metadata: PerformanceMetadata;
  outputDirectory: string;
  recoveryDirectory: string;
  retryOf: string | null;
  runKind: RunKind;
}

const METADATA_ENVIRONMENT_MAP = {
  PERF_CACHE_STATE: "cache-state",
  PERF_CONCURRENCY: "concurrency",
  PERF_DATASET: "dataset",
  PERF_DATASET_DIGEST: "dataset-digest",
  PERF_INDEX_STATE: "index-state",
  PERF_ITEM_COUNT: "item-count",
  PERF_JOB: "job",
  PERF_MACHINE: "machine",
  PERF_PIPELINE: "pipeline",
  PERF_POSTGRES_IMAGE_DIGEST: "postgres-image-digest",
  PERF_POSTGRES_VERSION: "postgres-version",
  PERF_PROFILE: "profile",
  PERF_PROVIDER: "provider",
  PERF_QUERYSET_DIGEST: "queryset-digest",
  PERF_REGION: "region",
  PERF_RUNNER: "runner",
  PERF_SEQUENCE_POSITION: "sequence-position",
  PERF_SUITE: "suite",
  PERF_TOOLCHAIN: "toolchain",
  PERF_VACUUM_STATE: "vacuum-state",
  PERF_WORKFLOW: "workflow",
  PERF_WORKLOAD_VERSION: "workload-version",
} as const;

export const collectMetadata = (
  environment: Record<string, string | undefined>,
  cliEntries: string[]
): PerformanceMetadata => {
  const environmentEntries: string[] = [];
  for (const [environmentKey, metadataKey] of Object.entries(
    METADATA_ENVIRONMENT_MAP
  )) {
    const value = environment[environmentKey];
    if (value) {
      environmentEntries.push(`${metadataKey}=${value}`);
    }
  }
  return parseMetadata([...environmentEntries, ...cliEntries]);
};

const usage = (): never => {
  throw new Error(
    "Usage: measure.ts --label <name> [--output-dir <path>] [--run-kind cold|unknown|warm] [--metadata key=value] -- <command> [args...]"
  );
};

const parseCliOptions = (args: string[]) => {
  let label = "";
  let outputDirectory = process.env.PERF_METRICS_DIR ?? DEFAULT_OUTPUT_DIR;
  let runKind = process.env.PERF_RUN_KIND ?? "unknown";
  const metadataEntries: string[] = [];
  const separator = args.indexOf("--");
  if (separator === -1 || separator === args.length - 1) {
    return usage();
  }

  const optionArgs = args.slice(0, separator);
  for (let index = 0; index < optionArgs.length; index += 1) {
    const option = optionArgs[index];
    const value = optionArgs[index + 1];
    if (!value) {
      return usage();
    }
    if (option === "--label") {
      label = value;
    } else if (option === "--output-dir") {
      outputDirectory = value;
    } else if (option === "--run-kind") {
      runKind = value;
    } else if (option === "--metadata") {
      metadataEntries.push(value);
    } else {
      return usage();
    }
    index += 1;
  }

  return {
    command: args.slice(separator + 1),
    label,
    metadataEntries,
    outputDirectory,
    runKind,
  };
};

export const parseOptions = (args: string[]): Options => {
  const attempt = Number(process.env.PERF_ATTEMPT ?? "1");
  const executor = process.env.PERF_EXECUTOR ?? "local";
  const cli = parseCliOptions(args);

  if (!cli.label || !/^[a-zA-Z0-9_-]+$/u.test(cli.label)) {
    throw new Error(
      "Label must contain only letters, numbers, underscores, or hyphens"
    );
  }
  if (
    cli.runKind !== "cold" &&
    cli.runKind !== "unknown" &&
    cli.runKind !== "warm"
  ) {
    throw new Error("Run kind must be cold, unknown, or warm");
  }
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error("PERF_ATTEMPT must be a positive integer");
  }
  if (!/^[a-zA-Z0-9._-]{1,64}$/u.test(executor)) {
    throw new Error(
      "PERF_EXECUTOR must contain only safe identifier characters"
    );
  }
  const retryOf = process.env.PERF_RETRY_OF ?? null;
  if (retryOf !== null && !/^[a-zA-Z0-9._-]{1,128}$/u.test(retryOf)) {
    throw new Error(
      "PERF_RETRY_OF must contain only safe identifier characters"
    );
  }

  return {
    attempt,
    command: cli.command,
    executor,
    label: cli.label,
    metadata: collectMetadata(process.env, cli.metadataEntries),
    outputDirectory: cli.outputDirectory,
    recoveryDirectory:
      process.env.PERF_RECOVERY_DIR ??
      path.join(tmpdir(), "catapulze-performance-recovery"),
    retryOf,
    runKind: cli.runKind,
  };
};

const commandStatus = (
  exitCode: number | null
): PerformanceRecord["commandStatus"] => {
  if (exitCode === null) {
    return "not-started";
  }
  return exitCode === 0 ? "passed" : "failed";
};

export const measure = async (options: Options): Promise<number> => {
  const startedAt = new Date();
  const started = Bun.nanoseconds();
  let commandExitCode: number | null = null;
  let wrapperStatus: PerformanceRecord["wrapperStatus"] = "complete";
  let measurementError: PerformanceRecord["measurementError"] = null;
  try {
    const child = Bun.spawn(options.command, {
      stderr: "inherit",
      stdin: "inherit",
      stdout: "inherit",
    });
    commandExitCode = await child.exited;
  } catch (error) {
    wrapperStatus = "spawn-failed";
    measurementError = {
      message: redactEvidenceText(
        error instanceof Error ? error.message : String(error)
      ),
      stage: "spawn",
    };
  }
  const endedAt = new Date();
  const durationMs = Math.round((Bun.nanoseconds() - started) / 1_000_000);
  const redactedCommand = redactCommand(options.command);
  const commandFingerprint = fingerprintCommand(redactedCommand);
  const runtime = runtimeMetadata();
  const cohortDimensions = createCohortDimensions({
    commandFingerprint,
    executor: options.executor,
    label: options.label,
    metadata: options.metadata,
    runKind: options.runKind,
    runtime,
  });
  const record: PerformanceRecord = {
    attempt: options.attempt,
    cohortDimensions,
    cohortFingerprint: fingerprintCohort(cohortDimensions),
    command: redactedCommand,
    commandExitCode,
    commandFingerprint,
    commandStatus: commandStatus(commandExitCode),
    durationMs,
    endedAt: endedAt.toISOString(),
    executor: options.executor,
    git: await collectGitMetadata(),
    id: crypto.randomUUID(),
    label: options.label,
    measurement: {
      boundary: "subprocess-spawn-to-exit",
      kind: "command-wall-clock",
      unit: "milliseconds",
    },
    measurementError,
    metadata: options.metadata,
    resources: {
      cpuSystemMicroseconds: null,
      cpuUserMicroseconds: null,
      maxRssBytes: null,
      unsupportedReason:
        "Bun 1.3.14 Subprocess does not expose portable per-child resource usage in the installed runtime types",
    },
    retryOf: options.retryOf,
    runKind: options.runKind,
    runtime,
    schemaVersion: 1,
    startedAt: startedAt.toISOString(),
    wrapperStatus,
  };

  let evidencePath: string | null = null;
  try {
    const paths = await writeRecord(options.outputDirectory, record);
    evidencePath = paths.json;
  } catch (error) {
    record.wrapperStatus = "evidence-write-failed";
    record.measurementError = {
      message: redactEvidenceText(
        error instanceof Error ? error.message : String(error)
      ),
      stage: "evidence-write",
    };
    try {
      const paths = await writeRecord(options.recoveryDirectory, record);
      evidencePath = paths.json;
    } catch (recoveryError) {
      const detail =
        recoveryError instanceof Error
          ? redactEvidenceText(recoveryError.message)
          : redactEvidenceText(String(recoveryError));
      process.stderr.write(
        `performance: recovery evidence failed: ${detail}\n`
      );
    }
  }

  process.stderr.write(
    `performance: ${record.label} command=${record.commandStatus} wrapper=${record.wrapperStatus} in ${record.durationMs} ms${evidencePath ? ` (${evidencePath})` : ""}\n`
  );
  if (record.wrapperStatus === "evidence-write-failed") {
    return 3;
  }
  return commandExitCode ?? 2;
};

if (import.meta.main) {
  try {
    const exitCode = await measure(parseOptions(Bun.argv.slice(2)));
    process.exit(exitCode);
  } catch (error) {
    const message = redactEvidenceText(
      error instanceof Error ? error.message : String(error)
    );
    process.stderr.write(`performance: ${message}\n`);
    process.exit(2);
  }
}
