import { Effect } from "effect";

import { mapUnknownToUseCaseFault, runUseCasePromise } from "../effect";
import type { RunUseCaseOptions, UseCaseFault } from "../effect";
import { processRecordedObservations } from "./pipeline";
import type { ProcessRecordedObservationsInput } from "./pipeline";

export const processRecordedObservationsEffect = (
  input: ProcessRecordedObservationsInput
): Effect.Effect<void, UseCaseFault> =>
  Effect.tryPromise({
    catch: (cause) => mapUnknownToUseCaseFault(cause),
    try: () => processRecordedObservations(input),
  });

export const runProcessRecordedObservations = (
  input: ProcessRecordedObservationsInput,
  options?: RunUseCaseOptions
): Promise<void> =>
  runUseCasePromise(processRecordedObservationsEffect(input), options);
