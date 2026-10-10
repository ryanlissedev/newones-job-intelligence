import { Effect } from "effect";

import { mapUnknownToUseCaseFault, runUseCasePromise } from "../effect";
import type { RunUseCaseOptions, UseCaseFault } from "../effect";
import { deriveBronHealth, deriveBronHealthOverview } from "./bron-health";
import type {
  BronHealthInput,
  BronHealthOverview,
  BronHealthOverviewInput,
  BronHealthResult,
  DeriveBronHealthOptions,
} from "./bron-health";
import { nextCronRun, parseCronExpression } from "./cron";
import {
  buildSilenceDedupeKey,
  emitSilenceEvent,
  evaluateSilence,
  observeConnectorRunSilence,
} from "./silence";
import type {
  SilenceAlertWriter,
  SilenceDetectionInput,
  SilenceEventPayload,
} from "./silence";

export const deriveBronHealthEffect = (
  input: BronHealthInput,
  now: Date,
  options: DeriveBronHealthOptions = {}
): Effect.Effect<BronHealthResult, never> =>
  Effect.sync(() => deriveBronHealth(input, now, options));

export const deriveBronHealthOverviewEffect = (
  input: BronHealthOverviewInput,
  now: Date,
  options: Omit<DeriveBronHealthOptions, "schedulerStale"> = {}
): Effect.Effect<BronHealthOverview, never> =>
  Effect.sync(() => deriveBronHealthOverview(input, now, options));

export const evaluateSilenceEffect = (
  input: SilenceDetectionInput
): Effect.Effect<SilenceEventPayload | null, never> =>
  Effect.sync(() => evaluateSilence(input));

export const buildSilenceDedupeKeyEffect = (
  bronId: string
): Effect.Effect<string, never> =>
  Effect.sync(() => buildSilenceDedupeKey(bronId));

export const parseCronExpressionEffect = (
  expression: string
): Effect.Effect<ReturnType<typeof parseCronExpression>, never> =>
  Effect.sync(() => parseCronExpression(expression));

export const nextCronRunEffect = (
  expression: string,
  after: Date,
  timeZone: string
): Effect.Effect<Date | null, never> =>
  Effect.sync(() => nextCronRun(expression, after, timeZone));

export const emitSilenceEventEffect = (
  writer: SilenceAlertWriter,
  event: SilenceEventPayload
): Effect.Effect<{ alertId: string; created: boolean }, UseCaseFault> =>
  Effect.tryPromise({
    catch: (cause) => mapUnknownToUseCaseFault(cause),
    try: () => emitSilenceEvent(writer, event),
  });

export const observeConnectorRunSilenceEffect = (
  input: Parameters<typeof observeConnectorRunSilence>[0]
): Effect.Effect<
  Awaited<ReturnType<typeof observeConnectorRunSilence>>,
  UseCaseFault
> =>
  Effect.tryPromise({
    catch: (cause) => mapUnknownToUseCaseFault(cause),
    try: () => observeConnectorRunSilence(input),
  });

export const runDeriveBronHealth = (
  input: BronHealthInput,
  now: Date,
  options?: DeriveBronHealthOptions,
  runOptions?: RunUseCaseOptions
): Promise<BronHealthResult> =>
  runUseCasePromise(deriveBronHealthEffect(input, now, options), runOptions);

export const runEvaluateSilence = (
  input: SilenceDetectionInput,
  options?: RunUseCaseOptions
): Promise<SilenceEventPayload | null> =>
  runUseCasePromise(evaluateSilenceEffect(input), options);

export const runParseCronExpression = (
  expression: string,
  options?: RunUseCaseOptions
): Promise<ReturnType<typeof parseCronExpression>> =>
  runUseCasePromise(parseCronExpressionEffect(expression), options);

export const runEmitSilenceEvent = (
  writer: SilenceAlertWriter,
  event: SilenceEventPayload,
  options?: RunUseCaseOptions
): Promise<{ alertId: string; created: boolean }> =>
  runUseCasePromise(emitSilenceEventEffect(writer, event), options);

export const runObserveConnectorRunSilence = (
  input: Parameters<typeof observeConnectorRunSilence>[0],
  options?: RunUseCaseOptions
): Promise<Awaited<ReturnType<typeof observeConnectorRunSilence>>> =>
  runUseCasePromise(observeConnectorRunSilenceEffect(input), options);
