/**
 * Projector binding for the shared process heartbeat (`@ji/db/process-heartbeat`).
 * The Dockerfile HEALTHCHECK and docker-compose.mcp-edge-smoke.yml both run
 * this path with `--check`, so the entrypoint stays here while the
 * implementation lives in the package the poller shares.
 */
import {
  reportHeartbeatCheck,
  resolveHeartbeatFilePath,
} from "@ji/db/process-heartbeat";

export {
  heartbeatAgeMs,
  isHeartbeatFresh,
  MAX_HEARTBEAT_AGE_MS,
  writeHeartbeat,
} from "@ji/db/process-heartbeat";

export const DEFAULT_HEARTBEAT_FILE = "/tmp/projector-heartbeat";

export const heartbeatFilePath = (): string =>
  resolveHeartbeatFilePath("PROJECTOR_HEARTBEAT_FILE", DEFAULT_HEARTBEAT_FILE);

if (import.meta.main && process.argv.includes("--check")) {
  await reportHeartbeatCheck(heartbeatFilePath());
}
