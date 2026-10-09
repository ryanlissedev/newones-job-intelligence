import { describe, expect, it } from "bun:test";

import migrationJournal from "./migrations/meta/_journal.json";
import {
  evaluateDbReadiness,
  resolveExpectedMigrationTimestamp,
} from "./readiness";

const expectedMigrationTimestamp = "1790640000000";

describe("database readiness", () => {
  it("derives the current expected migration from the latest journal entry", () => {
    expect(migrationJournal.entries.at(-1)).toMatchObject({
      idx: 32,
      tag: "0032_source_fetch_history",
      when: Number(expectedMigrationTimestamp),
    });
    expect(resolveExpectedMigrationTimestamp(migrationJournal)).toBe(
      expectedMigrationTimestamp
    );
  });

  it("selects the newest migration timestamp", () => {
    expect(
      resolveExpectedMigrationTimestamp({
        entries: [{ when: 1 }, { when: 2 }],
      })
    ).toBe("2");
  });

  it("rejects an empty migration journal", () => {
    expect(() => resolveExpectedMigrationTimestamp({ entries: [] })).toThrow(
      "Migration journal must contain at least one entry"
    );
  });

  it("is ready when the latest migration matches", async () => {
    const result = await evaluateDbReadiness(expectedMigrationTimestamp, () =>
      Promise.resolve(expectedMigrationTimestamp)
    );

    expect(result).toEqual({ ready: true });
  });

  it("identifies a missing or stale migration", async () => {
    const result = await evaluateDbReadiness(expectedMigrationTimestamp, () =>
      Promise.resolve(null)
    );

    expect(result).toEqual({ ready: false, reason: "migration_mismatch" });
  });

  it("identifies query, connectivity, and privilege errors", async () => {
    const result = await evaluateDbReadiness(expectedMigrationTimestamp, () =>
      Promise.reject(new Error("sensitive database detail"))
    );

    expect(result).toEqual({ ready: false, reason: "database_error" });
  });
});
