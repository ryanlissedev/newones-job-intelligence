import { describe, expect, it } from "bun:test";

import type { SearchProjectorRuntimeRecord } from "@ji/db";
import { Hono } from "hono";

import { MAX_HEARTBEAT_AGE_MS } from "../projector/heartbeat";
import { createProjectorRuntimeHandler } from "./projector-runtime";

const RELEASE_SHA = "0123456789abcdef0123456789abcdef01234567";
const NOW_MS = Date.parse("2026-09-11T12:00:00.000Z");
const STARTED_AT = new Date("2026-09-11T11:00:00.000Z");

const runtimeRow = (heartbeatAt: Date): SearchProjectorRuntimeRecord => ({
  containerId: "container-abc123",
  cycle: 12,
  heartbeatAt,
  indexName: "aanvragen",
  releaseSha: RELEASE_SHA,
  startedAt: STARTED_AT,
  updatedAt: heartbeatAt,
});

const requestRuntime = async (
  deps: Parameters<typeof createProjectorRuntimeHandler>[0]
): Promise<Response> => {
  const app = new Hono();
  app.get("/projector/runtime", createProjectorRuntimeHandler(deps));
  return await app.request("http://server.test/projector/runtime");
};

describe("projector runtime route", () => {
  it("reports an active projector from a fresh row without caching", async () => {
    const heartbeatAt = new Date(NOW_MS - 1234);
    const response = await requestRuntime({
      now: () => NOW_MS,
      read: () => Promise.resolve(runtimeRow(heartbeatAt)),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      active: true,
      containerId: "container-abc123",
      cycle: 12,
      heartbeatAgeMs: 1234,
      heartbeatAt: heartbeatAt.toISOString(),
      heartbeatFresh: true,
      indexName: "aanvragen",
      releaseSha: RELEASE_SHA,
      startedAt: STARTED_AT.toISOString(),
    });
  });

  it("refuses to call a stale projector active", async () => {
    const heartbeatAt = new Date(NOW_MS - MAX_HEARTBEAT_AGE_MS - 1);
    const response = await requestRuntime({
      now: () => NOW_MS,
      read: () => Promise.resolve(runtimeRow(heartbeatAt)),
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      active: false,
      containerId: "container-abc123",
      cycle: 12,
      heartbeatAgeMs: MAX_HEARTBEAT_AGE_MS + 1,
      heartbeatAt: heartbeatAt.toISOString(),
      heartbeatFresh: false,
      indexName: "aanvragen",
      reason: "heartbeat_stale",
      releaseSha: RELEASE_SHA,
      startedAt: STARTED_AT.toISOString(),
    });
  });

  it("answers 503 when no projector has ever reported", async () => {
    const response = await requestRuntime({
      now: () => NOW_MS,
      read: () => Promise.resolve(null),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      active: false,
      containerId: null,
      cycle: null,
      heartbeatAgeMs: null,
      heartbeatAt: null,
      heartbeatFresh: false,
      reason: "runtime_missing",
      releaseSha: null,
      startedAt: null,
    });
  });

  it("answers 503 on a read failure without leaking the error text", async () => {
    // A driver failure would otherwise print the connection string verbatim.
    const secret = "postgres://ji:hunter2@db.example.internal:5432/ji";
    const response = await requestRuntime({
      now: () => NOW_MS,
      read: () => Promise.reject(new Error(`connect failed: ${secret}`)),
    });

    expect(response.status).toBe(503);
    const raw = await response.text();
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain("hunter2");
    expect(JSON.parse(raw)).toEqual({
      active: false,
      containerId: null,
      cycle: null,
      heartbeatAgeMs: null,
      heartbeatAt: null,
      heartbeatFresh: false,
      reason: "runtime_read_failed",
      releaseSha: null,
      startedAt: null,
    });
  });
});
