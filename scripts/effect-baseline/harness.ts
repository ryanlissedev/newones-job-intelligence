#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { readToolchainPins } from "./versions";
import type { EffectBaselineToolchainPins } from "./versions";

const ROOT = path.resolve(import.meta.dir, "../..");
const TEMPLATE_PATH = path.join(
  import.meta.dir,
  "baseline-artifact.template.json"
);
const SCHEMA_PATH = path.join(import.meta.dir, "baseline-artifact.schema.json");

export interface BaselineLatencyMetrics {
  failures: number;
  n: number;
  p50: number | null;
  p95: number | null;
}

export interface BaselineAttemptCounts {
  requestAttempts: number | null;
  taskAttempts: number | null;
}

export interface BaselineMetrics {
  adapterLocObserve: number | null;
  attemptCounts: BaselineAttemptCounts;
  buildDurationMs: number | null;
  cancellationLatencyMs: number | null;
  directDependencyCount: number | null;
  latencyMs: BaselineLatencyMetrics;
  peakRssMiB: number | null;
  resourceReleaseOk: boolean | null;
  serverBundleBytes: number | null;
  typecheckDurationMs: number | null;
}

export interface BaselineArtifact {
  adr: string;
  allowedRegressions: string[];
  cohort: {
    cacheState: string;
    label: string;
    runKind: "cold" | "unknown" | "warm";
  };
  git: { branch: string | null; dirty: boolean; headSha: string };
  host: {
    arch: string;
    cpuCount: number;
    hostname: string;
    memTotalMiB: number | null;
    os: string;
  };
  issue: string;
  metrics: BaselineMetrics;
  notes: string;
  retryOwnership: {
    blindWriteRetries: false;
    requestMaxAttempts: number;
    requestRetryOwner: string;
    triggerMaxAttempts: number;
    triggerTaskRetryOwner: string;
  };
  reviewRubric: {
    cancellationPathIdentifiable: boolean | null;
    cleanupOwnerIdentifiable: boolean | null;
    notes: string;
    retryOwnerIdentifiable: boolean | null;
  };
  schemaVersion: 1;
  status: "dry-run" | "invalid" | "measured" | "template";
  toolchain: EffectBaselineToolchainPins;
  workload: {
    adapters: (
      | "json-ld-detail"
      | "json-ld-listing"
      | "spott-get"
      | "spott-list"
    )[];
    fixtureOnly: boolean;
    liveProviders: boolean;
  };
}

interface SchemaRequiredList {
  required: string[];
}

const shaPattern = /^[0-9a-f]{40}$/u;

const git = (args: string[]): string => {
  const result = spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`
    );
  }
  return (result.stdout ?? "").trim();
};

const isGitWorkspace = (): boolean =>
  spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: ROOT,
    encoding: "utf-8",
  }).status === 0;

// The exe.dev shadow box syncs the tree without .git and exports the source
// identity instead (scripts/crabbox-exe-dev-shadow-run.sh). Use that identity
// only when there is no workspace; never invent a SHA.
export const transferredGitMetadata = (
  env: NodeJS.ProcessEnv
): BaselineArtifact["git"] => {
  const headSha = env.CRABBOX_SOURCE_GIT_SHA ?? "";
  const state = env.CRABBOX_SOURCE_GIT_STATE;
  if (!shaPattern.test(headSha) || (state !== "clean" && state !== "dirty")) {
    throw new Error(
      "No git workspace and no valid CRABBOX_SOURCE_GIT_SHA/CRABBOX_SOURCE_GIT_STATE"
    );
  }
  return { branch: null, dirty: state === "dirty", headSha };
};

export const collectGitMetadata = (
  env: NodeJS.ProcessEnv = process.env
): BaselineArtifact["git"] => {
  if (!isGitWorkspace()) {
    return transferredGitMetadata(env);
  }
  const headSha = git(["rev-parse", "HEAD"]);
  if (!shaPattern.test(headSha)) {
    throw new Error(`Invalid HEAD SHA: ${headSha}`);
  }
  const dirty = git(["status", "--porcelain"]).length > 0;
  let branch: string | null = null;
  try {
    branch = git(["branch", "--show-current"]) || null;
  } catch {
    branch = null;
  }
  return { branch, dirty, headSha };
};

export const collectHostMetadata = (): BaselineArtifact["host"] => {
  const totalMem = os.totalmem();
  return {
    arch: os.arch(),
    cpuCount: os.cpus().length,
    hostname: os.hostname(),
    memTotalMiB: Number.isFinite(totalMem)
      ? Math.round(totalMem / (1024 * 1024))
      : null,
    os: `${os.platform()} ${os.release()}`,
  };
};

export const loadTemplate = (): BaselineArtifact => {
  const raw: unknown = JSON.parse(readFileSync(TEMPLATE_PATH, "utf-8"));
  // SAFETY: template is repo-controlled and checked for schemaVersion immediately below.
  const artifact = raw as BaselineArtifact;
  if (artifact.schemaVersion !== 1) {
    throw new Error("baseline template schemaVersion must be 1");
  }
  return artifact;
};

export const assertFixtureOnly = (artifact: BaselineArtifact): void => {
  if (!artifact.workload.fixtureOnly || artifact.workload.liveProviders) {
    throw new Error(
      "Effect baseline harness refuses live providers; fixtures/sandbox only"
    );
  }
};

/** Structural checks against the committed schema without adding ajv. */
export const validateBaselineArtifact = (artifact: BaselineArtifact): void => {
  if (artifact.schemaVersion !== 1) {
    throw new Error("schemaVersion must be 1");
  }
  if (artifact.issue !== "CTP-454") {
    throw new Error("issue must be CTP-454 for this harness");
  }
  if (!shaPattern.test(artifact.git.headSha)) {
    throw new Error("git.headSha must be a full 40-char SHA");
  }
  if (artifact.retryOwnership.blindWriteRetries !== false) {
    throw new Error("blindWriteRetries must be false");
  }
  if (artifact.workload.liveProviders) {
    throw new Error("liveProviders must be false");
  }
  const schemaRaw: unknown = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"));
  // SAFETY: schema is repo-controlled JSON Schema; only `required` string[] is read.
  const schema = schemaRaw as SchemaRequiredList;
  for (const key of schema.required) {
    if (!(key in artifact)) {
      throw new Error(`Missing required artifact field: ${key}`);
    }
  }
};

export const buildDryRunArtifact = (
  runKind: "cold" | "unknown" | "warm" = "unknown"
): BaselineArtifact => {
  const template = loadTemplate();
  const artifact: BaselineArtifact = {
    ...template,
    cohort: {
      cacheState: runKind === "unknown" ? "unmeasured" : `${runKind}-declared`,
      label: "effect-baseline-dry-run",
      runKind,
    },
    git: collectGitMetadata(),
    host: collectHostMetadata(),
    notes:
      "Dry-run scaffolding only. Metrics remain null until a measured cohort is executed under CTP-454 follow-up.",
    status: "dry-run",
    toolchain: readToolchainPins(),
  };
  assertFixtureOnly(artifact);
  validateBaselineArtifact(artifact);
  return artifact;
};

export const writeArtifact = (
  artifact: BaselineArtifact,
  outputDirectory = path.join(ROOT, ".artifacts/effect-baseline")
): string => {
  mkdirSync(outputDirectory, { recursive: true });
  const filePath = path.join(
    outputDirectory,
    `${artifact.cohort.label}-${artifact.git.headSha.slice(0, 12)}.json`
  );
  writeFileSync(filePath, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8");
  return filePath;
};

const parseRunKind = (
  args: string[],
  allowUnknown: boolean
): "cold" | "unknown" | "warm" => {
  const runKindIndex = args.indexOf("--run-kind");
  if (runKindIndex === -1) {
    return allowUnknown ? "unknown" : "warm";
  }
  const value = args[runKindIndex + 1];
  if (value !== "cold" && value !== "warm" && value !== "unknown") {
    throw new Error("--run-kind must be cold, warm, or unknown");
  }
  if (!allowUnknown && value === "unknown") {
    throw new Error("--measure requires --run-kind cold|warm");
  }
  return value;
};

const parseNonNegativeInt = (
  args: string[],
  flag: string,
  fallback: number
): number => {
  const index = args.indexOf(flag);
  if (index === -1) {
    return fallback;
  }
  const raw = args[index + 1];
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return value;
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const measure = args.includes("--measure");
  if (dryRun === measure) {
    throw new Error(
      "Usage: bun scripts/effect-baseline/harness.ts (--dry-run|--measure) [--run-kind cold|warm|unknown] [--iterations N] [--warmup N] [--evidence-dir path]"
    );
  }

  if (dryRun) {
    const runKind = parseRunKind(args, true);
    const artifact = buildDryRunArtifact(runKind);
    const outputPath = writeArtifact(artifact);
    process.stdout.write(
      `${JSON.stringify({ ok: true, outputPath, status: artifact.status }, null, 2)}\n`
    );
    return;
  }

  const runKind = parseRunKind(args, false);
  if (runKind === "unknown") {
    throw new Error("--measure requires --run-kind cold|warm");
  }
  const iterations = parseNonNegativeInt(args, "--iterations", 12);
  if (iterations < 1) {
    throw new Error("--iterations must be >= 1");
  }
  const warmup = parseNonNegativeInt(args, "--warmup", 3);
  const { measureNativeCohort } = await import("./measure");
  const artifact = await measureNativeCohort({
    iterations,
    runKind,
    warmup: runKind === "warm" ? warmup : 0,
  });
  const outputPath = writeArtifact(artifact);
  const evidenceIndex = args.indexOf("--evidence-dir");
  let evidencePath: string | null = null;
  if (evidenceIndex !== -1) {
    const evidenceDir = args[evidenceIndex + 1];
    if (!evidenceDir) {
      throw new Error("--evidence-dir requires a path");
    }
    evidencePath = writeArtifact(artifact, path.resolve(ROOT, evidenceDir));
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        evidencePath,
        ok: true,
        outputPath,
        status: artifact.status,
      },
      null,
      2
    )}\n`
  );
};

if (import.meta.main) {
  const run = async (): Promise<void> => {
    try {
      await main();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    }
  };
  void run();
}
