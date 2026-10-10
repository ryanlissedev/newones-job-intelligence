import { describe, expect, it } from "bun:test";

import {
  isHeartbeatFresh,
  MAX_HEARTBEAT_AGE_MS,
} from "@ji/db/process-heartbeat";

import { MAX_POLLER_HEARTBEAT_AGE_MS } from "./heartbeat";

describe("poller heartbeat age", () => {
  it("tolerates a gap the projector default would call stale", () => {
    const oneSourceStep = MAX_HEARTBEAT_AGE_MS + 5000;
    expect(isHeartbeatFresh(oneSourceStep)).toBe(false);
    expect(isHeartbeatFresh(oneSourceStep, MAX_POLLER_HEARTBEAT_AGE_MS)).toBe(
      true
    );
  });

  it("still reports stale past the poller's own allowance", () => {
    expect(
      isHeartbeatFresh(
        MAX_POLLER_HEARTBEAT_AGE_MS + 1,
        MAX_POLLER_HEARTBEAT_AGE_MS
      )
    ).toBe(false);
    expect(isHeartbeatFresh(null, MAX_POLLER_HEARTBEAT_AGE_MS)).toBe(false);
  });
});
