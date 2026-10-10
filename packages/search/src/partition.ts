import type { AanvraagLifecycle } from "@ji/domain";

import type { SearchDocument } from "./types";

/**
 * Physical split of the search index (RJC-383): recruiters' default search
 * space is the placeable stock (`active`); closed, stale and expired work
 * lives in `archive`. Each partition is its own RT table
 * (`<index>_active`, `<index>_archive` — see partitionTable) with the same
 * schema, so a document is in exactly one of them at any time.
 */
export const SEARCH_PARTITIONS = ["active", "archive"] as const;

export type SearchPartition = (typeof SEARCH_PARTITIONS)[number];

/** Which partitions a search reads: the default `active`, or `all` (both). */
export const SEARCH_SCOPES = ["active", "all"] as const;

export type SearchScope = (typeof SEARCH_SCOPES)[number];

export const DEFAULT_SEARCH_SCOPE: SearchScope = "active";

/**
 * Recency window (days since `laatstGezienOp`) after which an otherwise open
 * document is partitioned into the archive. PRODUCT DECISION PENDING (Ryan):
 * `null` disables the rule, so today the partition is lifecycle-driven only
 * (status + passed sluitingsdatum). Two facts argue for leaving it off until
 * decided: RJC-397 already turns a record that disappears from its listing
 * into `stale` (which archives it) without a clock, and the partition is
 * only re-evaluated when an outbox event arrives — a window without a
 * periodic sweep would archive a document only on its NEXT event, which is
 * exactly the moment the source is talking about it again. Set to e.g. 30
 * once a sweep exists; resolveSearchPartition already honours it.
 */
export const ACTIVE_RECENT_DAYS: number | null = null;

const MS_PER_DAY = 86_400_000;

/**
 * Pure partition rule. `closed` and `stale` (RJC-377 date closes, RJC-397
 * listing-disappearance closes) and a passed sluitingsdatum always archive,
 * whatever `laatstGezienOp` says; `active`/`unknown` stay active unless the
 * recency window (when enabled) has elapsed.
 */
export const resolveSearchPartition = (
  status: AanvraagLifecycle,
  sluitingsdatumPassed: boolean,
  laatstGezienOp: Date,
  now: Date,
  recentDays: number | null = ACTIVE_RECENT_DAYS
): SearchPartition => {
  if (status === "closed" || status === "stale" || sluitingsdatumPassed) {
    return "archive";
  }
  if (
    recentDays !== null &&
    now.getTime() - laatstGezienOp.getTime() > recentDays * MS_PER_DAY
  ) {
    return "archive";
  }
  return "active";
};

/** Partition of a document as the engines index it at `now`. */
export const documentPartition = (
  document: SearchDocument,
  now: Date,
  recentDays: number | null = ACTIVE_RECENT_DAYS
): SearchPartition =>
  resolveSearchPartition(
    document.status,
    document.sluitingsdatum instanceof Date &&
      document.sluitingsdatum.getTime() < now.getTime(),
    document.laatstGezienOp,
    now,
    recentDays
  );

export const otherPartition = (partition: SearchPartition): SearchPartition =>
  partition === "active" ? "archive" : "active";

/** RT table name of one partition of the logical index. */
export const partitionTable = (
  indexName: string,
  partition: SearchPartition
): string => `${indexName}_${partition}`;

/**
 * Manticore multi-table target for a scope. Verified live on 6.3.8
 * (RJC-383 probe): `index: "a,b"` merges total, terms aggregations, attribute
 * sorts and offset paging across both tables exactly as one table would.
 */
export const scopeTables = (indexName: string, scope: SearchScope): string =>
  scope === "all"
    ? SEARCH_PARTITIONS.map((partition) =>
        partitionTable(indexName, partition)
      ).join(",")
    : partitionTable(indexName, "active");

/** Whether a document in `partition` is visible under `scope`. */
export const partitionInScope = (
  partition: SearchPartition,
  scope: SearchScope
): boolean => scope === "all" || partition === "active";
