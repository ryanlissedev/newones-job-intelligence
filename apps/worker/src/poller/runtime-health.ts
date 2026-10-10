import type {
  PollerHealthTelemetryClientOptions,
  PollerHealthTelemetryClient,
} from "@ji/db/poller-health-telemetry-client";
import { createPollerHealthTelemetryClient } from "@ji/db/poller-health-telemetry-client";
import {
  PollerHealthTelemetry,
  PollerHealthTelemetryLive,
} from "@ji/db/poller-health-telemetry-store";
import type {
  PollerHealthTelemetryEffectService,
  PollerRuntimeClaim,
  RuntimeObservationInput,
} from "@ji/db/poller-health-telemetry-store";
import { Effect } from "effect";
import type { Layer } from "effect";

export class PollerRuntimeOwnershipLostError extends Error {
  readonly operation: "heartbeat" | "lock_check";

  constructor(operation: "heartbeat" | "lock_check") {
    super(`Poller runtime ownership was lost during ${operation}`);
    this.name = "PollerRuntimeOwnershipLostError";
    this.operation = operation;
  }
}

export interface PollerRuntimeHealthOptions {
  readonly advisoryLockMaxAgeMs: number;
  readonly curationBudgetMs: number;
  readonly databaseUrl: string;
  readonly heartbeatAt: Date;
  readonly heartbeatMaxAgeMs: number;
  readonly instanceId: string;
  readonly lastLockCheckAt: Date;
  readonly ownerToken?: string;
  readonly releaseSha: string | null;
  readonly runBudgetMs: number;
  readonly startedAt: Date;
  readonly telemetryClientOptions?: PollerHealthTelemetryClientOptions;
}

export interface PollerRuntimeHealth {
  readonly client: PollerHealthTelemetryClient;
  readonly fenceToken: number;
  readonly layer: Layer.Layer<PollerHealthTelemetryEffectService>;
  readonly ownerToken: string;
  readonly recordTelemetry: (input: {
    readonly heartbeatAt: Date;
    readonly lastLockCheckAt: Date;
  }) => Promise<void>;
  readonly markLockLost: (at: Date) => Promise<boolean>;
  readonly stopRuntime: (at: Date) => Promise<boolean>;
  readonly close: () => Promise<void>;
}

const runEffect = <A>(
  layer: Layer.Layer<PollerHealthTelemetryEffectService>,
  effect: Effect.Effect<A, unknown, PollerHealthTelemetryEffectService>
): Promise<A> =>
  // SAFETY: `layer` provides the only service required by every effect passed
  // to this helper, so the provided effect has no remaining environment.
  Effect.runPromise(
    effect.pipe(Effect.provide(layer)) as Effect.Effect<A, unknown, never>
  );

const observation = (
  claim: PollerRuntimeClaim,
  at: Date
): RuntimeObservationInput => ({
  at,
  fenceToken: claim.fenceToken,
  ownerToken: claim.ownerToken,
});

/**
 * Claims the database runtime row after the session advisory lock is held.
 * The returned layer is shared by source progress and process telemetry, so
 * each operation uses the bounded client rather than opening a source-local
 * pool. A failed initial claim closes the client before the error escapes.
 */
export const createPollerRuntimeHealth = async (
  options: PollerRuntimeHealthOptions
): Promise<PollerRuntimeHealth> => {
  const client = createPollerHealthTelemetryClient(
    options.databaseUrl,
    options.telemetryClientOptions
  );
  const layer = PollerHealthTelemetryLive(client.store);
  const ownerToken = options.ownerToken ?? crypto.randomUUID();
  try {
    const claim = await runEffect(
      layer,
      Effect.gen(function* claimRuntime() {
        const telemetry = yield* PollerHealthTelemetry;
        return yield* telemetry.claimRuntime({
          advisoryLockAcquired: true,
          advisoryLockMaxAgeMs: options.advisoryLockMaxAgeMs,
          curationBudgetMs: options.curationBudgetMs,
          heartbeatAt: options.heartbeatAt,
          heartbeatMaxAgeMs: options.heartbeatMaxAgeMs,
          instanceId: options.instanceId,
          lastLockCheckAt: options.lastLockCheckAt,
          ownerToken,
          releaseSha: options.releaseSha,
          runBudgetMs: options.runBudgetMs,
          startedAt: options.startedAt,
        });
      })
    );

    return {
      client,
      close: () => client.close(),
      fenceToken: claim.fenceToken,
      layer,
      markLockLost: (at) =>
        runEffect(
          layer,
          Effect.gen(function* markLockLost() {
            const telemetry = yield* PollerHealthTelemetry;
            return yield* telemetry.markLockLost(observation(claim, at));
          })
        ),
      ownerToken: claim.ownerToken,
      recordTelemetry: async ({ heartbeatAt, lastLockCheckAt }) => {
        const heartbeatOwned = await runEffect(
          layer,
          Effect.gen(function* recordHeartbeat() {
            const telemetry = yield* PollerHealthTelemetry;
            return yield* telemetry.heartbeat(observation(claim, heartbeatAt));
          })
        );
        if (!heartbeatOwned) {
          throw new PollerRuntimeOwnershipLostError("heartbeat");
        }

        const lockCheckOwned = await runEffect(
          layer,
          Effect.gen(function* recordLockCheck() {
            const telemetry = yield* PollerHealthTelemetry;
            return yield* telemetry.recordLockCheck(
              observation(claim, lastLockCheckAt)
            );
          })
        );
        if (!lockCheckOwned) {
          throw new PollerRuntimeOwnershipLostError("lock_check");
        }
      },
      stopRuntime: (at) =>
        runEffect(
          layer,
          Effect.gen(function* stopRuntime() {
            const telemetry = yield* PollerHealthTelemetry;
            return yield* telemetry.stopRuntime(observation(claim, at));
          })
        ),
    };
  } catch (error) {
    await client.close();
    throw error;
  }
};
