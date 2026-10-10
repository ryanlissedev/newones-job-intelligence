/* oxlint-disable eslint/max-classes-per-file, anti-slop/no-unknown-parameters -- Transport tagged fault union + unknown catch boundary (CTP-474 Slice 9). */
import { Data } from "effect";

/**
 * Opt-in server/API transport fault categories (Slice 9).
 * Kept local to apps/server; ADR-0012 auth resolvers stay untouched.
 */
export type TransportFaultCategory =
  | "unauthenticated"
  | "forbidden"
  | "validation"
  | "not_found"
  | "unavailable"
  | "dependency"
  | "cancel";

export class TransportUnauthenticatedFault extends Data.TaggedError(
  "unauthenticated"
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class TransportForbiddenFault extends Data.TaggedError("forbidden")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class TransportValidationFault extends Data.TaggedError("validation")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class TransportNotFoundFault extends Data.TaggedError("not_found")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class TransportUnavailableFault extends Data.TaggedError("unavailable")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class TransportDependencyFault extends Data.TaggedError("dependency")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class TransportCancelFault extends Data.TaggedError("cancel")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type TransportFault =
  | TransportUnauthenticatedFault
  | TransportForbiddenFault
  | TransportValidationFault
  | TransportNotFoundFault
  | TransportUnavailableFault
  | TransportDependencyFault
  | TransportCancelFault;

export const isTransportFault = (error: unknown): error is TransportFault =>
  error instanceof TransportUnauthenticatedFault ||
  error instanceof TransportForbiddenFault ||
  error instanceof TransportValidationFault ||
  error instanceof TransportNotFoundFault ||
  error instanceof TransportUnavailableFault ||
  error instanceof TransportDependencyFault ||
  error instanceof TransportCancelFault;

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

/** Map registry / domain error codes onto transport faults (Slice 9). */
export const mapInvocationCodeToTransportFault = (
  code: string,
  message: string,
  cause?: unknown
): TransportFault => {
  switch (code) {
    case "UNAUTHENTICATED": {
      return new TransportUnauthenticatedFault({ cause, message });
    }
    case "FORBIDDEN":
    case "FORBIDDEN_FULL":
    case "TRANSPORT_NOT_BOUND":
    case "CSRF_REJECTED": {
      return new TransportForbiddenFault({ cause, message });
    }
    case "INVALID_INPUT":
    case "INVALID_CONTEXT":
    case "SYNTAX_ERROR":
    case "VALIDATION_ERROR":
    case "ALREADY_ACKED":
    case "ALREADY_APPROVED":
    case "APPROVAL_EXPIRED":
    case "APPROVAL_MISMATCH":
    case "APPROVAL_NOT_FOUND":
    case "UNKNOWN_CAPABILITY": {
      return new TransportValidationFault({ cause, message });
    }
    case "NOT_FOUND": {
      return new TransportNotFoundFault({ cause, message });
    }
    case "CAPABILITY_UNAVAILABLE":
    case "UNAVAILABLE": {
      return new TransportUnavailableFault({ cause, message });
    }
    default: {
      return new TransportDependencyFault({ cause, message });
    }
  }
};

export const mapUnknownToTransportFault = (error: unknown): TransportFault => {
  if (isTransportFault(error)) {
    return error;
  }
  if (isAbortLike(error)) {
    return new TransportCancelFault({
      cause: error,
      message: "Operation cancelled",
    });
  }
  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (lower.includes("not found")) {
      return new TransportNotFoundFault({
        cause: error,
        message: error.message,
      });
    }
    if (
      lower.includes("unauthenticated") ||
      lower.includes("authentication required")
    ) {
      return new TransportUnauthenticatedFault({
        cause: error,
        message: error.message,
      });
    }
    if (lower.includes("forbidden") || lower.includes("not allowed")) {
      return new TransportForbiddenFault({
        cause: error,
        message: error.message,
      });
    }
    if (
      lower.includes("invalid") ||
      lower.includes("must be") ||
      lower.includes("validation")
    ) {
      return new TransportValidationFault({
        cause: error,
        message: error.message,
      });
    }
    return new TransportDependencyFault({
      cause: error,
      message: error.message,
    });
  }
  return new TransportDependencyFault({
    cause: error,
    message: "Unknown transport failure",
  });
};
