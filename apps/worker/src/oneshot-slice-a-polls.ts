import {
  isSupportedBronSlug,
  SUPPORTED_BRON_SLUGS,
} from "@ji/application/sources";
import type { SupportedBronSlug } from "@ji/application/sources";

import type { SliceABronDefinition } from "./slice-a-bronnen";
import { SLICE_A_BRONNEN } from "./slice-a-bronnen";
import type { PollBronPayload } from "./tasks/poll-bron-schema";

export type OneshotMode = "list" | "run";

export interface OneshotSliceAPollsArgs {
  /**
   * Explicit slug filter. Null means "all pollable" (fan-out).
   * A concrete slug still requires the bron to be pollable (no seed).
   */
  bronSlug: SupportedBronSlug | null;
  /** Cap fan-out size; null = no cap. */
  limit: number | null;
  mode: OneshotMode;
}

export const oneshotUsage = `Usage: bun apps/worker/scripts/oneshot-slice-a-polls.ts [--list|--dry-run|--run] [--bron ${SUPPORTED_BRON_SLUGS.join("|")}|all] [--limit N]

Safe default is --list / --dry-run (print pollable Slice A targets; no poll).
Pass --run to execute runPollBron sequentially for each selected bron.
Does not seed or activate bronnen (unlike poll-bron-smoke).
Not a permanent Trigger replacement — credit-outage / Coolify container ops only.
For scheduled Coolify/cron ticks use scheduled-oneshot-slice-a-polls.sh (CTP-489).`;

export const parseOneshotArgs = (
  argv: readonly string[]
): OneshotSliceAPollsArgs => {
  let mode: OneshotMode = "list";
  let bronSlug: SupportedBronSlug | null = null;
  let limit: number | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--list" || arg === "--dry-run") {
      mode = "list";
      continue;
    }
    if (arg === "--run") {
      mode = "run";
      continue;
    }
    if (arg === "--bron") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(oneshotUsage);
      }
      if (value === "all") {
        bronSlug = null;
      } else if (isSupportedBronSlug(value)) {
        bronSlug = value;
      } else {
        throw new Error(oneshotUsage);
      }
      index += 1;
      continue;
    }
    if (arg === "--limit") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(oneshotUsage);
      }
      const parsed = Math.trunc(Number(value));
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error("--limit must be a positive integer");
      }
      limit = parsed;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      throw new Error(oneshotUsage);
    }
    throw new Error(oneshotUsage);
  }

  return { bronSlug, limit, mode };
};

/**
 * Select targets from pollable Slice A rows.
 * Unknown / inactive explicit --bron yields an empty list (safe no-op) rather
 * than inventing a seed row.
 */
export const selectOneshotTargets = (
  pollable: readonly SliceABronDefinition[],
  args: OneshotSliceAPollsArgs
): SliceABronDefinition[] => {
  let selected = [...pollable];
  if (args.bronSlug) {
    selected = selected.filter((bron) => bron.bronSlug === args.bronSlug);
  }
  if (args.limit !== null) {
    selected = selected.slice(0, args.limit);
  }
  return selected;
};

export const buildPollPayload = (
  bron: SliceABronDefinition,
  scrapeRunId: string = crypto.randomUUID()
): PollBronPayload => ({
  bronId: bron.bronId,
  bronSlug: bron.bronSlug,
  scrapeRunId,
});

export interface OneshotListResult {
  mode: "list";
  pollable: number;
  targets: { bronId: string; bronSlug: string; naam: string }[];
}

export interface OneshotRunBronResult {
  bronSlug: string;
  error?: string;
  metrics?: {
    changed: number;
    error: number;
    found: number;
    new: number;
    rejected: number;
    unchanged: number;
  };
  nieuw?: number;
  scrapeRunId?: string;
  skippedReason?: "already_running";
  soft?: boolean;
  status: "failed" | "skipped" | "succeeded";
  writtenRecords?: number;
}

export interface OneshotRunTotals {
  changed: number;
  error: number;
  found: number;
  nieuw: number;
  rejected: number;
  unchanged: number;
  writtenRecords: number;
}

export interface OneshotRunResult {
  failed: number;
  finishedAt: string;
  hardFail: boolean;
  mode: "run";
  results: OneshotRunBronResult[];
  skipped: number;
  softFailed: number;
  startedAt: string;
  succeeded: number;
  targets: number;
  totals: OneshotRunTotals;
}

export type OneshotResult = OneshotListResult | OneshotRunResult;

export const formatOneshotList = (
  pollable: readonly SliceABronDefinition[],
  targets: readonly SliceABronDefinition[]
): OneshotListResult => ({
  mode: "list",
  pollable: pollable.length,
  targets: targets.map((bron) => ({
    bronId: bron.bronId,
    bronSlug: bron.bronSlug,
    naam: bron.naam,
  })),
});

/**
 * Soft / hash failures continue fan-out; everything else is a hard fail that
 * should stop the scheduled tick (CTP-489 / Coolify oneshot).
 */
export const isSoftOrHashFailure = (message: string): boolean => {
  const lower = message.toLowerCase();
  return (
    lower.includes("hash") ||
    lower.includes("knownhash") ||
    lower.includes("known-hash") ||
    lower.includes("content hash") ||
    lower.includes("soft") ||
    lower.includes("etag") ||
    lower.includes("not modified") ||
    lower.includes("429") ||
    lower.includes("rate limit") ||
    lower.includes("timeout") ||
    lower.includes("econnreset") ||
    lower.includes("fetch failed") ||
    lower.includes("network")
  );
};

const emptyTotals = (): OneshotRunTotals => ({
  changed: 0,
  error: 0,
  found: 0,
  nieuw: 0,
  rejected: 0,
  unchanged: 0,
  writtenRecords: 0,
});

/**
 * Final JSON summary for Coolify/cron ticks — one object ops can scrape.
 */
export const summarizeOneshotRun = (input: {
  finishedAt?: string;
  hardFail: boolean;
  results: readonly OneshotRunBronResult[];
  startedAt: string;
  targets: number;
}): OneshotRunResult => {
  const totals = emptyTotals();
  let succeeded = 0;
  let failed = 0;
  let softFailed = 0;
  let skipped = 0;

  for (const row of input.results) {
    if (row.status === "succeeded") {
      succeeded += 1;
      if (row.metrics) {
        totals.changed += row.metrics.changed;
        totals.error += row.metrics.error;
        totals.found += row.metrics.found;
        totals.nieuw += row.metrics.new;
        totals.rejected += row.metrics.rejected;
        totals.unchanged += row.metrics.unchanged;
      }
      totals.writtenRecords += row.writtenRecords ?? 0;
      continue;
    }
    if (row.status === "skipped") {
      skipped += 1;
      continue;
    }
    failed += 1;
    if (row.soft) {
      softFailed += 1;
    }
  }

  return {
    failed,
    finishedAt: input.finishedAt ?? new Date().toISOString(),
    hardFail: input.hardFail,
    mode: "run",
    results: [...input.results],
    skipped,
    softFailed,
    startedAt: input.startedAt,
    succeeded,
    targets: input.targets,
    totals,
  };
};

/** Registry snapshot for docs / tests — not a DB query. */
export const sliceARegistryCount = (): number => SLICE_A_BRONNEN.length;
