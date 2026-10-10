import { describe, expect, it } from "bun:test";

import { InMemoryCurateStore } from "../identity/store";
import {
  createInMemoryLifecyclePorts,
  InMemoryMissedPollsStore,
  reconcileMissedPolls,
  runReconcileMissedPolls,
} from "./index";

describe("lifecycle Effect dual-path", () => {
  it("reconcileMissedPollsEffect matches native on incomplete run", async () => {
    const curateStore = new InMemoryCurateStore();
    const missedPolls = new InMemoryMissedPollsStore();
    const ports = createInMemoryLifecyclePorts(curateStore, missedPolls);
    const input = {
      bronId: "bron-life-1",
      completeness: { complete: false as const, reason: "empty" as const },
      observedAt: new Date("2026-09-01T10:00:00.000Z"),
      observedBronReferenties: [] as const,
      scrapeRunId: "run-life-1",
    };
    const native = await reconcileMissedPolls(ports, input);
    const viaEffect = await runReconcileMissedPolls(ports, input);
    expect(viaEffect).toEqual(native);
    expect(viaEffect.skippedIncrementReason).toBe("empty");
  });
});
