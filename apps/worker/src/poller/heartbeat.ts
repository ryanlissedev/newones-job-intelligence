/**
 * Poller binding for the shared process heartbeat (`@ji/db/process-heartbeat`).
 * Kept out of `main.ts` so the Dockerfile HEALTHCHECK does not boot the typed
 * env, the database client or the connector registry every 15 seconds.
 */
import {
  reportHeartbeatCheck,
  resolveHeartbeatFilePath,
} from "@ji/db/process-heartbeat";

export const DEFAULT_HEARTBEAT_FILE = "/tmp/poller-heartbeat";

/**
 * The poller's scoped liveness fiber refreshes the heartbeat independently of
 * source progress, so the file remains fresh while a connector or curation
 * pass is busy. 300 s leaves room for a stalled process to become unhealthy
 * while the separate lock probe and run-owned cancellation stop new work. The
 * projector keeps the 60 s default; its cycles are seconds long.
 */
export const MAX_POLLER_HEARTBEAT_AGE_MS = 300_000;

export const heartbeatFilePath = (): string =>
  resolveHeartbeatFilePath("POLLER_HEARTBEAT_FILE", DEFAULT_HEARTBEAT_FILE);

if (import.meta.main && process.argv.includes("--check")) {
  await reportHeartbeatCheck(heartbeatFilePath(), MAX_POLLER_HEARTBEAT_AGE_MS);
}
