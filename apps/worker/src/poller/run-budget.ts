import { isSupportedBronSlug, SOURCES } from "@ji/application/sources";
import type { SourceDefinition } from "@ji/application/sources";

/**
 * Room left between a long source's run budget and the stale-run reaper, so a
 * live run that hits its budget closes its own row (as `aborted`) before
 * `abandonStaleRuns` marks it failed.
 */
export const RUN_BUDGET_REAPER_MARGIN_MS = 30 * 60 * 1000;

export interface RunBudgetLimits {
  /** `POLLER_ABANDON_RUN_AFTER_MS`. */
  readonly abandonRunAfterMs: number;
  /** `POLLER_RUN_BUDGET_MS`, the poller-wide default. */
  readonly defaultBudgetMs: number;
}

/**
 * The budget for one run: the poller-wide default, raised to the source's own
 * `runBudgetMs` when it declares a longer one, but never to within
 * `RUN_BUDGET_REAPER_MARGIN_MS` of the reaper. A source budget never lowers
 * the default, and an operator who set the default above the cap keeps it.
 */
export const resolveRunBudgetMs = (
  sourceBudgetMs: number | undefined,
  { abandonRunAfterMs, defaultBudgetMs }: RunBudgetLimits
): number => {
  if (sourceBudgetMs === undefined) {
    return defaultBudgetMs;
  }
  const cap = abandonRunAfterMs - RUN_BUDGET_REAPER_MARGIN_MS;
  return Math.max(defaultBudgetMs, Math.min(sourceBudgetMs, cap));
};

/** `resolveRunBudgetMs` for a bron slug from the source registry. */
export const runBudgetForBron = (
  bronSlug: string,
  limits: RunBudgetLimits
): number => {
  if (!isSupportedBronSlug(bronSlug)) {
    return limits.defaultBudgetMs;
  }
  const definition: SourceDefinition = SOURCES[bronSlug];
  return resolveRunBudgetMs(definition.runBudgetMs, limits);
};
