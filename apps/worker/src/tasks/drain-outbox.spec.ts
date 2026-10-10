import { describe, expect, it } from "bun:test";

// @ji/db validates DATABASE_URL at module import. The onbox guard below then
// proves the task runner does not read it or attempt a connection at runtime.
process.env.DATABASE_URL ??= "postgresql://user:pass@127.0.0.1:1/unused";

const { ONBOX_DRAIN_DEFERRAL_REASON, runDrainOutbox } =
  await import("./drain-outbox");

describe.serial("drain-outbox task projector ownership", () => {
  it("explicitly defers without database or Manticore access in onbox mode", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousManticoreUrl = process.env.MANTICORE_URL;
    const previousSearchProjector = process.env.SEARCH_PROJECTOR;

    delete process.env.DATABASE_URL;
    delete process.env.MANTICORE_URL;
    process.env.SEARCH_PROJECTOR = "onbox";

    try {
      await expect(runDrainOutbox({})).resolves.toEqual({
        deferred: true,
        reason: ONBOX_DRAIN_DEFERRAL_REASON,
        searchProjector: "onbox",
      });
    } finally {
      if (previousDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previousDatabaseUrl;
      }
      if (previousManticoreUrl === undefined) {
        delete process.env.MANTICORE_URL;
      } else {
        process.env.MANTICORE_URL = previousManticoreUrl;
      }
      if (previousSearchProjector === undefined) {
        delete process.env.SEARCH_PROJECTOR;
      } else {
        process.env.SEARCH_PROJECTOR = previousSearchProjector;
      }
    }
  });
});
