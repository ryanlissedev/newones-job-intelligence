/* oxlint-disable eslint/max-classes-per-file, anti-slop/no-unknown-parameters -- DB store tagged fault union + unknown catch boundary (CTP-473 Slice 8). */
import { Data } from "effect";

/** Opt-in DB store fault categories (Slice 8; kept local to @ji/db, no application coupling). */
export type DbStoreFaultCategory =
  | "dependency"
  | "not_found"
  | "validation"
  | "cancel";

export class DbStoreDependencyFault extends Data.TaggedError("dependency")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class DbStoreNotFoundFault extends Data.TaggedError("not_found")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class DbStoreValidationFault extends Data.TaggedError("validation")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class DbStoreCancelFault extends Data.TaggedError("cancel")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type DbStoreFault =
  | DbStoreDependencyFault
  | DbStoreNotFoundFault
  | DbStoreValidationFault
  | DbStoreCancelFault;

export const isDbStoreFault = (error: unknown): error is DbStoreFault =>
  error instanceof DbStoreDependencyFault ||
  error instanceof DbStoreNotFoundFault ||
  error instanceof DbStoreValidationFault ||
  error instanceof DbStoreCancelFault;

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

export const mapUnknownToDbStoreFault = (error: unknown): DbStoreFault => {
  if (isDbStoreFault(error)) {
    return error;
  }
  if (isAbortLike(error)) {
    return new DbStoreCancelFault({
      cause: error,
      message: "Operation cancelled",
    });
  }
  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (lower.includes("not found")) {
      return new DbStoreNotFoundFault({
        cause: error,
        message: error.message,
      });
    }
    if (
      lower.includes("invalid") ||
      lower.includes("must be") ||
      lower.includes("validation")
    ) {
      return new DbStoreValidationFault({
        cause: error,
        message: error.message,
      });
    }
    return new DbStoreDependencyFault({
      cause: error,
      message: error.message,
    });
  }
  return new DbStoreDependencyFault({
    cause: error,
    message: "Unknown DB store failure",
  });
};
