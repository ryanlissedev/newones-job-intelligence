import { Effect } from "effect";

import { mapUnknownToUseCaseFault, runUseCasePromise } from "../effect";
import type { RunUseCaseOptions, UseCaseFault } from "../effect";
import { executeBronRun } from "./execute";
import type { ExecuteBronRunInput, ExecuteBronRunResult } from "./execute";
import type { BronPersistence } from "./register";

export const executeBronRunEffect = (
  persistence: BronPersistence,
  input: ExecuteBronRunInput
): Effect.Effect<ExecuteBronRunResult, UseCaseFault> =>
  Effect.tryPromise({
    catch: (cause) => mapUnknownToUseCaseFault(cause),
    try: () => executeBronRun(persistence, input),
  });

export const runExecuteBronRun = (
  persistence: BronPersistence,
  input: ExecuteBronRunInput,
  options?: RunUseCaseOptions
): Promise<ExecuteBronRunResult> =>
  runUseCasePromise(executeBronRunEffect(persistence, input), options);
