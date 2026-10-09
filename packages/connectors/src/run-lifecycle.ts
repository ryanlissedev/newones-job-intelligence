/* oxlint-disable max-classes-per-file -- public contract names distinguish run failure from ownership loss */
import type {
  CheckpointKey,
  ConnectorRunProgress,
  RunProgressStore,
} from "./checkpoint";
import type { RunCompletion, RunFailureKind } from "./run-outcomes";

export type ConnectorRunKind = "poll" | "test";

export type RunFailureEnvelope =
  | {
      phase: "discover";
      class: "connector";
      code: "DISCOVER_FAILED";
      message: "Connector discovery failed";
    }
  | {
      phase: "fetch";
      class: "connector";
      code: "FETCH_FAILED";
      message: "Connector fetch failed";
    }
  | {
      phase: "raw-store";
      class: "storage";
      code: "RAW_STORE_WRITE_FAILED";
      message: "Raw object persistence failed";
    }
  | {
      phase: "observation";
      class: "persistence";
      code: "OBSERVATION_WRITE_FAILED";
      message: "Observation persistence failed";
    }
  | {
      phase: "checkpoint";
      class: "persistence";
      code: "CHECKPOINT_WRITE_FAILED";
      message: "Run checkpoint persistence failed";
    }
  | {
      phase: "complete";
      class: "persistence";
      code: "COMPLETE_WRITE_FAILED";
      message: "Run completion persistence failed";
    }
  | {
      phase: "unknown";
      class: "internal";
      code: "UNEXPECTED_FAILURE";
      message: "Connector run failed";
    }
  | {
      phase: "unknown";
      class: "internal";
      code: "LEGACY_FAILURE";
      message: "Legacy run failed; details unavailable";
    };

// oxlint-disable-next-line unicorn/custom-error-definition -- architecture contract requires this exact public name
export class ConnectorRunFailure extends Error {
  readonly envelope: RunFailureEnvelope;

  constructor(envelope: RunFailureEnvelope, cause: unknown) {
    super(envelope.message, { cause });
    this.name = "ConnectorRunFailure";
    this.envelope = envelope;
  }
}

export class RunOwnershipLostError extends Error {
  readonly code = "RUN_OWNERSHIP_LOST";

  constructor() {
    super("Connector run ownership was lost");
    this.name = "RunOwnershipLostError";
  }
}

// oxlint-disable-next-line unicorn/custom-error-definition -- architecture contract requires this exact public name
export class RunAlreadyInProgressError extends Error {
  readonly code = "RUN_ALREADY_IN_PROGRESS";
  readonly bronId: string;

  constructor(bronId: string) {
    super(`A poll run is already in progress for bron ${bronId}`);
    this.name = "RunAlreadyInProgressError";
    this.bronId = bronId;
  }
}

export interface RunStartInput {
  key: CheckpointKey;
  mode: "reset" | "resume";
  progress: ConnectorRunProgress;
  runKind: ConnectorRunKind;
  startedAt: Date;
}

export interface RunStartResult {
  fenceToken: number;
  progress: ConnectorRunProgress;
  startedAt: Date;
}

export interface RunCompletionInput {
  /** How a succeeded run ended; absent on failure. */
  completion?: RunCompletion;
  fenceToken: number;
  finishedAt: Date;
  key: CheckpointKey;
  progress: ConnectorRunProgress;
}

export interface RunFailureInput extends RunCompletionInput {
  failure: RunFailureEnvelope;
  /** What kind of trouble failed the run; see `classifyRunFailure`. */
  failureKind?: RunFailureKind;
}

export interface RunLifecycleStore extends RunProgressStore {
  /** Creates a run or resumes the existing run identified by the same key. */
  start: (input: RunStartInput) => Promise<RunStartResult>;
  checkpoint: (
    key: CheckpointKey,
    progress: ConnectorRunProgress,
    fenceToken: number
  ) => Promise<void>;
  complete: (input: RunCompletionInput) => Promise<void>;
  fail: (input: RunFailureInput) => Promise<void>;
}

const runStorageKey = ({ bronId, scrapeRunId }: CheckpointKey): string =>
  `${bronId}\0${scrapeRunId}`;

export class InMemoryRunLifecycleStore implements RunLifecycleStore {
  private readonly progressByRun = new Map<string, ConnectorRunProgress>();
  private readonly fenceTokenByRun = new Map<string, number>();
  private readonly runKindByRun = new Map<string, ConnectorRunKind>();
  private readonly statusByRun = new Map<
    string,
    "failed" | "running" | "succeeded"
  >();
  private readonly startedAtByRun = new Map<string, Date>();
  readonly events: (
    | { type: "start"; input: RunStartInput }
    | {
        type: "checkpoint";
        key: CheckpointKey;
        progress: ConnectorRunProgress;
        fenceToken: number;
      }
    | { type: "complete"; input: RunCompletionInput }
    | { type: "fail"; input: RunFailureInput }
  )[] = [];

  load(key: CheckpointKey): Promise<ConnectorRunProgress | null> {
    return Promise.resolve(
      structuredClone(this.progressByRun.get(runStorageKey(key)) ?? null)
    );
  }

  start(input: RunStartInput): Promise<RunStartResult> {
    const storageKey = runStorageKey(input.key);
    const existingProgress = this.progressByRun.get(storageKey);
    const existingRunKind = this.runKindByRun.get(storageKey);
    const existingStatus = this.statusByRun.get(storageKey);
    if (existingStatus === "failed" || existingStatus === "succeeded") {
      return Promise.reject(new Error("Cannot reuse a terminal connector run"));
    }
    if (
      input.mode === "resume" &&
      existingRunKind !== undefined &&
      existingRunKind !== input.runKind
    ) {
      return Promise.reject(
        new Error("Cannot resume connector run with a different run kind")
      );
    }
    const progress =
      input.mode === "resume" && existingProgress
        ? existingProgress
        : input.progress;
    const startedAt =
      input.mode === "resume"
        ? (this.startedAtByRun.get(storageKey) ?? input.startedAt)
        : input.startedAt;
    this.progressByRun.set(storageKey, structuredClone(progress));
    const fenceToken = (this.fenceTokenByRun.get(storageKey) ?? 0) + 1;
    if (!Number.isSafeInteger(fenceToken)) {
      return Promise.reject(new Error("Connector run fence token exhausted"));
    }
    this.fenceTokenByRun.set(storageKey, fenceToken);
    this.runKindByRun.set(storageKey, input.runKind);
    this.statusByRun.set(storageKey, "running");
    this.startedAtByRun.set(storageKey, structuredClone(startedAt));
    this.events.push({ input: structuredClone(input), type: "start" });
    return Promise.resolve({
      fenceToken,
      progress: structuredClone(progress),
      startedAt: structuredClone(startedAt),
    });
  }

  checkpoint(
    key: CheckpointKey,
    progress: ConnectorRunProgress,
    fenceToken: number
  ): Promise<void> {
    if (this.fenceTokenByRun.get(runStorageKey(key)) !== fenceToken) {
      return Promise.reject(new RunOwnershipLostError());
    }
    this.progressByRun.set(runStorageKey(key), structuredClone(progress));
    this.events.push({
      fenceToken,
      key: structuredClone(key),
      progress: structuredClone(progress),
      type: "checkpoint",
    });
    return Promise.resolve();
  }

  complete(input: RunCompletionInput): Promise<void> {
    if (
      this.fenceTokenByRun.get(runStorageKey(input.key)) !== input.fenceToken
    ) {
      return Promise.reject(new RunOwnershipLostError());
    }
    this.progressByRun.set(
      runStorageKey(input.key),
      structuredClone(input.progress)
    );
    this.events.push({ input: structuredClone(input), type: "complete" });
    this.statusByRun.set(runStorageKey(input.key), "succeeded");
    return Promise.resolve();
  }

  fail(input: RunFailureInput): Promise<void> {
    if (
      this.fenceTokenByRun.get(runStorageKey(input.key)) !== input.fenceToken
    ) {
      return Promise.reject(new RunOwnershipLostError());
    }
    this.progressByRun.set(
      runStorageKey(input.key),
      structuredClone(input.progress)
    );
    this.events.push({ input: structuredClone(input), type: "fail" });
    this.statusByRun.set(runStorageKey(input.key), "failed");
    return Promise.resolve();
  }
}
