import { describe, expect, it } from "bun:test";

import { createSlotLimit } from "./slots";

const tick = (): Promise<void> => Bun.sleep(0);

describe("createSlotLimit", () => {
  it("never lets more than `limit` calls run at once and starts waiters in order", async () => {
    const withSlot = createSlotLimit(2);
    let running = 0;
    let peak = 0;
    const started: number[] = [];
    const gates = Array.from({ length: 5 }, () =>
      Promise.withResolvers<null>()
    );
    const calls = gates.map((gate, index) =>
      withSlot(async () => {
        started.push(index);
        running += 1;
        peak = Math.max(peak, running);
        await gate.promise;
        running -= 1;
        return index;
      })
    );
    await tick();
    expect(started).toEqual([0, 1]);
    gates[1]?.resolve(null);
    await tick();
    expect(started).toEqual([0, 1, 2]);
    for (const gate of gates) {
      gate.resolve(null);
    }
    expect(await Promise.all(calls)).toEqual([0, 1, 2, 3, 4]);
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  it("frees the slot when work rejects", async () => {
    const withSlot = createSlotLimit(1);
    await expect(
      withSlot(() => Promise.reject(new Error("drain failed")))
    ).rejects.toThrow("drain failed");
    expect(await withSlot(() => Promise.resolve("next"))).toBe("next");
  });

  it("treats a limit below one as one", async () => {
    const withSlot = createSlotLimit(0);
    expect(await withSlot(() => Promise.resolve(1))).toBe(1);
  });
});
