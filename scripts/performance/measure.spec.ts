import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { readRecords } from "./core";
import { collectMetadata } from "./measure";

const environmentWithoutPerformanceMetadata = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("PERF_"))
  );

test("Crabbox passes numeric sequence positions accepted by metadata", async () => {
  const config = await Bun.file(".crabbox.yaml").text();
  const sequenceValues = [
    ...config.matchAll(/PERF_SEQUENCE_POSITION=(?<position>[^\s\\]+)/gu),
  ].map((match) => match.groups?.position);

  expect(sequenceValues).toEqual(["1", "1", "2", "2"]);
  for (const value of sequenceValues) {
    expect(
      collectMetadata({ PERF_SEQUENCE_POSITION: value }, [])[
        "sequence-position"
      ]
    ).toBe(value);
  }
});

test("CLI metadata overrides explicit allowlisted environment metadata", () => {
  expect(
    collectMetadata(
      {
        PERF_POSTGRES_IMAGE_DIGEST: "sha256:abc123",
        PERF_PROVIDER: "github",
        PERF_RUNNER: "ubuntu",
        PERF_SEQUENCE_POSITION: "2",
      },
      ["provider=crabbox"]
    )
  ).toEqual({
    "postgres-image-digest": "sha256:abc123",
    provider: "crabbox",
    runner: "ubuntu",
    "sequence-position": "2",
  });
});

test("declared datasets require a digest after environment and CLI metadata merge", () => {
  expect(() => collectMetadata({ PERF_DATASET: "jobs-v1" }, [])).toThrow(
    "Metadata dataset requires dataset-digest"
  );
  expect(
    collectMetadata({ PERF_DATASET_DIGEST: "sha256:abc123" }, [
      "dataset=jobs-v1",
    ])
  ).toMatchObject({
    dataset: "jobs-v1",
    "dataset-digest": "sha256:abc123",
  });
  for (const datasetDigest of [
    "",
    "   ",
    "sha256:abc123 ",
    "sha256:first\nsecond",
    "sha256:first\rsecond",
    "sha256:first\tsecond",
    "sha256:first\u0000second",
    "sha256:first|second",
  ]) {
    expect(() =>
      collectMetadata({}, [
        "dataset=jobs-v1",
        `dataset-digest=${datasetDigest}`,
      ])
    ).toThrow("dataset-digest must match <algorithm>:<digest>");
  }
});

test("timed gate defaults unclassified runs and JUnit evidence to unknown", async () => {
  const gate = await Bun.file("tools/quality/gate.sh").text();
  expect(gate.match(/\$\{PERF_RUN_KIND:-unknown\}/gu)).toHaveLength(2);
  expect(gate).not.toMatch(/PERF_RUN_KIND:-warm/u);
});

test("measure CLI propagates command exit and still writes a record", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ji-performance-cli-"));
  try {
    const child = Bun.spawn(
      [
        "bun",
        "scripts/performance/measure.ts",
        "--label",
        "exit-test",
        "--output-dir",
        directory,
        "--",
        "bun",
        "-e",
        "process.exit(7)",
      ],
      {
        env: environmentWithoutPerformanceMetadata(),
        stderr: "ignore",
        stdout: "ignore",
      }
    );
    expect(await child.exited).toBe(7);
    const records = await readRecords(directory);
    expect(records).toHaveLength(1);
    expect(records[0]?.commandExitCode).toBe(7);
    expect(records[0]?.commandStatus).toBe("failed");
    expect(records[0]?.runKind).toBe("unknown");
    expect(records[0]?.wrapperStatus).toBe("complete");
    expect(records[0]?.resources.cpuUserMicroseconds).toBeNull();
    expect(records[0]?.resources.maxRssBytes).toBeNull();
    expect(records[0]?.resources.unsupportedReason).toContain("Bun 1.3.14");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 20_000);

test("records spawn failure separately from command outcome", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ji-performance-spawn-"));
  try {
    const child = Bun.spawn(
      [
        "bun",
        "scripts/performance/measure.ts",
        "--label",
        "spawn-test",
        "--output-dir",
        directory,
        "--",
        "/tmp/token/private-spawn-value/definitely-not-a-real-command",
      ],
      {
        env: environmentWithoutPerformanceMetadata(),
        stderr: "ignore",
        stdout: "ignore",
      }
    );
    expect(await child.exited).toBe(2);
    const records = await readRecords(directory);
    expect(records[0]?.commandExitCode).toBeNull();
    expect(records[0]?.commandStatus).toBe("not-started");
    expect(records[0]?.wrapperStatus).toBe("spawn-failed");
    expect(records[0]?.measurementError?.stage).toBe("spawn");
    expect(records[0]?.command[0]).toBe(
      "/tmp/token/[REDACTED]/definitely-not-a-real-command"
    );
    expect(records[0]?.measurementError?.message).not.toContain(
      "private-spawn-value"
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 20_000);

test("evidence failure uses recovery and fails the wrapper distinctly", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "ji-performance-write-"));
  const blockedPath = path.join(directory, "not-a-directory");
  const recovery = path.join(directory, "recovery");
  try {
    await Bun.write(blockedPath, "file");
    const child = Bun.spawn(
      [
        "bun",
        "scripts/performance/measure.ts",
        "--label",
        "write-test",
        "--output-dir",
        blockedPath,
        "--",
        "bun",
        "-e",
        "process.exit(0)",
      ],
      {
        env: {
          ...environmentWithoutPerformanceMetadata(),
          PERF_RECOVERY_DIR: recovery,
        },
        stderr: "ignore",
        stdout: "ignore",
      }
    );
    expect(await child.exited).toBe(3);
    const records = await readRecords(recovery);
    expect(records[0]?.commandStatus).toBe("passed");
    expect(records[0]?.wrapperStatus).toBe("evidence-write-failed");
    expect(records[0]?.measurementError?.stage).toBe("evidence-write");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 20_000);
