import { describe, expect, it } from "bun:test";

import { Singleflight } from "./singleflight";

describe("Singleflight (RJC-388)", () => {
  it("runs the task once for concurrent identical keys and shares the result", async () => {
    const singleflight = new Singleflight<number>();
    let calls = 0;

    const runOne = () =>
      singleflight.run("key", async () => {
        calls += 1;
        await Bun.sleep(1);
        return 42;
      });

    const first = runOne();
    const second = runOne();
    const third = runOne();

    expect(first.coalesced).toBe(false);
    expect(second.coalesced).toBe(true);
    expect(third.coalesced).toBe(true);

    const results = await Promise.all([
      first.promise,
      second.promise,
      third.promise,
    ]);

    expect(calls).toBe(1);
    expect(results).toEqual([42, 42, 42]);
  });

  it("removes the entry once settled, so the next call runs a fresh task", async () => {
    const singleflight = new Singleflight<number>();
    let calls = 0;
    const runOne = () =>
      singleflight.run("key", () => {
        calls += 1;
        return Promise.resolve(calls);
      });

    await runOne().promise;
    const second = runOne();
    expect(second.coalesced).toBe(false);
    await second.promise;

    expect(calls).toBe(2);
  });

  it("does not poison a later call after a failed flight settles", async () => {
    const singleflight = new Singleflight<number>();
    let calls = 0;
    const runOne = () =>
      singleflight.run("key", () => {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(new Error("engine unavailable"));
        }
        return Promise.resolve(7);
      });

    const first = runOne();
    await expect(first.promise).rejects.toThrow("engine unavailable");

    const second = runOne();
    expect(second.coalesced).toBe(false);
    await expect(second.promise).resolves.toBe(7);
    expect(calls).toBe(2);
  });

  it("shares a failure across concurrent callers of the same in-flight key", async () => {
    const singleflight = new Singleflight<number>();
    const runOne = () =>
      singleflight.run("key", () => Promise.reject(new Error("boom")));

    const first = runOne();
    const second = runOne();
    expect(second.coalesced).toBe(true);

    await expect(first.promise).rejects.toThrow("boom");
    await expect(second.promise).rejects.toThrow("boom");
  });
});
