import { describe, expect, it } from "bun:test";

import type { SearchVersion } from "../version";
import { SearchVersionPin } from "./version-pin";

const version = (appliedSequence: bigint, generation = 1): SearchVersion => ({
  appliedSequence,
  generation,
});

/** A durable store whose reads are counted and whose value a test moves. */
const fakeStore = (initial: SearchVersion) => {
  let current = initial;
  let reads = 0;
  let failNext = false;
  return {
    failNextRead: () => {
      failNext = true;
    },
    read: () => {
      reads += 1;
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error("postgres unavailable"));
      }
      return Promise.resolve(current);
    },
    reads: () => reads,
    set: (next: SearchVersion) => {
      current = next;
    },
  };
};

/** Lets a fire-and-forget background refresh settle. */
const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("SearchVersionPin", () => {
  it("waits on the store only for the very first version", async () => {
    let now = 0;
    const store = fakeStore(version(10n));
    const pin = new SearchVersionPin({
      now: () => now,
      read: store.read,
      refreshMs: 5000,
    });

    expect(await pin.current()).toEqual(version(10n));
    now = 1000;
    expect(await pin.current()).toEqual(version(10n));
    now = 4999;
    expect(await pin.current()).toEqual(version(10n));
    expect(store.reads()).toBe(1);
  });

  it("refreshes in the background once the refresh interval has passed", async () => {
    let now = 0;
    const store = fakeStore(version(10n));
    const pin = new SearchVersionPin({
      minPinMs: 0,
      now: () => now,
      read: store.read,
      refreshMs: 5000,
    });

    await pin.current();
    store.set(version(11n));
    now = 5000;
    // Served from memory while the refresh runs.
    expect(await pin.current()).toEqual(version(10n));
    await settle();
    expect(store.reads()).toBe(2);
    expect(await pin.current()).toEqual(version(11n));
  });

  it("re-pins a newer sequence only after the minimum pin age", async () => {
    let now = 0;
    const store = fakeStore(version(10n));
    const pin = new SearchVersionPin({
      minPinMs: 60_000,
      now: () => now,
      read: store.read,
      refreshMs: 1000,
    });

    await pin.current();
    for (let second = 1; second < 60; second += 1) {
      now = second * 1000;
      store.set(version(BigInt(10 + second)));
      // oxlint-disable-next-line no-await-in-loop -- each step depends on the previous refresh
      expect(await pin.current()).toEqual(version(10n));
      // oxlint-disable-next-line no-await-in-loop -- each step depends on the previous refresh
      await settle();
    }

    now = 60_000;
    expect(await pin.current()).toEqual(version(69n));
  });

  it("keeps the pin when the sequence is unchanged, however old it is", async () => {
    let now = 0;
    const store = fakeStore(version(10n));
    const pin = new SearchVersionPin({
      minPinMs: 60_000,
      now: () => now,
      read: store.read,
      refreshMs: 1000,
    });

    await pin.current();
    now = 10 * 60_000;
    await pin.current();
    await settle();
    expect(await pin.current()).toEqual(version(10n));
  });

  it("re-pins a new generation immediately", async () => {
    let now = 0;
    const store = fakeStore(version(500n, 1));
    const pin = new SearchVersionPin({
      minPinMs: 60_000,
      now: () => now,
      read: store.read,
      refreshMs: 1000,
    });

    await pin.current();
    store.set(version(0n, 2));
    now = 1000;
    await pin.current();
    await settle();
    expect(await pin.current()).toEqual(version(0n, 2));
  });

  it("keeps serving the last version when a background read fails", async () => {
    let now = 0;
    const store = fakeStore(version(10n));
    const pin = new SearchVersionPin({
      minPinMs: 0,
      now: () => now,
      read: store.read,
      refreshMs: 1000,
    });

    await pin.current();
    store.failNextRead();
    now = 1000;
    expect(await pin.current()).toEqual(version(10n));
    await settle();
    // Backs off a full interval before the next read.
    now = 1500;
    await pin.current();
    expect(store.reads()).toBe(2);
    store.set(version(12n));
    now = 2000;
    await pin.current();
    await settle();
    expect(await pin.current()).toEqual(version(12n));
  });

  it("surfaces a failed first read and retries on the next call", async () => {
    const store = fakeStore(version(10n));
    const pin = new SearchVersionPin({ read: store.read });

    store.failNextRead();
    await expect(pin.current()).rejects.toThrow("postgres unavailable");
    expect(await pin.current()).toEqual(version(10n));
  });

  it("shares one in-flight read between concurrent callers", async () => {
    const store = fakeStore(version(10n));
    const pin = new SearchVersionPin({ read: store.read });

    const results = await Promise.all([
      pin.current(),
      pin.current(),
      pin.current(),
    ]);
    expect(results).toEqual([version(10n), version(10n), version(10n)]);
    expect(store.reads()).toBe(1);
  });
});
