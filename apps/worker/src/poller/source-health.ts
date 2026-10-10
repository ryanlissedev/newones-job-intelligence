import { RunOwnershipLostError } from "@ji/connectors";
import { PollerHealthTelemetry } from "@ji/db/poller-health-telemetry-store";
import type {
  PollerHealthTelemetryEffectService,
  SourceRunOutcome,
} from "@ji/db/poller-health-telemetry-store";
import { Effect } from "effect";
import type { Layer } from "effect";

import type {
  BronIngestPipelineResult,
  PollBronRunOptions,
  PollBronRunResult,
} from "../poll-bron-run";
import type { BacklogDrain } from "./drain-backlog";

const PROGRESS_WRITE_INTERVAL_MS = 1000;

/** Full discovery and all curation passes must agree before freshness advances. */
export const sourceCompletionOutcome = (
  result: Pick<BronIngestPipelineResult, "completeness" | "metrics">,
  drained: BacklogDrain
): SourceRunOutcome => {
  if (drained.failed > 0 || result.metrics.error > 0) {
    return "parked";
  }
  if (drained.quarantined > 0) {
    return "quarantined";
  }
  if (drained.remaining > 0) {
    return "backlogged";
  }
  if (!result.completeness) {
    return "unknown";
  }
  return result.completeness.complete ? "complete" : "incomplete";
};

export const createSourceHealthCallbacks = (
  layer: Layer.Layer<PollerHealthTelemetryEffectService>,
  now: () => Date = () => new Date()
) => {
  let lastProgressWriteAt: number | null = null;
  const recordProgress = async (
    input: Parameters<
      PollerHealthTelemetryEffectService["recordSourceProgress"]
    >[0]
  ): Promise<void> => {
    if (
      lastProgressWriteAt !== null &&
      input.at.getTime() - lastProgressWriteAt < PROGRESS_WRITE_INTERVAL_MS
    ) {
      return;
    }
    const owned = await Effect.runPromise(
      Effect.gen(function* recordMilestone() {
        const telemetry = yield* PollerHealthTelemetry;
        return yield* telemetry.recordSourceProgress(input);
      }).pipe(Effect.provide(layer))
    );
    if (!owned) {
      throw new RunOwnershipLostError();
    }
    lastProgressWriteAt = input.at.getTime();
  };
  const callbacks: PollBronRunOptions = {
    onAborted: async (run) => {
      const owned = await Effect.runPromise(
        Effect.gen(function* abortSource() {
          const telemetry = yield* PollerHealthTelemetry;
          return yield* telemetry.finishSource({
            bronId: run.bronId,
            completedAt: now(),
            discoveryComplete: false,
            drained: false,
            fenceToken: run.fenceToken,
            hasFailures: false,
            hasQuarantined: false,
            outcome: "incomplete",
            runId: run.scrapeRunId,
          });
        }).pipe(Effect.provide(layer))
      );
      if (!owned) {
        throw new RunOwnershipLostError();
      }
    },
    onCurationProgress: (run) =>
      recordProgress({
        at: now(),
        bronId: run.bronId,
        fenceToken: run.fenceToken,
        phase: "curation",
        runId: run.scrapeRunId,
      }),
    onCurationStarted: async (run) => {
      const owned = await Effect.runPromise(
        Effect.gen(function* beginCuration() {
          const telemetry = yield* PollerHealthTelemetry;
          return yield* telemetry.beginSourcePhase({
            bronId: run.bronId,
            fenceToken: run.fenceToken,
            phase: "curation",
            phaseStartedAt: now(),
            runId: run.scrapeRunId,
          });
        }).pipe(Effect.provide(layer))
      );
      if (!owned) {
        throw new RunOwnershipLostError();
      }
      lastProgressWriteAt = null;
    },
    onProgress: (milestone) =>
      recordProgress({
        at: milestone.observedAt,
        bronId: milestone.key.bronId,
        fenceToken: milestone.fenceToken,
        phase: milestone.phase,
        runId: milestone.key.scrapeRunId,
      }),
  };
  const finish = async (
    run: PollBronRunResult,
    drained: BacklogDrain
  ): Promise<void> => {
    const owned = await Effect.runPromise(
      Effect.gen(function* finishSource() {
        const telemetry = yield* PollerHealthTelemetry;
        return yield* telemetry.finishSource({
          bronId: run.bronId,
          completedAt: now(),
          discoveryComplete: run.completeness?.complete === true,
          drained: drained.remaining === 0,
          fenceToken: run.fenceToken,
          hasFailures: drained.failed > 0 || run.metrics.error > 0,
          hasQuarantined: drained.quarantined > 0,
          outcome: sourceCompletionOutcome(run, drained),
          runId: run.scrapeRunId,
        });
      }).pipe(Effect.provide(layer))
    );
    if (!owned) {
      throw new RunOwnershipLostError();
    }
  };
  return { callbacks, finish };
};
