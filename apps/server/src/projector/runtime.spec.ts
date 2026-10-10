import { describe, expect, it } from "bun:test";

import type {
  ProjectorRuntimeRecordInput,
  ProjectorRuntimeStore,
} from "./runtime";
import {
  createProjectorRuntimeRecorder,
  PROJECTOR_RUNTIME_WRITE_INTERVAL_MS,
} from "./runtime";

const RELEASE_SHA = "0123456789abcdef0123456789abcdef01234567";
const CONTAINER_ID = "container-abc123";
const STARTED_AT = new Date("2026-09-11T08:00:00.000Z");

class FakeStore implements ProjectorRuntimeStore {
  readonly writes: ProjectorRuntimeRecordInput[] = [];
  private failures = 0;

  failNext(count: number): void {
    this.failures = count;
  }

  record(input: ProjectorRuntimeRecordInput): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.reject(new Error("neon unreachable"));
    }
    this.writes.push(input);
    return Promise.resolve();
  }
}

const createHarness = (store: FakeStore, startMs = 1000) => {
  let clock = startMs;
  const errors: string[] = [];
  const recorder = createProjectorRuntimeRecorder({
    containerId: CONTAINER_ID,
    now: () => clock,
    onError: (message) => errors.push(message),
    releaseSha: RELEASE_SHA,
    startedAt: STARTED_AT,
    store,
  });
  return {
    advance: (ms: number) => {
      clock += ms;
    },
    errors,
    recorder,
  };
};

describe("projector runtime recorder", () => {
  it("writes the first cycle immediately with the process identity", async () => {
    const store = new FakeStore();
    const { recorder } = createHarness(store);

    await recorder.onCycle();

    expect(store.writes).toEqual([
      {
        containerId: CONTAINER_ID,
        cycle: 1,
        heartbeatAt: new Date(1000),
        releaseSha: RELEASE_SHA,
        startedAt: STARTED_AT,
      },
    ]);
    expect(recorder.cycleCount()).toBe(1);
  });

  it("does not write again while inside the throttle interval", async () => {
    const store = new FakeStore();
    const { advance, recorder } = createHarness(store);

    await recorder.onCycle();
    for (let cycle = 0; cycle < 3; cycle += 1) {
      advance(1000);
      // oxlint-disable-next-line no-await-in-loop -- cycles are sequential by construction
      await recorder.onCycle();
    }

    expect(store.writes).toHaveLength(1);
    expect(recorder.cycleCount()).toBe(4);
  });

  it("writes the current cycle count once the interval has elapsed", async () => {
    const store = new FakeStore();
    const { advance, recorder } = createHarness(store);

    await recorder.onCycle();
    advance(1000);
    await recorder.onCycle();
    advance(1000);
    await recorder.onCycle();
    advance(PROJECTOR_RUNTIME_WRITE_INTERVAL_MS);
    await recorder.onCycle();

    expect(store.writes).toHaveLength(2);
    expect(store.writes[1]).toEqual({
      containerId: CONTAINER_ID,
      cycle: 4,
      heartbeatAt: new Date(1000 + 2000 + PROJECTOR_RUNTIME_WRITE_INTERVAL_MS),
      releaseSha: RELEASE_SHA,
      startedAt: STARTED_AT,
    });
  });

  it("reports a store failure without throwing and retries on the next cycle", async () => {
    const store = new FakeStore();
    store.failNext(1);
    const { advance, errors, recorder } = createHarness(store);

    await recorder.onCycle();

    expect(errors).toEqual(["neon unreachable"]);
    expect(store.writes).toHaveLength(0);

    // A failed write must not start the throttle, so the very next cycle
    // retries rather than waiting out another full interval.
    advance(1000);
    await recorder.onCycle();

    expect(store.writes).toEqual([
      {
        containerId: CONTAINER_ID,
        cycle: 2,
        heartbeatAt: new Date(2000),
        releaseSha: RELEASE_SHA,
        startedAt: STARTED_AT,
      },
    ]);
    expect(recorder.cycleCount()).toBe(2);
  });
});
