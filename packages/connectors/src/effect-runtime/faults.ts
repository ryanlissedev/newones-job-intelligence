/* oxlint-disable eslint/max-classes-per-file, anti-slop/no-unknown-parameters -- ADR-0013 tagged fault union lives in one module;  Read-I/O fault mapping is the platform catch boundary: Promise rejections and fetch failures arrive as unknown and are classified into ADR-0013 tagged faults here. */
import { Data } from "effect";

/** ADR-0013 fault categories for read-I/O (platform contract; no JI domain types). */
export type ReadIoFaultCategory =
  | "auth"
  | "validation"
  | "not_found"
  | "rate_limit"
  | "transient_network"
  | "server_5xx"
  | "cancel";

export class AuthFault extends Data.TaggedError("auth")<{
  readonly message: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {}

export class ValidationFault extends Data.TaggedError("validation")<{
  readonly message: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {}

export class NotFoundFault extends Data.TaggedError("not_found")<{
  readonly message: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {}

export class RateLimitFault extends Data.TaggedError("rate_limit")<{
  readonly message: string;
  readonly retryAfterMs: number | null;
  readonly status: number;
  readonly cause?: unknown;
}> {}

export class TransientNetworkFault extends Data.TaggedError(
  "transient_network"
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class Server5xxFault extends Data.TaggedError("server_5xx")<{
  readonly message: string;
  readonly status: number;
  readonly cause?: unknown;
}> {}

export class CancelFault extends Data.TaggedError("cancel")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type ReadIoFault =
  | AuthFault
  | ValidationFault
  | NotFoundFault
  | RateLimitFault
  | TransientNetworkFault
  | Server5xxFault
  | CancelFault;

export const isReadIoFault = (error: unknown): error is ReadIoFault =>
  error instanceof AuthFault ||
  error instanceof ValidationFault ||
  error instanceof NotFoundFault ||
  error instanceof RateLimitFault ||
  error instanceof TransientNetworkFault ||
  error instanceof Server5xxFault ||
  error instanceof CancelFault;

export const isRetryableReadIoFault = (error: ReadIoFault): boolean =>
  error._tag === "rate_limit" ||
  error._tag === "transient_network" ||
  error._tag === "server_5xx";

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

export const parseRetryAfterMs = (header: string | null): number | null => {
  if (!header) {
    return null;
  }
  const trimmed = header.trim();
  if (/^\d+$/u.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) {
    return null;
  }
  return Math.max(0, when - Date.now());
};

export const mapHttpStatusToFault = (options: {
  status: number;
  message: string;
  retryAfterHeader?: string | null;
  cause?: unknown;
}): ReadIoFault => {
  const { status, message, cause } = options;
  if (status === 401 || status === 403) {
    return new AuthFault({ cause, message, status });
  }
  if (status === 404) {
    return new NotFoundFault({ cause, message, status });
  }
  if (status === 400 || status === 422) {
    return new ValidationFault({ cause, message, status });
  }
  if (status === 429) {
    return new RateLimitFault({
      cause,
      message,
      retryAfterMs: parseRetryAfterMs(options.retryAfterHeader ?? null),
      status,
    });
  }
  if (status >= 500 && status <= 599) {
    return new Server5xxFault({ cause, message, status });
  }
  return new ValidationFault({ cause, message, status });
};

export const mapUnknownToReadIoFault = (error: unknown): ReadIoFault => {
  if (isReadIoFault(error)) {
    return error;
  }
  if (isAbortLike(error)) {
    return new CancelFault({
      cause: error,
      message: error instanceof Error ? error.message : "Aborted",
    });
  }
  if (error instanceof TypeError) {
    return new TransientNetworkFault({
      cause: error,
      message: error.message || "Network request failed",
    });
  }
  if (error instanceof Error) {
    return new TransientNetworkFault({
      cause: error,
      message: error.message || "Request failed",
    });
  }
  return new TransientNetworkFault({
    cause: error,
    message: "Request failed",
  });
};
