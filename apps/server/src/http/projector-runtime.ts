import type { SearchProjectorRuntimeRecord } from "@ji/db";
import type { Context } from "hono";

import { MAX_HEARTBEAT_AGE_MS } from "../projector/heartbeat";

type UnavailableReason =
  | "heartbeat_stale"
  | "runtime_missing"
  | "runtime_read_failed";

interface ProjectorRuntimeBody {
  readonly active: boolean;
  readonly containerId: string | null;
  readonly cycle: number | null;
  readonly heartbeatAgeMs: number | null;
  readonly heartbeatFresh: boolean;
  readonly heartbeatAt: string | null;
  readonly indexName?: string;
  readonly reason?: UnavailableReason;
  readonly releaseSha: string | null;
  readonly startedAt: string | null;
}

export interface ProjectorRuntimeHandlerDeps {
  maxHeartbeatAgeMs?: number;
  now?: () => number;
  read: () => Promise<SearchProjectorRuntimeRecord | null>;
}

const noStoreJson = (body: ProjectorRuntimeBody, status: number): Response =>
  Response.json(body, {
    headers: { "Cache-Control": "no-store" },
    status,
  });

const unavailable = (reason: UnavailableReason): ProjectorRuntimeBody => ({
  active: false,
  containerId: null,
  cycle: null,
  heartbeatAgeMs: null,
  heartbeatAt: null,
  heartbeatFresh: false,
  reason,
  releaseSha: null,
  startedAt: null,
});

/**
 * Deploy readback for the on-box projector. The projector has no HTTP surface
 * of its own, so it publishes its identity to `curated.search_projector_runtime`
 * and the API serves that row here.
 *
 * Fail closed: anything other than a present, fresh row answers 503 in the
 * same shape, so a deploy driver that only checks the status code can never
 * mistake a missing or stale projector for a live one.
 */
export const createProjectorRuntimeHandler = (
  deps: ProjectorRuntimeHandlerDeps
) => {
  const maxHeartbeatAgeMs = deps.maxHeartbeatAgeMs ?? MAX_HEARTBEAT_AGE_MS;
  const now = deps.now ?? Date.now;

  return async (_context: Context): Promise<Response> => {
    let row: SearchProjectorRuntimeRecord | null;
    try {
      row = await deps.read();
    } catch {
      // The error text can carry a connection string; never echo it.
      return noStoreJson(unavailable("runtime_read_failed"), 503);
    }

    if (!row) {
      return noStoreJson(unavailable("runtime_missing"), 503);
    }

    const heartbeatAgeMs = Math.max(0, now() - row.heartbeatAt.getTime());
    const heartbeatFresh = heartbeatAgeMs <= maxHeartbeatAgeMs;
    const body: ProjectorRuntimeBody = {
      active: heartbeatFresh,
      containerId: row.containerId,
      cycle: row.cycle,
      heartbeatAgeMs,
      heartbeatAt: row.heartbeatAt.toISOString(),
      heartbeatFresh,
      indexName: row.indexName,
      releaseSha: row.releaseSha,
      startedAt: row.startedAt.toISOString(),
    };

    if (!heartbeatFresh) {
      return noStoreJson({ ...body, reason: "heartbeat_stale" }, 503);
    }
    return noStoreJson(body, 200);
  };
};
