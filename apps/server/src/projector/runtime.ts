/**
 * Publishes the running projector's identity so a deploy can read back which
 * container and release SHA is actually draining the index (the projector has
 * no HTTP surface; the API server serves the row at `/projector/runtime`).
 *
 * Pure: the caller supplies the store, the clock and the error sink.
 */

export interface ProjectorRuntimeRecordInput {
  containerId: string;
  cycle: number;
  heartbeatAt: Date;
  releaseSha: string | null;
  startedAt: Date;
}

export interface ProjectorRuntimeStore {
  record: (input: ProjectorRuntimeRecordInput) => Promise<void>;
}

/**
 * An idle projector polls once a second. Writing the row every cycle would
 * be a network round-trip and a WAL record per second against Neon, for a
 * row whose only moving part is a heartbeat that is allowed to be a minute
 * stale, so writes are throttled to this interval.
 */
export const PROJECTOR_RUNTIME_WRITE_INTERVAL_MS = 15_000;

export interface ProjectorRuntimeRecorderOptions {
  containerId: string;
  minIntervalMs?: number;
  now?: () => number;
  onError: (message: string) => void;
  releaseSha: string | null;
  startedAt: Date;
  store: ProjectorRuntimeStore;
}

export interface ProjectorRuntimeRecorder {
  cycleCount: () => number;
  onCycle: () => Promise<void>;
}

export const createProjectorRuntimeRecorder = (
  options: ProjectorRuntimeRecorderOptions
): ProjectorRuntimeRecorder => {
  const {
    containerId,
    minIntervalMs = PROJECTOR_RUNTIME_WRITE_INTERVAL_MS,
    now = Date.now,
    onError,
    releaseSha,
    startedAt,
    store,
  } = options;

  let cycles = 0;
  let lastWriteAt: number | null = null;

  const onCycle = async (): Promise<void> => {
    cycles += 1;
    const at = now();
    if (lastWriteAt !== null && at - lastWriteAt < minIntervalMs) {
      return;
    }

    try {
      await store.record({
        containerId,
        cycle: cycles,
        heartbeatAt: new Date(at),
        releaseSha,
        startedAt,
      });
      // Only a successful write advances the throttle, so a failed write is
      // retried on the next cycle rather than waiting out another interval.
      lastWriteAt = at;
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  };

  return { cycleCount: () => cycles, onCycle };
};
