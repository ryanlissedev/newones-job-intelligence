import { expect, it } from "bun:test";

import { emptyRunMetrics, RunOwnershipLostError } from "@ji/connectors";
import type { RunCompleteness } from "@ji/connectors";
import { PollerHealthTelemetry } from "@ji/db/poller-health-telemetry-store";
import type {
  PollerHealthTelemetryEffectService,
  SourceFinalizeInput,
  SourceProgressInput,
} from "@ji/db/poller-health-telemetry-store";
import type { BronId, ScrapeRunId } from "@ji/domain";
import { Effect, Layer } from "effect";

import type { PollBronRunResult } from "../poll-bron-run";
import { drainBacklog } from "./drain-backlog";
import {
  createSourceHealthCallbacks,
  sourceCompletionOutcome,
} from "./source-health";
import { reportTelemetryCallback } from "./telemetry-callback";

const completedDrain = { curated: 2, failed: 0, quarantined: 0, remaining: 0 };
const run: PollBronRunResult = {
  // SAFETY: fixed fixture is a UUID-shaped source identifier.
  bronId: "00000000-0000-4000-8000-000000000001" as BronId,
  bronSlug: "opdrachtoverheid",
  completeness: { complete: true },
  fenceToken: 3,
  lifecycle: null,
  metrics: emptyRunMetrics(),
  // SAFETY: fixed fixture is a UUID-shaped run identifier.
  scrapeRunId: "00000000-0000-4000-8000-000000000002" as ScrapeRunId,
  status: "succeeded",
  writtenRecords: 2,
};

const unexpected = () => Effect.die(new Error("Unexpected telemetry call"));

const testLayer = (overrides: Partial<PollerHealthTelemetryEffectService>) =>
  Layer.succeed(PollerHealthTelemetry, {
    beginSourcePhase: unexpected,
    claimRuntime: unexpected,
    claimSourceOwnership: unexpected,
    finalizeSource: unexpected,
    finishSource: unexpected,
    heartbeat: unexpected,
    markLockLost: unexpected,
    readRuntime: unexpected,
    recordLockCheck: unexpected,
    recordSourceProgress: unexpected,
    stopRuntime: unexpected,
    ...overrides,
  });

it("requires complete discovery and clean drain outcomes to report complete", () => {
  const cases: {
    completeness: RunCompleteness | null;
    expected: ReturnType<typeof sourceCompletionOutcome>;
  }[] = [
    { completeness: { complete: true }, expected: "complete" },
    { completeness: null, expected: "unknown" },
    {
      completeness: { complete: false, reason: "truncated" },
      expected: "incomplete",
    },
    {
      completeness: { complete: false, reason: "aborted" },
      expected: "incomplete",
    },
  ];
  for (const entry of cases) {
    expect(
      sourceCompletionOutcome(
        { ...run, completeness: entry.completeness },
        completedDrain
      )
    ).toBe(entry.expected);
  }
  expect(sourceCompletionOutcome(run, { ...completedDrain, failed: 1 })).toBe(
    "parked"
  );
  expect(
    sourceCompletionOutcome(run, { ...completedDrain, quarantined: 1 })
  ).toBe("quarantined");
  expect(
    sourceCompletionOutcome(run, { ...completedDrain, remaining: 1 })
  ).toBe("backlogged");
  expect(
    sourceCompletionOutcome(
      { ...run, metrics: { ...run.metrics, error: 1 } },
      completedDrain
    )
  ).toBe("parked");
});

it("limits progress writes but records the first real curation milestone after phase entry", async () => {
  const writes: SourceProgressInput[] = [];
  const { callbacks } = createSourceHealthCallbacks(
    testLayer({
      beginSourcePhase: () => Effect.succeed(true),
      recordSourceProgress: (input) => {
        writes.push(input);
        return Effect.succeed(true);
      },
    }),
    () => new Date(500)
  );
  const milestone = {
    fenceToken: run.fenceToken,
    key: { bronId: run.bronId, scrapeRunId: run.scrapeRunId },
    observedAt: new Date(0),
    phase: "fetch" as const,
  };
  await callbacks.onProgress?.(milestone);
  await callbacks.onProgress?.({ ...milestone, observedAt: new Date(200) });
  expect(writes).toHaveLength(1);
  await callbacks.onCurationStarted?.(run);
  expect(writes).toHaveLength(1);
  await callbacks.onCurationProgress?.(run);
  expect(writes).toHaveLength(2);
  expect(writes[1]?.phase).toBe("curation");
  expect(writes[1]?.at).toEqual(new Date(500));
});

it("rejects stale ownership and sends full proof to source finalization", async () => {
  const proofs: SourceFinalizeInput[] = [];
  const health = createSourceHealthCallbacks(
    testLayer({
      beginSourcePhase: () => Effect.succeed(false),
      finishSource: (input) => {
        proofs.push(input);
        return Effect.succeed(true);
      },
    }),
    () => new Date(1000)
  );
  await expect(
    Promise.resolve(health.callbacks.onCurationStarted?.(run))
  ).rejects.toBeInstanceOf(RunOwnershipLostError);
  await health.finish(run, { ...completedDrain, failed: 1 });
  expect(proofs[0]).toMatchObject({
    discoveryComplete: true,
    drained: true,
    fenceToken: 3,
    hasFailures: true,
    outcome: "parked",
    runId: run.scrapeRunId,
  });
});

it("continues later drain passes and finalizes after an ordinary telemetry failure", async () => {
  let progressCalls = 0;
  const proofs: SourceFinalizeInput[] = [];
  const health = createSourceHealthCallbacks(
    testLayer({
      finishSource: (input) => {
        proofs.push(input);
        return Effect.succeed(true);
      },
      recordSourceProgress: () => {
        progressCalls += 1;
        if (progressCalls === 1) {
          return Effect.die(new Error("telemetry temporarily unavailable"));
        }
        return Effect.succeed(true);
      },
    })
  );
  const { signal } = new AbortController();
  const input = {
    onProgress: () =>
      reportTelemetryCallback(
        health.callbacks.onCurationProgress,
        run,
        {
          bronId: run.bronId,
          bronSlug: run.bronSlug,
          scrapeRunId: run.scrapeRunId,
          telemetryPhase: "curation_progress",
        },
        signal
      ),
  };
  let passes = 0;
  const drained = await drainBacklog(
    {
      deadlineMs: 100,
      input,
      signal,
      start: { ...completedDrain, remaining: 2 },
    },
    async (passInput) => {
      passes += 1;
      await passInput.onProgress();
      return { ...completedDrain, remaining: 2 - passes };
    },
    () => 0
  );
  await health.finish(run, drained);
  expect(passes).toBe(2);
  expect(progressCalls).toBe(2);
  expect(proofs[0]?.outcome).toBe("complete");
});

it("stops an additional drain when telemetry detects lost ownership", async () => {
  let passes = 0;
  const { signal } = new AbortController();
  const health = createSourceHealthCallbacks(
    testLayer({ recordSourceProgress: () => Effect.succeed(false) })
  );
  await expect(
    drainBacklog(
      {
        deadlineMs: 100,
        input: null,
        signal,
        start: { ...completedDrain, remaining: 2 },
      },
      async () => {
        passes += 1;
        await reportTelemetryCallback(
          health.callbacks.onCurationProgress,
          run,
          {
            bronId: run.bronId,
            bronSlug: run.bronSlug,
            scrapeRunId: run.scrapeRunId,
            telemetryPhase: "curation_progress",
          },
          signal
        );
        return completedDrain;
      },
      () => 0
    )
  ).rejects.toBeInstanceOf(RunOwnershipLostError);
  expect(passes).toBe(1);
});
