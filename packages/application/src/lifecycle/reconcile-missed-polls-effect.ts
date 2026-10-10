import { Effect } from "effect";

import { mapUnknownToUseCaseFault, runUseCasePromise } from "../effect";
import type { RunUseCaseOptions, UseCaseFault } from "../effect";
import { reconcileMissedPolls } from "./reconcile-missed-polls";
import type {
  LifecycleReconcilePorts,
  ReconcileMissedPollsInput,
  ReconcileMissedPollsResult,
} from "./reconcile-missed-polls";

export const reconcileMissedPollsEffect = (
  ports: LifecycleReconcilePorts,
  input: ReconcileMissedPollsInput
): Effect.Effect<ReconcileMissedPollsResult, UseCaseFault> =>
  Effect.tryPromise({
    catch: (cause) => mapUnknownToUseCaseFault(cause),
    try: () => reconcileMissedPolls(ports, input),
  });

export const runReconcileMissedPolls = (
  ports: LifecycleReconcilePorts,
  input: ReconcileMissedPollsInput,
  options?: RunUseCaseOptions
): Promise<ReconcileMissedPollsResult> =>
  runUseCasePromise(reconcileMissedPollsEffect(ports, input), options);
