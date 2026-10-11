import type { SearchExpirySweepMode, SearchExpirySweepResult } from "@ji/db";

export interface SearchExpirySweepConfig {
  batchSize: number;
  intervalMs: number;
  maxPerRun: number;
  mode: "off" | SearchExpirySweepMode;
}

export interface SearchExpirySweepRunnerOptions {
  config: SearchExpirySweepConfig;
  log: (fields: SearchExpirySweepLog) => void;
  sweep: (input: {
    batchSize: number;
    maxPerRun: number;
    mode: SearchExpirySweepMode;
  }) => Promise<SearchExpirySweepResult>;
}

export interface SearchExpirySweepLog {
  batches: number;
  candidates: number;
  capped: boolean;
  durationMs: number;
  enqueued: number;
  errorName?: string;
  message?: string;
  mode: SearchExpirySweepMode;
  skippedPending: number;
}

export interface SearchExpirySweepRunner {
  start: () => void;
  stop: () => Promise<void>;
}

const parseInteger = (
  value: string,
  name: string,
  maximum = Number.MAX_SAFE_INTEGER
): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer from 1 through ${maximum}`);
  }
  return parsed;
};

const redactConnectionStrings = (message: string): string =>
  message.replaceAll(
    /\b(?:postgres(?:ql)?|redis|mysql|mariadb):\/\/[^\s"'`]+/giu,
    "[REDACTED_CONNECTION_STRING]"
  );

export const parseSearchExpirySweepConfig = (
  env: Record<string, string | undefined>
): SearchExpirySweepConfig => {
  const mode = env.SEARCH_EXPIRY_SWEEP_MODE ?? "off";
  if (mode !== "off" && mode !== "dry-run" && mode !== "apply") {
    throw new Error("SEARCH_EXPIRY_SWEEP_MODE must be off, dry-run, or apply");
  }
  const intervalMs = parseInteger(
    env.SEARCH_EXPIRY_SWEEP_INTERVAL_MS ?? "900000",
    "SEARCH_EXPIRY_SWEEP_INTERVAL_MS",
    2_147_483_647
  );
  if (intervalMs < 60_000) {
    throw new Error("SEARCH_EXPIRY_SWEEP_INTERVAL_MS must be at least 60000");
  }
  return {
    batchSize: parseInteger(
      env.SEARCH_EXPIRY_SWEEP_BATCH_SIZE ?? "200",
      "SEARCH_EXPIRY_SWEEP_BATCH_SIZE",
      1000
    ),
    intervalMs,
    maxPerRun: parseInteger(
      env.SEARCH_EXPIRY_SWEEP_MAX_PER_RUN ?? "2000",
      "SEARCH_EXPIRY_SWEEP_MAX_PER_RUN",
      10_000
    ),
    mode,
  };
};

export const createSearchExpirySweepRunner = (
  options: SearchExpirySweepRunnerOptions
): SearchExpirySweepRunner => {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  let inFlight: Promise<void> | undefined;

  const run = async (): Promise<void> => {
    if (running || options.config.mode === "off") {
      return;
    }
    running = true;
    const startedAt = Date.now();
    try {
      const result = await options.sweep({
        batchSize: options.config.batchSize,
        maxPerRun: options.config.maxPerRun,
        mode: options.config.mode,
      });
      options.log({
        batches: result.batches,
        candidates: result.candidates,
        capped: result.capped,
        durationMs: Date.now() - startedAt,
        enqueued: result.enqueued,
        mode: options.config.mode,
        skippedPending: result.skippedPending,
      });
    } catch (error) {
      const rawMessage = redactConnectionStrings(
        error instanceof Error ? error.message : String(error)
      );
      options.log({
        batches: 0,
        candidates: 0,
        capped: false,
        durationMs: Date.now() - startedAt,
        enqueued: 0,
        errorName: error instanceof Error ? error.name : "UnknownError",
        message: rawMessage.slice(0, 300),
        mode: options.config.mode,
        skippedPending: 0,
      });
    } finally {
      running = false;
    }
  };

  return {
    start: () => {
      if (options.config.mode === "off" || timer !== undefined) {
        return;
      }
      timer = setInterval(() => {
        if (!running) {
          inFlight = run();
        }
      }, options.config.intervalMs);
      timer.unref?.();
    },
    stop: async () => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      await inFlight;
    },
  };
};
