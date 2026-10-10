import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createCohortDimensions,
  fingerprintCohort,
  fingerprintCommand,
  writeRecord,
} from "./core";
import type { PerformanceRecord } from "./core";

const environmentWithoutPerformanceMetadata = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("PERF_"))
  );

const validRecord = (label: string): PerformanceRecord => {
  const command = ["bun", "test"];
  const commandFingerprint = fingerprintCommand(command);
  const runtime = {
    arch: "arm64",
    bun: "1.3.14",
    cpuCount: 8,
    cpuModel: "Test CPU",
    memoryBytes: 1024,
    os: "darwin",
    osRelease: "test",
  };
  const cohortDimensions = createCohortDimensions({
    commandFingerprint,
    executor: "test",
    label,
    metadata: {},
    runKind: "unknown",
    runtime,
  });
  return {
    attempt: 1,
    cohortDimensions,
    cohortFingerprint: fingerprintCohort(cohortDimensions),
    command,
    commandExitCode: 0,
    commandFingerprint,
    commandStatus: "passed",
    durationMs: 100,
    endedAt: "2026-08-28T10:00:01.000Z",
    executor: "test",
    git: { dirty: false, sha: "a".repeat(40) },
    id: crypto.randomUUID(),
    label,
    measurement: {
      boundary: "subprocess-spawn-to-exit",
      kind: "command-wall-clock",
      unit: "milliseconds",
    },
    measurementError: null,
    metadata: {},
    resources: {
      cpuSystemMicroseconds: null,
      cpuUserMicroseconds: null,
      maxRssBytes: null,
      unsupportedReason: "unsupported by test runtime",
    },
    retryOf: null,
    runKind: "unknown",
    runtime,
    schemaVersion: 1,
    startedAt: "2026-08-28T10:00:00.000Z",
    wrapperStatus: "complete",
  };
};

const runReport = (directory: string) =>
  Bun.spawn(
    ["bun", "scripts/performance/report.ts", "--output-dir", directory],
    {
      env: environmentWithoutPerformanceMetadata(),
      stderr: "pipe",
      stdout: "pipe",
    }
  );

test("report skips an invalid record and reports on the valid ones", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "ji-performance-report-")
  );
  try {
    await writeRecord(directory, validRecord("gate"));
    await writeFile(
      path.join(directory, "broken-record.json"),
      "{ not valid json"
    );

    const child = await runReport(directory);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toContain("broken-record.json");
    expect(stderr).toContain("skipped 1 invalid record");
    expect(stdout).toContain("gate");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 20_000);

test("report fails when every record is invalid", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "ji-performance-report-")
  );
  try {
    await writeFile(
      path.join(directory, "broken-record.json"),
      "{ not valid json"
    );

    const child = await runReport(directory);
    const [stderr, exitCode] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("no valid performance records found");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 20_000);

test("report fails on an empty result set", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "ji-performance-report-")
  );
  try {
    const child = await runReport(directory);
    const [stderr, exitCode] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("no valid performance records found");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 20_000);
