import type { Effect } from "effect";

import { runDrainOutbox } from "../tasks/drain-outbox";
import type { WorkerFault } from "./faults";
import { fromWorkerPromise } from "./from-promise";
import { runWorkerPromise } from "./run";
import type { RunWorkerPromiseOptions } from "./run";

export interface DrainOutboxEffectPayload {
  batchSize?: number;
  leaseSeconds?: number;
  limit?: number;
  maxAttempts?: number;
}

export const drainOutboxTaskBodyProgram = (
  payload: DrainOutboxEffectPayload
): Effect.Effect<Awaited<ReturnType<typeof runDrainOutbox>>, WorkerFault> =>
  fromWorkerPromise(() => runDrainOutbox(payload));

/**
 * Opt-in Effect Promise boundary for drain-outbox task body.
 * Default schemaTask `run` stays native `runDrainOutbox` (prod Effect OFF).
 */
export const runDrainOutboxEffect = (
  payload: DrainOutboxEffectPayload,
  options: RunWorkerPromiseOptions = {}
): Promise<Awaited<ReturnType<typeof runDrainOutbox>>> =>
  runWorkerPromise(drainOutboxTaskBodyProgram(payload), options);
