import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  heartbeatAgeMs,
  isHeartbeatFresh,
  MAX_HEARTBEAT_AGE_MS,
  writeHeartbeat,
} from "./heartbeat";

describe("projector heartbeat", () => {
  it("is fresh right after a write and stale once the allowed age passes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "projector-heartbeat-"));
    const file = path.join(dir, "heartbeat");
    let clock = 1_700_000_000_000;
    await writeHeartbeat(file, () => clock);
    const justWritten = await heartbeatAgeMs(file);
    expect(justWritten).not.toBeNull();
    expect(isHeartbeatFresh(justWritten)).toBe(true);

    clock = Date.now() + MAX_HEARTBEAT_AGE_MS + 5000;
    const later = await heartbeatAgeMs(file, () => clock);
    expect(isHeartbeatFresh(later)).toBe(false);
  });

  it("treats a missing file as stale", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "projector-heartbeat-"));
    expect(await heartbeatAgeMs(path.join(dir, "absent"))).toBeNull();
    expect(isHeartbeatFresh(null)).toBe(false);
  });
});
