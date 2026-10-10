import { describe, expect, it } from "bun:test";

import { resolveLifecycleStatus } from "./lifecycle";

describe("resolveLifecycleStatus", () => {
  it("marks aanvragen active when seen open", () => {
    expect(
      resolveLifecycleStatus({
        bronSaysClosed: false,
        current: "unknown",
        missedPolls: 0,
        seenOpen: true,
        sluitingsdatumPassed: false,
      })
    ).toBe("active");
  });

  it("marks aanvragen closed when the bron reports closed", () => {
    expect(
      resolveLifecycleStatus({
        bronSaysClosed: true,
        current: "active",
        missedPolls: 0,
        seenOpen: true,
        sluitingsdatumPassed: false,
      })
    ).toBe("closed");
  });

  it("marks aanvragen stale after N missed polls", () => {
    expect(
      resolveLifecycleStatus({
        bronSaysClosed: false,
        current: "active",
        missedPolls: 3,
        missedPollsBeforeStale: 3,
        seenOpen: false,
        sluitingsdatumPassed: false,
      })
    ).toBe("stale");
  });

  it("reactivates stale aanvragen when seen again", () => {
    expect(
      resolveLifecycleStatus({
        bronSaysClosed: false,
        current: "stale",
        missedPolls: 0,
        seenOpen: true,
        sluitingsdatumPassed: false,
      })
    ).toBe("active");
  });
});
