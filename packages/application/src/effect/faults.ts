/* oxlint-disable eslint/max-classes-per-file, anti-slop/no-unknown-parameters -- Application use-case tagged fault union + unknown catch boundary (CTP-468 Slice 3). */
import { Data } from "effect";

/** Application use-case fault categories (Slice 3; no connector ReadIoFault coupling). */
export type UseCaseFaultCategory =
  | "validation"
  | "not_found"
  | "dependency"
  | "cancel";

export class UseCaseValidationFault extends Data.TaggedError("validation")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class UseCaseNotFoundFault extends Data.TaggedError("not_found")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class UseCaseDependencyFault extends Data.TaggedError("dependency")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class UseCaseCancelFault extends Data.TaggedError("cancel")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type UseCaseFault =
  | UseCaseValidationFault
  | UseCaseNotFoundFault
  | UseCaseDependencyFault
  | UseCaseCancelFault;

export const isUseCaseFault = (error: unknown): error is UseCaseFault =>
  error instanceof UseCaseValidationFault ||
  error instanceof UseCaseNotFoundFault ||
  error instanceof UseCaseDependencyFault ||
  error instanceof UseCaseCancelFault;

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

export const mapUnknownToUseCaseFault = (error: unknown): UseCaseFault => {
  if (isUseCaseFault(error)) {
    return error;
  }
  if (isAbortLike(error)) {
    return new UseCaseCancelFault({
      cause: error,
      message: "Operation cancelled",
    });
  }
  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (lower.includes("not found")) {
      return new UseCaseNotFoundFault({
        cause: error,
        message: error.message,
      });
    }
    if (
      lower.includes("not pollable") ||
      lower.includes("must be") ||
      lower.includes("validation")
    ) {
      return new UseCaseValidationFault({
        cause: error,
        message: error.message,
      });
    }
    return new UseCaseDependencyFault({
      cause: error,
      message: error.message,
    });
  }
  return new UseCaseDependencyFault({
    cause: error,
    message: "Unknown use-case failure",
  });
};
