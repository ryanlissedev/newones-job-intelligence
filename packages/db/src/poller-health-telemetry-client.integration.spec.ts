import { expect, it } from "bun:test";

import postgres from "postgres";

import { createPollerHealthTelemetryClient } from "./poller-health-telemetry-client";

const databaseUrl =
  process.env.DATABASE_APP_TEST_URL ??
  "postgresql://ji_app:ji_app_local@127.0.0.1:5432/ji_test";

it("uses the dedicated PostgreSQL client to claim, report and stop a fenced runtime", async () => {
  const sql = postgres(databaseUrl, { connect_timeout: 2, max: 1 });
  try {
    await sql`SELECT 1`;
  } catch (error) {
    await sql.end({ timeout: 1 });
    if (
      process.env.REQUIRE_DATABASE_TESTS === "1" ||
      process.env.DATABASE_APP_TEST_URL !== undefined
    ) {
      throw error;
    }
    return;
  }
  const client = createPollerHealthTelemetryClient(databaseUrl);
  const ownerToken = crypto.randomUUID();
  try {
    const [lock] = await sql`SELECT pg_try_advisory_lock(613204877) AS held`;
    expect(lock?.held).toBe(true);
    const initial = new Date("2026-09-19T12:00:00Z");
    const claim = await client.store.claimRuntime({
      advisoryLockAcquired: true,
      advisoryLockMaxAgeMs: 300_000,
      curationBudgetMs: 120_000,
      heartbeatAt: initial,
      heartbeatMaxAgeMs: 300_000,
      instanceId: "dedicated-client-fixture",
      lastLockCheckAt: initial,
      ownerToken,
      releaseSha: null,
      runBudgetMs: 3_600_000,
      startedAt: initial,
    });
    const next = new Date(initial.getTime() + 10_000);
    expect(
      await client.store.heartbeat({
        at: next,
        fenceToken: claim.fenceToken,
        ownerToken,
      })
    ).toBe(true);
    const observed = await client.store.readRuntime();
    expect(observed?.heartbeatAt).toEqual(next);
    expect(observed?.lastLockCheckAt).toEqual(initial);
    expect(
      await client.store.stopRuntime({
        at: next,
        fenceToken: claim.fenceToken,
        ownerToken,
      })
    ).toBe(true);
    const stopped = await client.store.readRuntime();
    expect(stopped?.status).toBe("stopped");
  } finally {
    await client.close();
    await sql`DELETE FROM curated.poller_runtime WHERE owner_token = ${ownerToken}::uuid`;
    await sql`SELECT pg_advisory_unlock(613204877)`;
    await sql.end({ timeout: 1 });
  }
});
