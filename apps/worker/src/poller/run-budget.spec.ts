import { describe, expect, it } from "bun:test";

import { SOURCES, SUPPORTED_BRON_SLUGS } from "@ji/application/sources";
import type {
  SourceDefinition,
  SupportedBronSlug,
} from "@ji/application/sources";
import {
  CrawlDelayLimiter,
  InMemoryObjectStore,
  InMemoryObservationRecorder,
  InMemoryRunLifecycleStore,
  runConnector,
} from "@ji/connectors";
import {
  createJsonLdClient,
  createJsonLdConnector,
  randstadConfig,
} from "@ji/connectors/json-ld";
import {
  ABANDON_RUN_AFTER_MS_DEFAULT,
  RUN_BUDGET_MS_DEFAULT,
} from "@ji/env/poller";

import {
  resolveRunBudgetMs,
  RUN_BUDGET_REAPER_MARGIN_MS,
  runBudgetForBron,
} from "./run-budget";

const HOUR_MS = 60 * 60 * 1000;

const productionLimits = {
  abandonRunAfterMs: ABANDON_RUN_AFTER_MS_DEFAULT,
  defaultBudgetMs: RUN_BUDGET_MS_DEFAULT,
};

/**
 * Sitemap detail URLs counted on 6 Oct 2026. Neither source may skip a
 * detail fetch (`listingHashCoversDetail: false`), so every URL costs one
 * crawl-delay slot on every run.
 */
const LONG_CRAWLS: readonly {
  readonly corpusUrls: number;
  readonly slug: SupportedBronSlug;
}[] = [
  { corpusUrls: 2988, slug: "randstad" },
  { corpusUrls: 8526, slug: "techniekwerkt" },
];

/** Headroom over corpus × crawl delay for catalog growth and slow pages. */
const MIN_HEADROOM = 1.1;

describe("resolveRunBudgetMs", () => {
  it("keeps the poller-wide default when the source declares nothing", () => {
    expect(resolveRunBudgetMs(undefined, productionLimits)).toBe(
      RUN_BUDGET_MS_DEFAULT
    );
  });

  it("raises the budget to the source's own longer budget", () => {
    expect(resolveRunBudgetMs(3 * HOUR_MS, productionLimits)).toBe(3 * HOUR_MS);
  });

  it("never lets a source budget lower the poller-wide default", () => {
    expect(resolveRunBudgetMs(10 * 60 * 1000, productionLimits)).toBe(
      RUN_BUDGET_MS_DEFAULT
    );
  });

  it("caps a source budget below the stale-run reaper", () => {
    expect(resolveRunBudgetMs(12 * HOUR_MS, productionLimits)).toBe(
      ABANDON_RUN_AFTER_MS_DEFAULT - RUN_BUDGET_REAPER_MARGIN_MS
    );
  });

  it("leaves an operator default above the cap alone", () => {
    expect(
      resolveRunBudgetMs(5 * HOUR_MS, {
        abandonRunAfterMs: 2 * HOUR_MS,
        defaultBudgetMs: 3 * HOUR_MS,
      })
    ).toBe(3 * HOUR_MS);
  });
});

describe("source run budgets", () => {
  for (const { corpusUrls, slug } of LONG_CRAWLS) {
    it(`${slug} gets enough wall clock to walk its whole sitemap`, () => {
      const definition: SourceDefinition = SOURCES[slug];
      const fullCrawlMs = corpusUrls * definition.seed.crawlDelayMs;
      const budgetMs = runBudgetForBron(slug, productionLimits);

      // The cause of the recurring TimeoutError: a full crawl outlasts the
      // one hour default, so every run aborted part-way and restarted at 0.
      expect(fullCrawlMs).toBeGreaterThan(RUN_BUDGET_MS_DEFAULT);
      expect(budgetMs).toBe(definition.runBudgetMs ?? Number.NaN);
      expect(budgetMs).toBeGreaterThanOrEqual(fullCrawlMs * MIN_HEADROOM);
      expect(budgetMs).toBeLessThanOrEqual(
        ABANDON_RUN_AFTER_MS_DEFAULT - RUN_BUDGET_REAPER_MARGIN_MS
      );
    });
  }

  it("keeps every other source on the poller-wide default", () => {
    const longSlugs: readonly string[] = LONG_CRAWLS.map(({ slug }) => slug);
    const raised: readonly string[] = SUPPORTED_BRON_SLUGS.filter(
      (slug) =>
        runBudgetForBron(slug, productionLimits) !== RUN_BUDGET_MS_DEFAULT
    );
    expect(raised.toSorted()).toEqual(longSlugs.toSorted());
  });

  it("falls back to the default for an unknown slug", () => {
    expect(runBudgetForBron("not-a-source", productionLimits)).toBe(
      RUN_BUDGET_MS_DEFAULT
    );
  });
});

const retryPolicy = {
  initialDelayMs: 0,
  jitter: (delayMs: number) => delayMs,
  maxAttempts: 1,
  maxDelayMs: 0,
  multiplier: 1,
};

/**
 * Runs the recorded Randstad sitemap (5 URLs) at its real 2 s crawl delay on a
 * virtual clock: the limiter's waits advance time instead of sleeping, and the
 * run signal aborts once virtual time passes the budget, exactly as
 * `AbortSignal.timeout(budget)` does in the poller. Deterministic under load.
 */
const runRandstadFixture = (budgetMs: number) => {
  const bronId = "00000000-0000-4000-8000-000000000019";
  const definition: SourceDefinition = SOURCES.randstad;
  const budget = new AbortController();
  let virtualNow = 0;
  const limiter = new CrawlDelayLimiter({
    crawlDelayMs: definition.seed.crawlDelayMs,
    now: () => virtualNow,
    wait: (milliseconds, signal) => {
      virtualNow += milliseconds;
      if (virtualNow > budgetMs && !budget.signal.aborted) {
        budget.abort(new DOMException("run budget elapsed", "TimeoutError"));
      }
      return signal?.aborted
        ? Promise.reject(
            new DOMException("The operation was aborted", "AbortError")
          )
        : Promise.resolve();
    },
  });
  return runConnector({
    bronId,
    bronSlug: randstadConfig.slug,
    checkpoint: null,
    connector: createJsonLdConnector({
      bronId,
      client: createJsonLdClient({
        config: randstadConfig,
        liveEnabled: false,
        onMissingDetailFixture: "skip",
      }),
      config: randstadConfig,
    }),
    limiter,
    objectStore: new InMemoryObjectStore(),
    observationRecorder: new InMemoryObservationRecorder(),
    rawRetentionDays: 90,
    retryPolicy,
    runKind: "test",
    runLifecycleStore: new InMemoryRunLifecycleStore(),
    scrapeRunId: `run-randstad-budget-${budgetMs}`,
    signal: budget.signal,
    startedAt: new Date("2026-10-06T08:00:00.000Z"),
  });
};

describe("Randstad fixture crawl against its budget", () => {
  it("aborts part-way when the budget is shorter than the crawl", async () => {
    // 5 URLs at 2 s need ~10 s; 3 s is the production failure in miniature.
    const result = await runRandstadFixture(3000);
    expect(result.completeness).toEqual({ complete: false, reason: "aborted" });
  });

  it("completes inside the budget the poller resolves for Randstad", async () => {
    const listing = await createJsonLdClient({
      config: randstadConfig,
      liveEnabled: false,
    }).fetchListing();
    const result = await runRandstadFixture(
      runBudgetForBron("randstad", productionLimits)
    );
    expect(result.completeness).toEqual({ complete: true });
    expect(result.metrics.found).toBe(listing.length);
  });
});
