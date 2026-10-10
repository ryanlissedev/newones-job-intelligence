import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { createSpottClient } from "@ji/application/export/spott";
import type { SpottClient } from "@ji/application/export/spott";
import { createJsonLdClient, heroConfig } from "@ji/connectors/json-ld";
import type { JsonLdClient } from "@ji/connectors/json-ld";

import type { BaselineArtifact, BaselineMetrics } from "./harness";
import {
  assertFixtureOnly,
  collectGitMetadata,
  collectHostMetadata,
  loadTemplate,
  validateBaselineArtifact,
} from "./harness";
import { roundMs, summarizeLatencies } from "./stats";
import { readToolchainPins } from "./versions";

const ROOT = path.resolve(import.meta.dir, "../..");

export interface MeasureOptions {
  iterations: number;
  runKind: "cold" | "warm";
  /** Discard this many leading samples per op before recording (warm only). */
  warmup: number;
}

interface AdapterClients {
  jsonLd: JsonLdClient;
  spott: SpottClient;
}

interface TimedCommandResult {
  durationMs: number;
  ok: boolean;
}

interface FixturePassResult {
  durationMs: number;
  ok: boolean;
  requestAttempts: number;
}

interface CancellationResult {
  latencyMs: number;
  resourceReleaseOk: boolean;
}

interface LatencyCollection {
  failures: number;
  requestAttemptsTotal: number;
  samplesMs: number[];
}

const DEFAULT_OPTIONS: MeasureOptions = {
  iterations: 12,
  runKind: "warm",
  warmup: 3,
};

const createClients = (): AdapterClients => ({
  jsonLd: createJsonLdClient({ config: heroConfig, liveEnabled: false }),
  spott: createSpottClient({ liveEnabled: false }),
});

const detailUrl = (): string => {
  const [first] = Object.keys(heroConfig.detailFixtures ?? {});
  if (!first) {
    throw new Error("heroConfig.detailFixtures is empty");
  }
  return first;
};

const abortError = (): DOMException =>
  new DOMException("Aborted", "AbortError");

const waitForAbort = async (signal: AbortSignal): Promise<never> => {
  // Short ceiling so a losing race cannot pin the event loop open.
  try {
    await delay(250, undefined, { signal });
  } catch {
    throw abortError();
  }
  throw abortError();
};

/** One homogeneous fixture pass: JSON-LD listing+detail + Spott list/get. */
const runFixturePass = async (
  clients: AdapterClients
): Promise<FixturePassResult> => {
  const started = performance.now();
  let requestAttempts = 0;
  try {
    requestAttempts += 1;
    await clients.jsonLd.fetchListing();
    requestAttempts += 1;
    await clients.jsonLd.fetchDetail(detailUrl());
    requestAttempts += 1;
    await clients.spott.listVacancies();
    requestAttempts += 1;
    await clients.spott.getVacancy("vacancy-fixture-001");
    return {
      durationMs: roundMs(performance.now() - started),
      ok: true,
      requestAttempts,
    };
  } catch {
    return {
      durationMs: roundMs(performance.now() - started),
      ok: false,
      requestAttempts,
    };
  }
};

/**
 * Native adapters do not yet accept AbortSignal. Measure harness-level cancel
 * by racing a fixture pass against an abort; underlying I/O may still finish.
 */
const measureCancellation = async (
  clients: AdapterClients
): Promise<CancellationResult> => {
  const controller = new AbortController();
  const abortAfterMs = 1;
  const timer = setTimeout(() => {
    controller.abort();
  }, abortAfterMs);
  const started = performance.now();
  let sawAbort = false;
  try {
    // Intentionally delay the fixture pass so the abort wins the race.
    await delay(5);
    const fixtureRace = async (): Promise<never> => {
      await runFixturePass(clients);
      throw new Error("fixture pass completed before abort race");
    };
    await Promise.race([fixtureRace(), waitForAbort(controller.signal)]);
  } catch (error) {
    sawAbort =
      error instanceof DOMException && error.name === "AbortError"
        ? true
        : error instanceof Error && /abort/iu.test(error.message);
  } finally {
    clearTimeout(timer);
    if (!controller.signal.aborted) {
      controller.abort();
    }
  }
  return {
    latencyMs: roundMs(performance.now() - started),
    resourceReleaseOk: sawAbort,
  };
};

const countLinesInFiles = (absolutePaths: string[]): number => {
  let total = 0;
  for (const filePath of absolutePaths) {
    const text = readFileSync(filePath, "utf-8");
    total += text.split(/\r?\n/u).length;
  }
  return total;
};

const listTsSources = (directory: string): string[] => {
  const entries = readdirSync(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTsSources(full));
      continue;
    }
    if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".spec.ts")
    ) {
      files.push(full);
    }
  }
  return files;
};

const adapterLocObserve = (): number => {
  const jsonLd = listTsSources(
    path.join(ROOT, "packages/connectors/src/json-ld")
  );
  const spott = listTsSources(
    path.join(ROOT, "packages/application/src/export/spott")
  );
  return countLinesInFiles([...jsonLd, ...spott]);
};

interface PackageJsonDependencyMaps {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const directDependencyCount = (): number => {
  const raw: unknown = JSON.parse(
    readFileSync(path.join(ROOT, "package.json"), "utf-8")
  );
  // SAFETY: root package.json is repo-controlled; only dependency map keys are counted.
  const pkg = raw as PackageJsonDependencyMaps;
  return (
    Object.keys(pkg.dependencies ?? {}).length +
    Object.keys(pkg.devDependencies ?? {}).length
  );
};

const runTimedCommand = (
  command: string,
  args: string[]
): TimedCommandResult => {
  const started = performance.now();
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf-8",
    env: {
      ...process.env,
      PATH: `./node_modules/.bin:${process.env.PATH ?? ""}`,
    },
  });
  return {
    durationMs: roundMs(performance.now() - started),
    ok: result.status === 0,
  };
};

const measureServerBundleBytes = (): number | null => {
  const distDir = path.join(ROOT, "apps/server/dist");
  try {
    const entries = readdirSync(distDir);
    let total = 0;
    for (const name of entries) {
      const full = path.join(distDir, name);
      const st = statSync(full);
      if (st.isFile()) {
        total += st.size;
      }
    }
    return total > 0 ? total : null;
  } catch {
    return null;
  }
};

const peakRssMiB = (): number => {
  const usage = process.resourceUsage();
  // Linux: maxRSS is kilobytes
  return roundMs(usage.maxRSS / 1024);
};

const collectLatencySamples = async (
  options: MeasureOptions
): Promise<LatencyCollection> => {
  const samplesMs: number[] = [];
  let failures = 0;
  let requestAttemptsTotal = 0;
  const totalPasses =
    options.runKind === "warm"
      ? options.warmup + options.iterations
      : options.iterations;

  // Cold: recreate clients each pass. Warm: reuse one client pair after warmup.
  // Sequential passes are intentional (homogeneous cohort; max concurrency 1).
  let shared: AdapterClients | null = null;
  if (options.runKind === "warm") {
    shared = createClients();
  }

  const passIndexes = Array.from({ length: totalPasses }, (_, index) => index);
  for (const index of passIndexes) {
    const clients = shared ?? createClients();
    // Sequential measurement: parallel Promise.all would merge cold/warm timing.
    // oxlint-disable-next-line eslint/no-await-in-loop -- cohort samples must stay serial
    const result = await runFixturePass(clients);
    requestAttemptsTotal += result.requestAttempts;
    const isWarmup = options.runKind === "warm" && index < options.warmup;
    if (isWarmup) {
      continue;
    }
    if (result.ok) {
      samplesMs.push(result.durationMs);
    } else {
      failures += 1;
    }
  }
  return { failures, requestAttemptsTotal, samplesMs };
};

export const measureNativeCohort = async (
  partial: Partial<MeasureOptions> = {}
): Promise<BaselineArtifact> => {
  const options: MeasureOptions = { ...DEFAULT_OPTIONS, ...partial };
  if (options.runKind !== "cold" && options.runKind !== "warm") {
    throw new Error("measure requires --run-kind cold|warm");
  }

  const template = loadTemplate();
  const clients = createClients();

  const smoke = await runFixturePass(clients);
  if (!smoke.ok) {
    throw new Error("fixture correctness smoke failed before measurement");
  }

  const latency = await collectLatencySamples(options);
  const cancellation = await measureCancellation(clients);

  const typecheck = runTimedCommand("bun", [
    "run",
    "check-types:effect-baseline",
  ]);
  const build = runTimedCommand("bun", [
    "run",
    "--cwd",
    "apps/server",
    "build",
  ]);
  const serverBundleBytes = measureServerBundleBytes();

  const passDenominator =
    latency.samplesMs.length +
    latency.failures +
    (options.runKind === "warm" ? options.warmup : 0);
  const avgRequestAttempts =
    passDenominator > 0 ? latency.requestAttemptsTotal / passDenominator : null;

  const metrics: BaselineMetrics = {
    adapterLocObserve: adapterLocObserve(),
    attemptCounts: {
      requestAttempts:
        avgRequestAttempts === null ? null : roundMs(avgRequestAttempts),
      taskAttempts: 1,
    },
    buildDurationMs: build.ok ? build.durationMs : null,
    cancellationLatencyMs: cancellation.latencyMs,
    directDependencyCount: directDependencyCount(),
    latencyMs: summarizeLatencies(latency.samplesMs, latency.failures),
    peakRssMiB: peakRssMiB(),
    resourceReleaseOk: cancellation.resourceReleaseOk,
    serverBundleBytes,
    typecheckDurationMs: typecheck.ok ? typecheck.durationMs : null,
  };

  const artifact: BaselineArtifact = {
    ...template,
    cohort: {
      cacheState:
        options.runKind === "cold"
          ? "fixture-same-process-fresh-clients"
          : `fixture-same-process-reused-clients-warmup-${options.warmup}`,
      label: `native-${options.runKind}`,
      runKind: options.runKind,
    },
    git: collectGitMetadata(),
    host: collectHostMetadata(),
    metrics,
    notes: [
      "Native TS fixture cohort (JSON-LD hero listing/detail + Spott list/get).",
      "Production activation OFF; fixtureOnly; no live providers; no PII.",
      "Effect dual-path comparison blocked: effect is transitive-only (CTP-455 first-party pin).",
      "AbortSignal is not plumbed through native JsonLdClient/SpottClient; cancellationLatencyMs is harness race stop time.",
      `Iterations=${options.iterations}; runKind=${options.runKind}.`,
      `Build ok=${build.ok}; typecheck ok=${typecheck.ok}.`,
    ].join(" "),
    reviewRubric: {
      cancellationPathIdentifiable: true,
      cleanupOwnerIdentifiable: true,
      notes: [
        "Native variant (pre-Effect):",
        "retryOwner = packages/connectors withRetry / apps/worker poll-bron-run retryPolicy (request maxAttempts 3); Trigger task retry = apps/worker/src/tasks/poll-bron.ts (maxAttempts 2).",
        "cancellationPath = not yet wired into JsonLdClient/SpottClient fetch; harness AbortController race only — CTP-455 must implement AbortSignal on Effect adapters.",
        "cleanupOwner = caller/harness clearTimeout + fixture loader; no adapter-owned timers in fixture mode.",
        "Effect variant: blocked-on-CTP-455 (no first-party effect@rc pin / runtime).",
      ].join(" "),
      retryOwnerIdentifiable: true,
    },
    status: "measured",
    toolchain: readToolchainPins(),
    workload: {
      adapters: [
        "json-ld-listing",
        "json-ld-detail",
        "spott-list",
        "spott-get",
      ],
      fixtureOnly: true,
      liveProviders: false,
    },
  };

  assertFixtureOnly(artifact);
  validateBaselineArtifact(artifact);
  return artifact;
};
