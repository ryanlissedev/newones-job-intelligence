import type { ConnectorRunMetrics } from "@ji/connectors";

import type { RunBaselineSample } from "./silence";

/**
 * Hard zero-discovery guard, complementary to `evaluateSilence`.
 *
 * `evaluateSilence` bails out unless `baselineAvgActivity > 0`. A mature bron
 * with stable listings reports `new + changed === 0` on every baseline run, so
 * that gate is never passed and a collapse from hundreds of found records to
 * zero raises nothing. This module looks only at `found`, which stays non-zero
 * on exactly those quiet-but-healthy runs, so the collapse becomes visible.
 *
 * The trigger is a hard zero rather than a ratio: a partial drop is ordinary
 * market movement and belongs to the silence detector's threshold, whereas a
 * drop to exactly zero against a non-zero prior is the shape a broken selector,
 * a rolled sitemap chunk or an unhandled `<sitemapindex>` produces.
 *
 * Two gates keep a single zero from failing a production poll. A slice-A bron
 * polls every 15 minutes, so a rule that armed on one in-window non-zero prior
 * turned one empty page into roughly 96 failed runs a day until that prior aged
 * out of the window, and the alert it raised needed a manual ack even after the
 * bron recovered on the next tick.
 *
 * - `DISCOVERY_FLOOR_ZERO_RUN_COUNT` makes the collapse prove it persists.
 * - `DISCOVERY_FLOOR_MIN_PEAK_FOUND` makes the bron prove it carried volume
 *   worth alerting on in the first place.
 *
 * Known limitation, deliberately accepted. A bron whose last vacancies genuinely
 * expire and stay expired still trips the guard once the zero run is long
 * enough, so absent data does NOT stay absent in this one case — it surfaces as
 * a failed run an operator has to judge. `guardEmptyListing` in
 * `bronnen/execute.ts` already took the same position for the same reason: zero
 * items is far more often a regression than an emptied bron, and nothing
 * available at this layer separates them. Erring toward a false alarm is the
 * cheaper mistake; a silently hollow source is the one nobody notices.
 */

export const DISCOVERY_FLOOR_WINDOW_DAYS = 7;

export const DISCOVERY_FLOOR_ALERT_KIND = "bron.discovery_floor" as const;

/**
 * In-process identity for the breach, distinct from the persisted envelope
 * below. The row has to reuse `DISCOVER_FAILED` to satisfy the tuple check, so
 * a caller matching on the envelope code alone cannot tell a floor breach from
 * a connector that actually threw. This code can.
 */
export const DISCOVERY_FLOOR_BREACH_CODE = "DISCOVERY_FLOOR_BREACHED" as const;

/**
 * Zero-found polls in a row, counting the run under evaluation, before the
 * floor fails a run.
 *
 * Three, matching `ZERO_ACTIVITY_RUN_COUNT` in `bron-health-thresholds.ts`,
 * which already answers the same question ("how many trailing runs before a
 * quiet source counts as broken?") for the brondashboard. Keeping one number
 * for one judgment stops the dashboard badge and the poller disagreeing about
 * when a source went dark.
 *
 * At the 15-minute slice-A cadence three polls span roughly half an hour, which
 * is the point of the number rather than a side effect. A rate-limited source
 * answering HTTP 200 with an empty list recovers on the next tick and never
 * reaches three, while a broken selector never recovers and is still caught
 * inside the hour. One is a false page, the other costs 30 minutes of
 * detection latency, and the false page is the more expensive mistake because
 * only a human can clear it.
 *
 * Counting stays possible without new persistence because a run below the
 * threshold is left `succeeded`, so `querySilenceBaselineSamples` — which
 * selects only succeeded polls — keeps returning it. Runs at or past the
 * threshold are flipped to `failed` and drop out, which is why a bron that
 * stays collapsed keeps seeing exactly `DISCOVERY_FLOOR_ZERO_RUN_COUNT - 1`
 * zero priors and keeps breaching.
 */
export const DISCOVERY_FLOOR_ZERO_RUN_COUNT = 3;

/**
 * Peak in-window `found` a bron must have reached before the floor can arm.
 *
 * The registry carries single-employer boards and interim brokers that list a
 * handful of assignments at a time. For those, zero is an ordinary Friday, not
 * a regression, and the guard has no way to tell the two apart. Five is the
 * smallest peak at which a drop to zero means several listings vanished at
 * once rather than one contract closing.
 *
 * The peak, not the mean or median, because the zero-run gate now admits the
 * leading zeros themselves into the baseline. A statistic those zeros drag
 * down would make the guard progressively harder to arm the longer a genuine
 * outage lasted, which is backwards.
 *
 * A bron below this peak is uncovered by design. Erring toward silence is the
 * right trade only here, where the signal genuinely cannot separate a closed
 * assignment from a broken selector.
 */
export const DISCOVERY_FLOOR_MIN_PEAK_FOUND = 5;

/**
 * Reuses the existing `DISCOVER_FAILED` envelope rather than minting a new
 * code. `scrape_run_failure_tuple_check` whitelists the exact
 * (phase, class, code, message) tuple and `toFailureEnvelope` throws on an
 * unlisted one, so a new code needs a migration in both places. The
 * distinguishing detail lives on the `bron.discovery_floor` alert instead:
 * this envelope alone reads as a connector exception that never happened.
 */
export const DISCOVERY_FLOOR_FAILURE = {
  class: "connector",
  code: "DISCOVER_FAILED",
  message: "Connector discovery failed",
  phase: "discover",
} as const;

export interface DiscoveryFloorEvidence {
  readonly baselineSamples: number;
  readonly baselineWindowDays: number;
  readonly consecutiveZeroRuns: number;
  readonly found: number;
  readonly lastNonZeroAt: string;
  readonly lastNonZeroFound: number;
}

export interface DiscoveryFloorInput {
  readonly baseline: readonly RunBaselineSample[];
  readonly baselineWindowDays?: number;
  readonly detectedAt: Date;
  readonly metrics: ConnectorRunMetrics;
}

export type DiscoveryFloorVerdict =
  | { readonly outcome: "ok" }
  | { readonly outcome: "no-history" }
  | { readonly outcome: "breached"; readonly evidence: DiscoveryFloorEvidence };

const withinWindow = (
  sample: RunBaselineSample,
  detectedAt: Date,
  windowDays: number
): boolean => {
  const windowMs = windowDays * 86_400_000;
  return detectedAt.getTime() - sample.at.getTime() <= windowMs;
};

const newestFirst = (
  samples: readonly RunBaselineSample[]
): RunBaselineSample[] =>
  samples.toSorted((left, right) => right.at.getTime() - left.at.getTime());

/** Zero-found polls at the head of a newest-first baseline. */
const leadingZeroRuns = (samples: readonly RunBaselineSample[]): number => {
  let count = 0;
  for (const sample of samples) {
    if (sample.found > 0) {
      return count;
    }
    count += 1;
  }
  return count;
};

const peakFound = (samples: readonly RunBaselineSample[]): number => {
  let peak = 0;
  for (const sample of samples) {
    peak = Math.max(peak, sample.found);
  }
  return peak;
};

export const evaluateDiscoveryFloor = (
  input: DiscoveryFloorInput
): DiscoveryFloorVerdict => {
  if (input.metrics.found > 0) {
    return { outcome: "ok" };
  }

  const windowDays = input.baselineWindowDays ?? DISCOVERY_FLOOR_WINDOW_DAYS;
  const samples = newestFirst(
    input.baseline.filter((sample) =>
      withinWindow(sample, input.detectedAt, windowDays)
    )
  );
  const lastNonZero = samples.find((sample) => sample.found > 0) ?? null;

  // A bron that has never found anything in-window has no floor to breach:
  // a brand-new "Nieuw" bron and a genuinely empty source read the same here.
  if (lastNonZero === null) {
    return { outcome: "no-history" };
  }

  if (peakFound(samples) < DISCOVERY_FLOOR_MIN_PEAK_FOUND) {
    return { outcome: "ok" };
  }

  const consecutiveZeroRuns = leadingZeroRuns(samples) + 1;
  if (consecutiveZeroRuns < DISCOVERY_FLOOR_ZERO_RUN_COUNT) {
    return { outcome: "ok" };
  }

  return {
    evidence: {
      baselineSamples: samples.length,
      baselineWindowDays: windowDays,
      consecutiveZeroRuns,
      found: input.metrics.found,
      lastNonZeroAt: lastNonZero.at.toISOString(),
      lastNonZeroFound: lastNonZero.found,
    },
    outcome: "breached",
  };
};

export const buildDiscoveryFloorDedupeKey = (bronId: string): string =>
  `discovery-floor:${bronId}`;

export const buildDiscoveryFloorMessage = (
  bronNaam: string,
  evidence: DiscoveryFloorEvidence
): string =>
  `Bron ${bronNaam} vond 0 records in ${evidence.consecutiveZeroRuns} opeenvolgende polls terwijl de laatste succesvolle poll op ${evidence.lastNonZeroAt} er ${evidence.lastNonZeroFound} vond; discovery is stil gevallen zonder foutmelding.`;
