/**
 * Liveness heartbeat for a long-running on-box process (RJC-391 follow-up).
 *
 * These processes have no HTTP surface, so Docker/Coolify cannot probe them.
 * Every loop cycle writes the current epoch millis to a file; the Dockerfile
 * HEALTHCHECK runs the owning module with `--check` and reports healthy while
 * the file is younger than `MAX_HEARTBEAT_AGE_MS`. A process stuck outside its
 * loop (lost lock, hung cycle, crash) stops refreshing the file and turns
 * unhealthy within one check interval plus the allowed age.
 */
import { stat, writeFile } from "node:fs/promises";

/**
 * Default allowed age. Fits the projector, whose poll interval is 1 s and
 * whose drain cycle of a 500 row batch takes well under a minute. A process
 * with longer cycles must pass its own `maxAgeMs` (see the poller).
 */
export const MAX_HEARTBEAT_AGE_MS = 60_000;

export const resolveHeartbeatFilePath = (
  variableName: string,
  fallbackPath: string
): string => process.env[variableName]?.trim() || fallbackPath;

export const writeHeartbeat = async (
  path: string,
  now: () => number = Date.now
): Promise<void> => {
  await writeFile(path, `${now()}\n`);
};

/** Age of the heartbeat in ms, or `null` when the file is missing/unreadable. */
export const heartbeatAgeMs = async (
  path: string,
  now: () => number = Date.now
): Promise<number | null> => {
  try {
    const { mtimeMs } = await stat(path);
    return Math.max(0, now() - mtimeMs);
  } catch {
    return null;
  }
};

export const isHeartbeatFresh = (
  ageMs: number | null,
  maxAgeMs: number = MAX_HEARTBEAT_AGE_MS
): boolean => ageMs !== null && ageMs <= maxAgeMs;

/** Body of every `--check` HEALTHCHECK entrypoint: prints one line, exits 0/1. */
export const reportHeartbeatCheck = async (
  path: string,
  maxAgeMs: number = MAX_HEARTBEAT_AGE_MS
): Promise<never> => {
  const age = await heartbeatAgeMs(path);
  const fresh = isHeartbeatFresh(age, maxAgeMs);
  process.stdout.write(`${JSON.stringify({ ageMs: age, fresh })}\n`);
  process.exit(fresh ? 0 : 1);
};
