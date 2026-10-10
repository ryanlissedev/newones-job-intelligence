import { describe, expect, it } from "bun:test";

import type {
  PollerHealthTelemetryClientOptions,
  PollerHealthTelemetryConnection,
} from "@ji/db/poller-health-telemetry-client";
import type {
  PollerHealthTelemetryStore,
  PollerRuntimeClaim,
  PollerRuntimeClaimInput,
  RuntimeObservationInput,
} from "@ji/db/poller-health-telemetry-store";

import {
  createPollerRuntimeHealth,
  PollerRuntimeOwnershipLostError,
} from "./runtime-health";

const startedAt = new Date("2026-09-19T08:00:00.000Z");

const makeStore = (
  overrides: Partial<PollerHealthTelemetryStore> = {}
): PollerHealthTelemetryStore => {
  const ownerToken = crypto.randomUUID();
  const claim: PollerRuntimeClaim = {
    fenceToken: 7,
    ownerToken,
    record: {
      advisoryLockMaxAgeMs: 300_000,
      component: "poller",
      curationBudgetMs: 120_000,
      fenceToken: 7,
      heartbeatAt: startedAt,
      heartbeatMaxAgeMs: 300_000,
      instanceId: "host-a:1234",
      lastLockCheckAt: startedAt,
      ownerToken,
      releaseSha: "a".repeat(40),
      runBudgetMs: 3_600_000,
      startedAt,
      status: "running",
      updatedAt: startedAt,
    },
  };
  const base: PollerHealthTelemetryStore = {
    beginSourcePhase: () => Promise.resolve(true),
    claimRuntime: () => Promise.resolve(claim),
    claimSourceOwnership: () => Promise.resolve(true),
    finalizeSource: () => Promise.resolve(true),
    finishSource: () => Promise.resolve(true),
    heartbeat: () => Promise.resolve(true),
    markLockLost: () => Promise.resolve(true),
    readRuntime: () => Promise.resolve(claim.record),
    recordLockCheck: () => Promise.resolve(true),
    recordSourceProgress: () => Promise.resolve(true),
    stopRuntime: () => Promise.resolve(true),
  };
  return { ...base, ...overrides };
};

const makeConnection = (
  store: PollerHealthTelemetryStore,
  end: () => Promise<void>
): PollerHealthTelemetryConnection => ({ end, store });

const options = (
  connectionFactory: NonNullable<
    PollerHealthTelemetryClientOptions["connectionFactory"]
  >,
  overrides: Partial<Parameters<typeof createPollerRuntimeHealth>[0]> = {}
): Parameters<typeof createPollerRuntimeHealth>[0] => ({
  advisoryLockMaxAgeMs: 300_000,
  curationBudgetMs: 120_000,
  databaseUrl: "postgresql://telemetry.test/db",
  heartbeatAt: startedAt,
  heartbeatMaxAgeMs: 300_000,
  instanceId: "host-a:1234",
  lastLockCheckAt: startedAt,
  releaseSha: "a".repeat(40),
  runBudgetMs: 3_600_000,
  startedAt,
  telemetryClientOptions: {
    connectionFactory,
    operationTimeoutMs: 20,
    teardownTimeoutMs: 20,
  },
  ...overrides,
});

describe("poller runtime health", () => {
  it("claims with the lock-scoped identity and records actual observation times", async () => {
    const claimInputs: PollerRuntimeClaimInput[] = [];
    const heartbeatInputs: RuntimeObservationInput[] = [];
    const lockCheckInputs: RuntimeObservationInput[] = [];
    const fallbackStore = makeStore();
    const store = makeStore({
      claimRuntime: (input) => {
        claimInputs.push(input);
        return fallbackStore.claimRuntime(input);
      },
      heartbeat: (input) => {
        heartbeatInputs.push(input);
        return Promise.resolve(true);
      },
      recordLockCheck: (input) => {
        lockCheckInputs.push(input);
        return Promise.resolve(true);
      },
    });
    const client = await createPollerRuntimeHealth(
      options(() => makeConnection(store, () => Promise.resolve()))
    );
    const heartbeatAt = new Date("2026-09-19T08:00:10.000Z");
    const lockCheckAt = new Date("2026-09-19T08:00:11.000Z");

    await client.recordTelemetry({ heartbeatAt, lastLockCheckAt: lockCheckAt });

    expect(claimInputs).toHaveLength(1);
    expect(claimInputs[0]).toMatchObject({
      advisoryLockAcquired: true,
      advisoryLockMaxAgeMs: 300_000,
      curationBudgetMs: 120_000,
      heartbeatAt: startedAt,
      heartbeatMaxAgeMs: 300_000,
      instanceId: "host-a:1234",
      lastLockCheckAt: startedAt,
      releaseSha: "a".repeat(40),
      runBudgetMs: 3_600_000,
      startedAt,
    });
    expect(heartbeatInputs[0]).toMatchObject({
      at: heartbeatAt,
      fenceToken: 7,
    });
    expect(lockCheckInputs[0]).toMatchObject({
      at: lockCheckAt,
      fenceToken: 7,
    });
    await client.close();
  });

  it("turns a fenced false into a typed ownership failure", async () => {
    const client = await createPollerRuntimeHealth(
      options(() =>
        makeConnection(
          makeStore({ heartbeat: () => Promise.resolve(false) }),
          () => Promise.resolve()
        )
      )
    );

    await expect(
      client.recordTelemetry({
        heartbeatAt: startedAt,
        lastLockCheckAt: startedAt,
      })
    ).rejects.toBeInstanceOf(PollerRuntimeOwnershipLostError);
    await client.close();
  });

  it("closes the bounded client when the initial claim fails", async () => {
    let endCalls = 0;
    await expect(
      createPollerRuntimeHealth(
        options(() =>
          makeConnection(
            makeStore({
              claimRuntime: () => Promise.reject(new Error("claim failed")),
            }),
            () => {
              endCalls += 1;
              return Promise.resolve();
            }
          )
        )
      )
    ).rejects.toThrow("claim failed");
    expect(endCalls).toBe(1);
  });
});
