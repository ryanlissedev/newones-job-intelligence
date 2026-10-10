/** Bounded critical-path labels from ADR-0001; no free-form strings. */
export const CRITICAL_PATH_LABELS = [
  "search-parser",
  "search-adapter",
  "search-engine",
  "search-facets",
  "search-serialization",
  "search-summary",
  "ingest-queuewait",
  "ingest-discover",
  "ingest-fetch",
  "ingest-raw-write",
  "ingest-normalisation",
  "ingest-dedupe",
  "ingest-commit",
  "ingest-outbox",
  "ingest-index-projection",
  "api-handler",
  "db-poolwait",
  "db-query",
  "db-transaction",
  "db-locks",
  "instrumentation-overhead",
] as const;

export type CriticalPathLabel = (typeof CRITICAL_PATH_LABELS)[number];

const LABEL_SET = new Set<string>(CRITICAL_PATH_LABELS);

export const isCriticalPathLabel = (
  value: string
): value is CriticalPathLabel => LABEL_SET.has(value);
