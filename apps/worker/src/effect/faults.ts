/* oxlint-disable eslint/max-classes-per-file, anti-slop/no-unknown-parameters -- Worker task tagged fault union + unknown catch boundary (CTP-476 Slice 10). */
import { Data } from "effect";

/** Opt-in worker task-body fault categories (Slice 10; Trigger durability stays outside). */
export type WorkerFaultCategory =
  | "validation"
  | "not_found"
  | "dependency"
  | "unavailable"
  | "cancel";

export class WorkerValidationFault extends Data.TaggedError("validation")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class WorkerNotFoundFault extends Data.TaggedError("not_found")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class WorkerDependencyFault extends Data.TaggedError("dependency")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class WorkerUnavailableFault extends Data.TaggedError("unavailable")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class WorkerCancelFault extends Data.TaggedError("cancel")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type WorkerFault =
  | WorkerValidationFault
  | WorkerNotFoundFault
  | WorkerDependencyFault
  | WorkerUnavailableFault
  | WorkerCancelFault;

export const isWorkerFault = (error: unknown): error is WorkerFault =>
  error instanceof WorkerValidationFault ||
  error instanceof WorkerNotFoundFault ||
  error instanceof WorkerDependencyFault ||
  error instanceof WorkerUnavailableFault ||
  error instanceof WorkerCancelFault;

const ABORT_NAME = /abort/iu;

export const isAbortLike = (error: unknown): boolean => {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  if (error instanceof Error && ABORT_NAME.test(error.name)) {
    return true;
  }
  if (error instanceof Error && ABORT_NAME.test(error.message)) {
    return true;
  }
  return false;
};

export const mapUnknownToWorkerFault = (error: unknown): WorkerFault => {
  if (isWorkerFault(error)) {
    return error;
  }
  if (isAbortLike(error)) {
    return new WorkerCancelFault({
      cause: error,
      message: "Operation cancelled",
    });
  }
  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (lower.includes("not found")) {
      return new WorkerNotFoundFault({
        cause: error,
        message: error.message,
      });
    }
    if (
      lower.includes("invalid") ||
      lower.includes("must be") ||
      lower.includes("required") ||
      lower.includes("validation")
    ) {
      return new WorkerValidationFault({
        cause: error,
        message: error.message,
      });
    }
    if (
      lower.includes("unavailable") ||
      lower.includes("econnrefused") ||
      lower.includes("timeout")
    ) {
      return new WorkerUnavailableFault({
        cause: error,
        message: error.message,
      });
    }
    return new WorkerDependencyFault({
      cause: error,
      message: error.message,
    });
  }
  return new WorkerDependencyFault({
    cause: error,
    message: "Unknown worker task failure",
  });
};
