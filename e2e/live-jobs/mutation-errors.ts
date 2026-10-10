export type MutationFailureCode =
  | "cleanup-invalid-response"
  | "cleanup-request-failed"
  | "cleanup-residue"
  | "mutation-assertion-failed";

export type MutationFailurePhase =
  | "cleanup"
  | "create-snapshot"
  | "mark-canary"
  | "open-canary"
  | "route-assertion"
  | "save-search";

export interface MutationFailure {
  readonly code: MutationFailureCode;
  readonly phase: MutationFailurePhase;
}

export class SanitizedMutationError extends Error {
  readonly code: MutationFailureCode;
  readonly phase: MutationFailurePhase;

  constructor(failure: MutationFailure) {
    super(`Live jobs E2E failed [${failure.code}] during ${failure.phase}.`);
    this.name = "SanitizedMutationError";
    this.code = failure.code;
    this.phase = failure.phase;
  }
}

interface MutationFailureState {
  readonly cleanupFailure?: MutationFailure;
  readonly primaryFailure?: MutationFailure;
}

export const safeMutationFailure = (
  error: Error,
  fallback: MutationFailure
): MutationFailure =>
  error instanceof SanitizedMutationError
    ? { code: error.code, phase: error.phase }
    : fallback;

/**
 * Re-throws only safe typed failure metadata. Original errors, URLs, response
 * bodies, selectors, identities, and credentials are never retained.
 */
export const throwSanitizedMutationFailures = ({
  cleanupFailure,
  primaryFailure,
}: MutationFailureState): void => {
  const primaryError = primaryFailure
    ? new SanitizedMutationError(primaryFailure)
    : undefined;
  const cleanupError = cleanupFailure
    ? new SanitizedMutationError(cleanupFailure)
    : undefined;

  if (primaryError && cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "Live jobs mutation and cleanup both failed with sanitized typed metadata."
    );
  }
  if (primaryError) {
    throw primaryError;
  }
  if (cleanupError) {
    throw cleanupError;
  }
};
