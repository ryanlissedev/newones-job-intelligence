/**
 * Restore-drill integration spec (CTP-632): runs the full drill — provision,
 * ingest, pg_dump, outage, restore, retake, replay — against disposable
 * `ji_restore_drill_*` databases on the local Postgres. Skips when Postgres
 * is unavailable unless REQUIRE_DATABASE_TESTS=1 / DATABASE_TEST_URL is set,
 * matching the repo's integration-spec convention.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import postgres from "postgres";

import { resolveDumpRunner, runDrill } from "./restore-drill";

const adminUrl = `postgresql://${process.env.POSTGRES_ADMIN_USER ?? "ji_admin"}:${
  process.env.POSTGRES_ADMIN_PASSWORD ?? "ji_admin_local"
}@127.0.0.1:${process.env.POSTGRES_HOST_PORT ?? "5432"}/postgres`;

const databaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;

const isPostgresAvailable = async (): Promise<boolean> => {
  const probe = postgres(adminUrl, { connect_timeout: 2, max: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
    return true;
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return false;
  }
};

const databaseExists = async (name: string): Promise<boolean> => {
  const admin = postgres(adminUrl, { connect_timeout: 2, max: 1 });
  try {
    const rows = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_database WHERE datname = ${name}
    `;
    return (rows[0]?.n ?? 0) > 0;
  } finally {
    await admin.end({ timeout: 1 });
  }
};

describe("restore-drill end to end (CTP-632)", () => {
  let available = false;

  beforeAll(async () => {
    available = await isPostgresAvailable();
    if (!(available || databaseRequired)) {
      return;
    }
    if (!available) {
      throw new Error("Required test database is unavailable");
    }
    if (
      !(await resolveDumpRunner({
        adminPassword: process.env.POSTGRES_ADMIN_PASSWORD ?? "ji_admin_local",
        adminUser: process.env.POSTGRES_ADMIN_USER ?? "ji_admin",
        appPassword: process.env.POSTGRES_APP_PASSWORD ?? "ji_app_local",
        appUser: process.env.POSTGRES_APP_USER ?? "ji_app",
        hostPort: Number(process.env.POSTGRES_HOST_PORT ?? "5432"),
        migratorPassword:
          process.env.POSTGRES_MIGRATOR_PASSWORD ?? "ji_migrator_local",
        migratorUser: process.env.POSTGRES_MIGRATOR_USER ?? "ji_migrator",
      }))
    ) {
      throw new Error(
        "No pg_dump available (host PATH or Postgres container); cannot prove a backup happened"
      );
    }
  });

  it("reconstructs the ingest chain after database loss and emits a passing receipt", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    const outputDir = mkdtempSync(path.join(os.tmpdir(), "ji-drill-spec-"));
    try {
      const outcome = await runDrill({
        keepDatabases: false,
        outputPath: path.join(outputDir, "receipt.json"),
      });
      const { receipt } = outcome;

      if (receipt.result !== "pass") {
        console.error(
          JSON.stringify({
            cleanup: receipt.cleanup,
            result: receipt.result,
            steps: receipt.steps,
          })
        );
      }
      expect(receipt.result).toBe("pass");
      expect(receipt.gitSha).toMatch(/^[0-9a-f]{40}$/u);
      expect(receipt.backup?.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(receipt.backup?.bytes).toBeGreaterThan(0);
      expect(receipt.rpo.exposureWindowMs).toBeGreaterThanOrEqual(0);
      expect(receipt.rto.measuredMs).toBeGreaterThanOrEqual(0);
      expect(receipt.lostWrites.length).toBeGreaterThan(0);
      expect(
        receipt.verifications.every(
          (verification) => verification.status === "verified"
        )
      ).toBe(true);
      // Honest boundary: the projector/Manticore is not exercised.
      expect(receipt.searchProjection.status).toBe("unknown");
      expect(receipt.steps.every((step) => step.status === "ok")).toBe(true);
      expect(receipt.cleanup.sourceDropped).toBe(true);
      expect(receipt.cleanup.targetDropped).toBe(true);
      expect(await databaseExists(outcome.sourceDatabase)).toBe(false);
      expect(await databaseExists(outcome.targetDatabase)).toBe(false);
    } finally {
      rmSync(outputDir, { force: true, recursive: true });
    }
  }, 60_000);
});
