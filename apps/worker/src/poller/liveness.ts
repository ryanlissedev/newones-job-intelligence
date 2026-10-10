import { LockLostError } from "@ji/db/process-lock";
import { Effect, Fiber } from "effect";
import type { Scope } from "effect/Scope";

interface PollerLivenessOptions {
  heartbeat: () => Promise<void>;
  intervalMs?: number;
  lockKey: number;
  lockReassert: (options?: { timeoutMs?: number }) => Promise<boolean>;
  onLockLoss: (error: Error) => void;
  onLockVerified?: () => void;
  recordTelemetry?: () => Promise<void>;
  onTelemetryError?: (error: Error) => void;
  signal: AbortSignal;
}

const DEFAULT_INTERVAL_MS = 10_000;
const LOCK_PROBE_TIMEOUT_MS = 2000;
const swallowOperationError = (_error: Error): Promise<void> =>
  Promise.resolve();

interface LivenessState {
  readonly inFlightProbes: Set<Promise<boolean>>;
  readonly inFlightTelemetry: Set<Promise<void>>;
}

const heartbeatLoop = (
  options: PollerLivenessOptions
): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    catch: (error) =>
      error instanceof Error ? error : new Error(String(error)),
    try: async () => {
      await options.heartbeat();
    },
  }).pipe(
    Effect.andThen(
      Effect.sleep(`${options.intervalMs ?? DEFAULT_INTERVAL_MS} millis`)
    )
  );

const lockLoop = (
  options: PollerLivenessOptions,
  state: LivenessState
): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    catch: (error) => {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      options.onLockLoss(normalized);
      return normalized;
    },
    try: async () => {
      if (options.signal.aborted) {
        return;
      }
      const probe = options.lockReassert({
        timeoutMs: LOCK_PROBE_TIMEOUT_MS,
      });
      state.inFlightProbes.add(probe);
      let held: boolean;
      try {
        held = await probe;
      } finally {
        state.inFlightProbes.delete(probe);
      }
      if (!held) {
        throw new LockLostError(options.lockKey);
      }
      options.onLockVerified?.();
    },
  }).pipe(
    Effect.andThen(
      Effect.sleep(`${options.intervalMs ?? DEFAULT_INTERVAL_MS} millis`)
    )
  );

const livenessProgram = (
  options: PollerLivenessOptions,
  state: LivenessState
): Effect.Effect<never, Error, Scope> =>
  Effect.gen(function* livenessGenerator() {
    yield* Effect.forkScoped(heartbeatLoop(options).pipe(Effect.forever));
    if (options.recordTelemetry) {
      const { recordTelemetry } = options;
      yield* Effect.forkScoped(
        heartbeatLoop({
          ...options,
          heartbeat: async () => {
            const write = recordTelemetry();
            state.inFlightTelemetry.add(write);
            try {
              await write;
            } catch (error) {
              options.onTelemetryError?.(
                error instanceof Error ? error : new Error(String(error))
              );
            } finally {
              state.inFlightTelemetry.delete(write);
            }
          },
        }).pipe(Effect.forever)
      );
    }
    return yield* lockLoop(options, state).pipe(Effect.forever);
  });

/**
 * Runs process heartbeat and lock readiness in one scoped Effect fiber. The
 * caller's Promise loop remains the owner of source progress and shutdown;
 * this fiber only aborts that loop when the singleton lock is no longer held.
 */
export const runWithPollerLiveness = async <A>(
  options: PollerLivenessOptions,
  run: () => Promise<A>
): Promise<A> => {
  const failure = Promise.withResolvers<never>();
  const program = Effect.scoped(
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const state: LivenessState = {
          inFlightProbes: new Set(),
          inFlightTelemetry: new Set(),
        };
        const fiber = Effect.runFork(
          Effect.scoped(
            livenessProgram(
              {
                ...options,
                onLockLoss: (error) => {
                  options.onLockLoss(error);
                  failure.reject(error);
                },
              },
              state
            )
          )
        );
        return { fiber, state };
      }),
      () =>
        Effect.promise(async () => {
          const operation = run();
          try {
            return await Promise.race([operation, failure.promise]);
          } catch (error) {
            // Do not release the singleton lock while the Promise loop still
            // has a database write in flight. Cancellable adapters stop from
            // the shared signal; uncancellable work must settle first.
            await operation.catch(swallowOperationError);
            throw error;
          }
        }),
      ({ fiber, state }) =>
        Effect.gen(function* stopLiveness() {
          yield* Fiber.interrupt(fiber);
          yield* Effect.promise(() =>
            Promise.allSettled([
              ...state.inFlightProbes,
              ...state.inFlightTelemetry,
            ])
          );
        })
    )
  );
  return await Effect.runPromise(program);
};

export type { PollerLivenessOptions };
