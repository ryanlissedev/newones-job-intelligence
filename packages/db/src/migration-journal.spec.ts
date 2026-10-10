import { describe, expect, it } from "bun:test";

import journal from "./migrations/meta/_journal.json";

/**
 * `/readyz` compares the newest `created_at` in `drizzle.__drizzle_migrations`
 * with the journal's last `when`. Drizzle stores `when` as `created_at`, so
 * a new entry whose `when` is smaller than its predecessor is applied fine
 * yet reports `migration_mismatch` forever (found live on 2026-09-11 when a
 * generated entry carried a wall-clock `when` below the hand-aligned 0022).
 */
describe("migration journal", () => {
  it("numbers entries consecutively from zero", () => {
    expect(journal.entries.map((entry) => entry.idx)).toEqual(
      journal.entries.map((_, index) => index)
    );
  });

  it("keeps every when strictly greater than its predecessor", () => {
    const regressions = journal.entries.filter(
      (entry, index) =>
        index > 0 && entry.when <= (journal.entries[index - 1]?.when ?? 0)
    );
    expect(regressions.map((entry) => entry.tag)).toEqual([]);
  });

  it("tags every entry with its zero-padded index", () => {
    for (const entry of journal.entries) {
      expect(
        entry.tag.startsWith(`${String(entry.idx).padStart(4, "0")}_`)
      ).toBe(true);
    }
  });
});
