import { afterEach, describe, expect, it } from "bun:test";

import type {
  PollerHealthTelemetryConnection,
  PollerHealthTelemetryClientOptions,
} from "./poller-health-telemetry-client";
import { createPollerHealthTelemetryClient } from "./poller-health-telemetry-client";
import type {
  PollerHealthTelemetryStore,
  PollerRuntimeClaim,
  RuntimeObservationInput,
  SourceFinalizeInput,
  SourceOwnershipInput,
  SourcePhaseInput,
  SourceProgressInput,
} from "./poller-health-telemetry-store";

const observation: RuntimeObservationInput = {
  at: new Date("2026-09-19T08:00:00.000Z"),
  fenceToken: 1,
  ownerToken: crypto.randomUUID(),
};

const makeStore = (
  overrides: Partial<PollerHealthTelemetryStore> = {}
): PollerHealthTelemetryStore => {
  const claim: PollerRuntimeClaim = {
    fenceToken: 1,
    ownerToken: observation.ownerToken,
    record: {
      advisoryLockMaxAgeMs: 30_000,
      component: "poller",
      curationBudgetMs: 60_000,
      fenceToken: 1,
      heartbeatAt: observation.at,
      heartbeatMaxAgeMs: 30_000,
      instanceId: "test",
      lastLockCheckAt: observation.at,
      ownerToken: observation.ownerToken,
      releaseSha: null,
      runBudgetMs: 120_000,
      startedAt: observation.at,
      status: "running",
      updatedAt: observation.at,
    },
  };
  const sourceOwnership: SourceOwnershipInput = {
    bronId: crypto.randomUUID(),
    fenceToken: 1,
    phase: "fetch",
    phaseStartedAt: observation.at,
    runId: crypto.randomUUID(),
  };
  const sourceProgress: SourceProgressInput = {
    at: observation.at,
    bronId: sourceOwnership.bronId,
    fenceToken: 1,
    phase: "fetch",
    runId: sourceOwnership.runId,
  };
  const sourcePhase: SourcePhaseInput = {
    ...sourceOwnership,
  };
  const sourceFinalize: SourceFinalizeInput = {
    bronId: sourceOwnership.bronId,
    completedAt: observation.at,
    discoveryComplete: true,
    drained: true,
    fenceToken: 1,
    hasFailures: false,
    hasQuarantined: false,
    outcome: "complete",
    runId: sourceOwnership.runId,
  };

  const base: PollerHealthTelemetryStore = {
    beginSourcePhase: (_input: SourcePhaseInput) => Promise.resolve(true),
    claimRuntime: () => Promise.resolve(claim),
    claimSourceOwnership: (_input: SourceOwnershipInput) =>
      Promise.resolve(true),
    finalizeSource: (_input: SourceFinalizeInput) => Promise.resolve(true),
    finishSource: (_input: SourceFinalizeInput) => Promise.resolve(true),
    heartbeat: (_input: RuntimeObservationInput) => Promise.resolve(true),
    markLockLost: (_input: RuntimeObservationInput) => Promise.resolve(true),
    readRuntime: () => Promise.resolve(claim.record),
    recordLockCheck: (_input: RuntimeObservationInput) => Promise.resolve(true),
    recordSourceProgress: (_input: SourceProgressInput) =>
      Promise.resolve(true),
    stopRuntime: (_input: RuntimeObservationInput) => Promise.resolve(true),
  };

  // Keep these values typechecked so the fake remains aligned with the store
  // contract as root integration starts consuming each operation.
  void sourcePhase;
  void sourceProgress;
  void sourceFinalize;
  return { ...base, ...overrides };
};

const makeConnection = (
  store: PollerHealthTelemetryStore,
  end: () => Promise<void>
): PollerHealthTelemetryConnection => ({
  end,
  store,
});

const clientOptions = (
  connectionFactory: NonNullable<
    PollerHealthTelemetryClientOptions["connectionFactory"]
  >,
  overrides: Omit<PollerHealthTelemetryClientOptions, "connectionFactory"> = {}
): PollerHealthTelemetryClientOptions => ({
  connectionFactory,
  operationTimeoutMs: 20,
  teardownTimeoutMs: 20,
  ...overrides,
});

const clients: { close: () => Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe("poller health telemetry client", () => {
  it("poisons a half-open connection, observes its late rejection, and recreates after disposal", async () => {
    let rejectLate: ((reason: Error) => void) | undefined;
    let endCalls = 0;
    let factoryCalls = 0;
    const factory = () => {
      factoryCalls += 1;
      const pendingStore = makeStore({
        heartbeat: () =>
          // oxlint-disable-next-line promise/avoid-new, promise/param-names -- Deliberately half-open database operation.
          new Promise<boolean>((_resolve, reject) => {
            rejectLate = reject;
          }),
      });
      return makeConnection(pendingStore, () => {
        endCalls += 1;
        return Promise.resolve();
      });
    };
    const client = createPollerHealthTelemetryClient(
      "postgresql://test",
      clientOptions(factory)
    );
    clients.push(client);

    await expect(client.store.heartbeat(observation)).rejects.toMatchObject({
      name: "PollerTelemetryOperationTimeoutError",
    });
    expect(endCalls).toBe(1);
    rejectLate?.(new Error("late database rejection"));
    await Bun.sleep(0);

    await expect(client.store.readRuntime()).resolves.toBeDefined();
    expect(factoryCalls).toBe(2);
  });

  it("bounds shutdown when the poisoned client's end promise is half-open", async () => {
    let endCalls = 0;
    const client = createPollerHealthTelemetryClient(
      "postgresql://test",
      clientOptions(
        () =>
          makeConnection(makeStore(), () => {
            endCalls += 1;
            // oxlint-disable-next-line promise/avoid-new -- Deliberately half-open teardown.
            return new Promise<void>(() => {});
          }),
        { teardownTimeoutMs: 20 }
      )
    );
    clients.push(client);
    await client.store.readRuntime();

    const startedAt = performance.now();
    await client.close();
    const elapsedMs = performance.now() - startedAt;

    expect(endCalls).toBe(1);
    expect(elapsedMs).toBeLessThan(200);
    await expect(client.store.readRuntime()).rejects.toThrow(
      "client is closed"
    );
  });

  it("keeps the disposal barrier after its local deadline and never reopens after close", async () => {
    const end = Promise.withResolvers<null>();
    let factoryCalls = 0;
    const client = createPollerHealthTelemetryClient(
      "postgresql://test",
      clientOptions(() => {
        factoryCalls += 1;
        return makeConnection(
          makeStore({
            heartbeat: () => Promise.withResolvers<boolean>().promise,
          }),
          async () => {
            await end.promise;
          }
        );
      })
    );
    clients.push(client);
    await expect(client.store.heartbeat(observation)).rejects.toMatchObject({
      name: "PollerTelemetryOperationTimeoutError",
    });
    await expect(client.store.readRuntime()).rejects.toThrow(
      "teardown is unconfirmed"
    );
    expect(factoryCalls).toBe(1);
    await client.close();
    await expect(client.store.readRuntime()).rejects.toThrow(
      "client is closed"
    );
    end.resolve(null);
    await Bun.sleep(0);
    await expect(client.store.readRuntime()).rejects.toThrow(
      "client is closed"
    );
    expect(factoryCalls).toBe(1);
  });

  it("allows replacement only after the original teardown confirms completion", async () => {
    const end = Promise.withResolvers<null>();
    let factoryCalls = 0;
    const client = createPollerHealthTelemetryClient(
      "postgresql://test",
      clientOptions(() => {
        factoryCalls += 1;
        const store =
          factoryCalls === 1
            ? makeStore({
                heartbeat: () => Promise.withResolvers<boolean>().promise,
              })
            : makeStore();
        return makeConnection(store, async () => {
          await end.promise;
        });
      })
    );
    clients.push(client);
    await expect(client.store.heartbeat(observation)).rejects.toMatchObject({
      name: "PollerTelemetryOperationTimeoutError",
    });
    await expect(client.store.readRuntime()).rejects.toThrow(
      "teardown is unconfirmed"
    );
    expect(factoryCalls).toBe(1);
    end.resolve(null);
    await Bun.sleep(0);
    await expect(client.store.readRuntime()).resolves.toBeDefined();
    expect(factoryCalls).toBe(2);
  });
});
