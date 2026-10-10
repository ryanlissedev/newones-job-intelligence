/**
 * Raised when a Manticore request is aborted by the client-side transport
 * timeout (RJC-380; see DEFAULT_FETCH_TIMEOUT_MS in client-effect.ts). Deliberately
 * a distinct error type from "no results" or a Manticore-reported error — a
 * caller that treated an aborted request the same as an empty result set
 * would silently show "no matches" for what is actually an
 * unreachable/hung search backend.
 */
export class ManticoreTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`Manticore request to ${url} timed out after ${timeoutMs}ms`);
    this.name = "ManticoreTimeoutError";
  }
}
