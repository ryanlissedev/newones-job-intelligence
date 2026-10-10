import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type { PollerHealthTelemetryStore } from "./poller-health-telemetry-store";
import { PostgresPollerHealthTelemetryStore } from "./poller-health-telemetry-store";
import * as schema from "./schema";

export const POLLER_TELEMETRY_OPERATION_TIMEOUT_MS = 2000;
export const POLLER_TELEMETRY_CONNECT_TIMEOUT_MS = 5000;
export const POLLER_TELEMETRY_TEARDOWN_TIMEOUT_MS = 1000;

export class PollerTelemetryOperationTimeoutError extends Error {
  readonly operation: string;

  constructor(operation: string, timeoutMs: number) {
    super(
      `Poller telemetry operation ${operation} exceeded ${timeoutMs}ms deadline`
    );
    this.name = "PollerTelemetryOperationTimeoutError";
    this.operation = operation;
  }
}

export interface PollerHealthTelemetryConnection {
  readonly store: PollerHealthTelemetryStore;
  readonly end: (options: { readonly timeout: number }) => Promise<void>;
}

export interface PollerHealthTelemetryClientOptions {
  readonly connectTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly teardownTimeoutMs?: number;
  readonly connectionFactory?: (
    databaseUrl: string
  ) => PollerHealthTelemetryConnection;
}

const createProductionConnection = (
  databaseUrl: string,
  options: Required<
    Pick<
      PollerHealthTelemetryClientOptions,
      "connectTimeoutMs" | "operationTimeoutMs"
    >
  >
): PollerHealthTelemetryConnection => {
  const sqlClient = postgres(databaseUrl, {
    connect_timeout: Math.ceil(options.connectTimeoutMs / 1000),
    connection: { statement_timeout: options.operationTimeoutMs },
    idle_timeout: 20,
    max: 1,
    max_lifetime: 30 * 60,
  });
  const database = drizzle(sqlClient, { schema });

  return {
    end: (endOptions) => sqlClient.end(endOptions),
    store: new PostgresPollerHealthTelemetryStore(database),
  };
};

const boundedWait = async (
  teardown: Promise<void>,
  timeoutMs: number
): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // oxlint-disable-next-line promise/avoid-new, promise/param-names -- A local teardown deadline must race the driver's end promise.
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([teardown, timeout]);
  } catch {
    // Teardown is best effort after the connection is poisoned. The local
    // deadline still releases the caller even when the driver rejects late.
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

const observeLate = async (promise: Promise<unknown>): Promise<void> => {
  try {
    await promise;
  } catch {
    // The operation was already reported to its caller or superseded by a
    // poisoned-connection deadline; observe its late rejection here.
  }
};

export const createPollerHealthTelemetryClient = (
  databaseUrl: string,
  options: PollerHealthTelemetryClientOptions = {}
) => {
  const connectTimeoutMs =
    options.connectTimeoutMs ?? POLLER_TELEMETRY_CONNECT_TIMEOUT_MS;
  const operationTimeoutMs =
    options.operationTimeoutMs ?? POLLER_TELEMETRY_OPERATION_TIMEOUT_MS;
  const teardownTimeoutMs =
    options.teardownTimeoutMs ?? POLLER_TELEMETRY_TEARDOWN_TIMEOUT_MS;
  const makeConnection =
    options.connectionFactory ??
    ((url: string) =>
      createProductionConnection(url, {
        connectTimeoutMs,
        operationTimeoutMs,
      }));

  let closed = false;
  let current: PollerHealthTelemetryConnection | null = null;
  let disposal: Promise<void> | null = null;

  const poison = (connection: PollerHealthTelemetryConnection): void => {
    if (current !== connection || disposal) {
      return;
    }
    current = null;
    const pending = (async (): Promise<void> => {
      try {
        await connection.end({
          timeout: Math.max(1, Math.ceil(teardownTimeoutMs / 1000)),
        });
        // Only confirmed driver teardown permits replacement. A local waiting
        // deadline or rejected teardown is not evidence that the socket closed.
        disposal = null;
      } catch {
        // Keep the barrier closed when disposal cannot be confirmed. The
        // caller receives bounded errors and a process restart can recover.
      }
    })();
    disposal = pending;
  };

  const acquire = (): PollerHealthTelemetryConnection => {
    if (closed) {
      throw new Error("Poller telemetry client is closed");
    }
    if (disposal) {
      // No acquisition wait can outlive close or later execute a timed-out call.
      throw new Error("Poller telemetry connection teardown is unconfirmed");
    }
    if (!current) {
      current = makeConnection(databaseUrl);
    }
    return current;
  };

  const call = async <A>(
    operationName: string,
    operation: (store: PollerHealthTelemetryStore) => Promise<A>
  ): Promise<A> => {
    const connection = acquire();
    let operationPromise: Promise<A>;
    try {
      operationPromise = operation(connection.store);
    } catch (error) {
      operationPromise = Promise.reject(error);
    }
    // Keep late failures observed after a wall-clock timeout or teardown.
    void observeLate(operationPromise);

    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // oxlint-disable-next-line promise/avoid-new, promise/param-names -- A real wall-clock deadline must race a database promise.
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(
          new PollerTelemetryOperationTimeoutError(
            operationName,
            operationTimeoutMs
          )
        );
      }, operationTimeoutMs);
    });

    try {
      return await Promise.race([operationPromise, deadline]);
    } catch (error) {
      if (timedOut) {
        poison(connection);
      }
      throw error;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  };

  const store: PollerHealthTelemetryStore = {
    beginSourcePhase: (input) =>
      call("beginSourcePhase", (delegate) => delegate.beginSourcePhase(input)),
    claimRuntime: (input) =>
      call("claimRuntime", (delegate) => delegate.claimRuntime(input)),
    claimSourceOwnership: (input) =>
      call("claimSourceOwnership", (delegate) =>
        delegate.claimSourceOwnership(input)
      ),
    finalizeSource: (input) =>
      call("finalizeSource", (delegate) => delegate.finalizeSource(input)),
    finishSource: (input) =>
      call("finishSource", (delegate) => delegate.finishSource(input)),
    heartbeat: (input) =>
      call("heartbeat", (delegate) => delegate.heartbeat(input)),
    markLockLost: (input) =>
      call("markLockLost", (delegate) => delegate.markLockLost(input)),
    readRuntime: () =>
      call("readRuntime", (delegate) => delegate.readRuntime()),
    recordLockCheck: (input) =>
      call("recordLockCheck", (delegate) => delegate.recordLockCheck(input)),
    recordSourceProgress: (input) =>
      call("recordSourceProgress", (delegate) =>
        delegate.recordSourceProgress(input)
      ),
    stopRuntime: (input) =>
      call("stopRuntime", (delegate) => delegate.stopRuntime(input)),
  };

  return {
    close: async (): Promise<void> => {
      closed = true;
      if (current) {
        poison(current);
      }
      if (disposal) {
        await boundedWait(disposal, teardownTimeoutMs);
      }
    },
    store,
  };
};

export type PollerHealthTelemetryClient = ReturnType<
  typeof createPollerHealthTelemetryClient
>;
