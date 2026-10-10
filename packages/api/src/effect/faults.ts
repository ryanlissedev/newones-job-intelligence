/* oxlint-disable eslint/max-classes-per-file, anti-slop/no-unknown-parameters -- tRPC/API tagged fault union + unknown catch boundary (CTP-474 Slice 9). */
import { Data } from "effect";

/** Opt-in @ji/api tRPC fault categories (Slice 9; no server coupling). */
export type ApiFaultCategory =
  | "unauthenticated"
  | "forbidden"
  | "validation"
  | "not_found"
  | "dependency"
  | "cancel";

export class ApiUnauthenticatedFault extends Data.TaggedError(
  "unauthenticated"
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ApiForbiddenFault extends Data.TaggedError("forbidden")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ApiValidationFault extends Data.TaggedError("validation")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ApiNotFoundFault extends Data.TaggedError("not_found")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ApiDependencyFault extends Data.TaggedError("dependency")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ApiCancelFault extends Data.TaggedError("cancel")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type ApiFault =
  | ApiUnauthenticatedFault
  | ApiForbiddenFault
  | ApiValidationFault
  | ApiNotFoundFault
  | ApiDependencyFault
  | ApiCancelFault;

export const isApiFault = (error: unknown): error is ApiFault =>
  error instanceof ApiUnauthenticatedFault ||
  error instanceof ApiForbiddenFault ||
  error instanceof ApiValidationFault ||
  error instanceof ApiNotFoundFault ||
  error instanceof ApiDependencyFault ||
  error instanceof ApiCancelFault;

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

export const mapUnknownToApiFault = (error: unknown): ApiFault => {
  if (isApiFault(error)) {
    return error;
  }
  if (isAbortLike(error)) {
    return new ApiCancelFault({
      cause: error,
      message: "Operation cancelled",
    });
  }
  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (lower.includes("not found")) {
      return new ApiNotFoundFault({ cause: error, message: error.message });
    }
    if (
      lower.includes("unauthenticated") ||
      lower.includes("authentication required") ||
      lower.includes("no session")
    ) {
      return new ApiUnauthenticatedFault({
        cause: error,
        message: error.message,
      });
    }
    if (lower.includes("forbidden") || lower.includes("not allowed")) {
      return new ApiForbiddenFault({ cause: error, message: error.message });
    }
    if (
      lower.includes("invalid") ||
      lower.includes("must be") ||
      lower.includes("validation")
    ) {
      return new ApiValidationFault({ cause: error, message: error.message });
    }
    return new ApiDependencyFault({ cause: error, message: error.message });
  }
  return new ApiDependencyFault({
    cause: error,
    message: "Unknown API failure",
  });
};
