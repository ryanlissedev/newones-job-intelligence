/**
 * Strips Postgres connection strings out of anything about to be logged.
 *
 * Connection strings are the one secret that reliably reaches an error message
 * on this path: postgres.js and Drizzle both quote the URL they failed on, and
 * it carries the role password. This lives in `@ji/db` rather than in the
 * worker because both the poller's `poller_source` line and `curateScrapeRun`'s
 * own stderr lines carry `cause` chains sourced from the same two libraries,
 * and one redaction policy is the only way both stay covered.
 */

const CONNECTION_URL_PATTERN = /postgres(?:ql)?:\/\/\S+/giu;

const REDACTED = "[redacted]";

/**
 * Replaces every `postgres://` or `postgresql://` URL with `[redacted]`.
 *
 * Always run this before truncating, never after: a cut applied first can leave
 * half a password in the output.
 */
export const redactConnectionUrls = (message: string): string =>
  message.replace(CONNECTION_URL_PATTERN, REDACTED);
