import { beforeAll, describe, expect, it } from "bun:test";

import { PROJECTOR_DATABASE_URL_DIRECT_MESSAGE } from "@ji/env/projector-database-url";
import postgres from "postgres";

import {
  acquireAdvisoryLock,
  runBoundedLockQuery,
  waitForAdvisoryLock,
} from "./process-lock";

const testDatabaseUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
const testDatabaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;

const isPostgresAvailable = async (): Promise<boolean> => {
  const probe = postgres(testDatabaseUrl, { connect_timeout: 2, max: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
    return true;
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return false;
  }
};

describe("runBoundedLockQuery", () => {
  it("bounds teardown without leaving a late query rejection unobserved", async () => {
    const query = Promise.withResolvers<never>();
    const timeoutError = new Error("probe timed out");
    let teardownStarted = false;
    const pending = runBoundedLockQuery(query.promise, 5, timeoutError, () => {
      teardownStarted = true;
    });

    await expect(pending).rejects.toBe(timeoutError);
    expect(teardownStarted).toBe(true);
    query.reject(new Error("cancelled after teardown"));
  });

  it("propagates a query cancellation rejection before the deadline", async () => {
    const query = Promise.withResolvers<never>();
    const cancellation = new Error("cancelled");
    let timedOut = false;
    const pending = runBoundedLockQuery(
      query.promise,
      1000,
      cancellation,
      () => {
        timedOut = true;
      }
    );

    query.reject(cancellation);

    await expect(pending).rejects.toBe(cancellation);
    expect(timedOut).toBe(false);
  });
});

describe("acquireAdvisoryLock (RJC-387)", () => {
  let postgresAvailable = false;

  beforeAll(async () => {
    postgresAvailable = await isPostgresAvailable();
    if (!postgresAvailable && testDatabaseRequired) {
      throw new Error("Required test database is unavailable");
    }
  });

  it("rejects a known Neon pooler URL before opening the lock connection", async () => {
    await expect(
      acquireAdvisoryLock(
        "postgresql://ji_app:secret@ep-example-host-pooler.eu-central-1.aws.neon.tech/catapulze?sslmode=require",
        900_000_001,
        "PROJECTOR_DATABASE_URL"
      )
    ).rejects.toThrow(PROJECTOR_DATABASE_URL_DIRECT_MESSAGE);
  });

  it("poisons a timed-out probe and bounds the actual handle release", async () => {
    const probe = Promise.withResolvers<never>();
    let queryCount = 0;
    let endCount = 0;
    // SAFETY: this fake implements only the tagged query and bounded end
    // methods used by acquireAdvisoryLock; the probe remains half-open until
    // the test rejects it after teardown has been requested.
    const fakeSql = Object.assign(
      () => {
        queryCount += 1;
        return queryCount === 1
          ? Promise.resolve([{ locked: true }])
          : probe.promise;
      },
      {
        end: () => {
          endCount += 1;
          return Promise.resolve();
        },
      }
    ) as never;
    // SAFETY: the injected factory returns the tagged fake above and is used
    // only to exercise timeout teardown without opening a socket.
    const fakePostgres = (() => fakeSql) as never;
    const handle = await acquireAdvisoryLock(
      "postgresql://test@127.0.0.1:5432/test",
      900_000_099,
      "PROJECTOR_DATABASE_URL",
      fakePostgres
    );

    await expect(handle.reassert({ timeoutMs: 5 })).rejects.toThrow(
      "timed out"
    );
    expect(queryCount).toBe(2);
    await expect(handle.reassert({ timeoutMs: 5 })).rejects.toThrow(
      "timed out"
    );
    expect(queryCount).toBe(2);
    await handle.release();
    expect(endCount).toBe(1);
    probe.reject(new Error("closed after bounded teardown"));
  });

  it("refuses a second holder while the first holds the lock, then allows it after release", async () => {
    if (!postgresAvailable) {
      expect(postgresAvailable).toBe(false);
      return;
    }
    // Distinct per run so parallel spec files never collide on one key.
    const lockKey = 900_000_000 + Math.floor(Math.random() * 1_000_000);

    const first = await acquireAdvisoryLock(
      testDatabaseUrl,
      lockKey,
      "PROJECTOR_DATABASE_URL"
    );
    expect(first.acquired).toBe(true);

    const second = await acquireAdvisoryLock(
      testDatabaseUrl,
      lockKey,
      "PROJECTOR_DATABASE_URL"
    );
    expect(second.acquired).toBe(false);
    await second.release();

    await first.release();

    const third = await acquireAdvisoryLock(
      testDatabaseUrl,
      lockKey,
      "PROJECTOR_DATABASE_URL"
    );
    expect(third.acquired).toBe(true);
    await third.release();
  });

  it("reassert() reacquires after the lock connection is killed and the lock is free", async () => {
    if (!postgresAvailable) {
      expect(postgresAvailable).toBe(false);
      return;
    }
    const lockKey = 900_000_000 + Math.floor(Math.random() * 1_000_000);
    const admin = postgres(testDatabaseUrl, { max: 1 });

    try {
      const handle = await acquireAdvisoryLock(
        testDatabaseUrl,
        lockKey,
        "PROJECTOR_DATABASE_URL"
      );
      expect(handle.acquired).toBe(true);

      // Kill the lock's own backend from a second connection — simulates
      // an idle-connection reap (postgres.js idle_timeout, Neon
      // autosuspend) that drops the session and its advisory lock without
      // the projector ever seeing an error.
      const [victim] = await admin<{ pid: number }[]>`
        select pid from pg_locks
        where locktype = 'advisory' and objid = ${lockKey} and granted
      `;
      expect(victim?.pid).toBeDefined();
      await admin`select pg_terminate_backend(${victim?.pid ?? 0})`;

      // Nobody else took it — postgres.js reconnects transparently and
      // reassert() retakes the now-free lock.
      const reacquired = await handle.reassert();
      expect(reacquired).toBe(true);

      await handle.release();
    } finally {
      await admin.end({ timeout: 5 });
    }
  });

  it("reassert() returns false after the lock connection is killed and another session took it", async () => {
    if (!postgresAvailable) {
      expect(postgresAvailable).toBe(false);
      return;
    }
    const lockKey = 900_000_000 + Math.floor(Math.random() * 1_000_000);
    const admin = postgres(testDatabaseUrl, { max: 1 });
    const rival = postgres(testDatabaseUrl, { max: 1 });

    try {
      const handle = await acquireAdvisoryLock(
        testDatabaseUrl,
        lockKey,
        "PROJECTOR_DATABASE_URL"
      );
      expect(handle.acquired).toBe(true);

      const [victim] = await admin<{ pid: number }[]>`
        select pid from pg_locks
        where locktype = 'advisory' and objid = ${lockKey} and granted
      `;
      expect(victim?.pid).toBeDefined();
      await admin`select pg_terminate_backend(${victim?.pid ?? 0})`;

      // A rival session grabs the now-free lock before the original
      // handle's next heartbeat.
      const [rivalRow] = await rival<{ locked: boolean }[]>`
        select pg_try_advisory_lock(${lockKey}) as locked
      `;
      expect(rivalRow?.locked).toBe(true);

      const reacquired = await handle.reassert();
      expect(reacquired).toBe(false);

      await handle.release();
    } finally {
      await rival`select pg_advisory_unlock_all()`;
      await rival.end({ timeout: 5 });
      await admin.end({ timeout: 5 });
    }
  });
});

describe("waitForAdvisoryLock (rolling deploy handoff)", () => {
  let postgresAvailable = false;

  beforeAll(async () => {
    postgresAvailable = await isPostgresAvailable();
    if (!postgresAvailable && testDatabaseRequired) {
      throw new Error("Required test database is unavailable");
    }
  });

  it("acquires the lock once the first holder releases it", async () => {
    if (!postgresAvailable) {
      expect(postgresAvailable).toBe(false);
      return;
    }
    const lockKey = 900_000_000 + Math.floor(Math.random() * 1_000_000);
    const first = await acquireAdvisoryLock(
      testDatabaseUrl,
      lockKey,
      "PROJECTOR_DATABASE_URL"
    );
    expect(first.acquired).toBe(true);

    const controller = new AbortController();
    let waits = 0;
    const pending = waitForAdvisoryLock(testDatabaseUrl, lockKey, {
      databaseUrlVariable: "PROJECTOR_DATABASE_URL",
      onWaiting: () => {
        waits += 1;
        return Promise.resolve();
      },
      pollIntervalMs: 25,
      signal: controller.signal,
    });

    await Bun.sleep(150);
    await first.release();

    const second = await pending;
    expect(second?.acquired).toBe(true);
    expect(waits).toBeGreaterThanOrEqual(1);
    await second?.release();
  });

  it("invokes onWaiting while blocked and returns undefined when aborted before release", async () => {
    if (!postgresAvailable) {
      expect(postgresAvailable).toBe(false);
      return;
    }
    const lockKey = 900_000_000 + Math.floor(Math.random() * 1_000_000);
    const admin = postgres(testDatabaseUrl, { max: 1 });
    const first = await acquireAdvisoryLock(
      testDatabaseUrl,
      lockKey,
      "PROJECTOR_DATABASE_URL"
    );
    expect(first.acquired).toBe(true);

    try {
      const controller = new AbortController();
      let waits = 0;
      const pending = waitForAdvisoryLock(testDatabaseUrl, lockKey, {
        databaseUrlVariable: "PROJECTOR_DATABASE_URL",
        onWaiting: () => {
          waits += 1;
          return Promise.resolve();
        },
        pollIntervalMs: 25,
        signal: controller.signal,
      });

      await Bun.sleep(150);
      controller.abort();

      expect(await pending).toBeUndefined();
      expect(waits).toBeGreaterThanOrEqual(1);

      // The aborted waiter took nothing: the original holder is the only
      // session on the key.
      const [holders] = await admin<{ count: number }[]>`
        select count(*)::int as count from pg_locks
        where locktype = 'advisory' and objid = ${lockKey} and granted
      `;
      expect(holders?.count).toBe(1);
    } finally {
      await first.release();
      await admin.end({ timeout: 5 });
    }
  });
});
