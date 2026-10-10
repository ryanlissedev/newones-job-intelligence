import { Effect } from "effect";

import { mapUnknownToWorkerFault } from "./faults";
import type { WorkerFault } from "./faults";

/**
 * Lift a Promise task body into an Effect that fails with WorkerFault.
 * Opt-in only (CTP-476 Slice 10) — Trigger.dev still owns durability/maxAttempts.
 */
export const fromWorkerPromise = <A>(
  evaluate: () => Promise<A>
): Effect.Effect<A, WorkerFault> =>
  Effect.tryPromise({
    catch: mapUnknownToWorkerFault,
    try: evaluate,
  });
