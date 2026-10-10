import { Effect, Exit } from "effect";

import { currentCriticalPathSession } from "../critical-path/context";
import type { CriticalPathLabel } from "../labels";
import { isCriticalPathLabel } from "../labels";
import { monotonicNowMs } from "../monotonic";
import type { CriticalPathSpanAttributes } from "./attributes";
import { sanitizeCriticalPathSpanAttributes } from "./attributes";
import { isEffectPerformanceSpansEnabled } from "./flag";

export interface WithCriticalPathSpanOptions {
  attributes?: CriticalPathSpanAttributes;
}

/** Stable Effect span name = ADR-0001 critical-path label (no free-form names). */
export const criticalPathSpanName = (label: CriticalPathLabel): string => label;

const recordSampleFromExit = <A, E>(
  label: CriticalPathLabel,
  startedMs: number,
  startedAt: string,
  exit: Exit.Exit<A, E>
): void => {
  const session = currentCriticalPathSession();
  if (session === undefined) {
    return;
  }
  session.recordSample({
    durationMs: Math.max(0, Math.round(monotonicNowMs() - startedMs)),
    endedAt: new Date().toISOString(),
    label,
    startedAt,
    success: Exit.isSuccess(exit),
  });
};

const bridgeNativeCriticalPath = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  label: CriticalPathLabel
): Effect.Effect<A, E, R> =>
  // Resolve ALS session at fiber runtime — construction may precede withCriticalPathSession.
  Effect.suspend(() => {
    if (currentCriticalPathSession() === undefined) {
      return effect;
    }
    const startedMs = monotonicNowMs();
    const startedAt = new Date().toISOString();
    return Effect.flatMap(Effect.exit(effect), (exit) => {
      recordSampleFromExit(label, startedMs, startedAt, exit);
      return exit;
    });
  });

/**
 * Opt-in Effect span aligned to a critical-path label (CTP-478 Slice 12).
 * When PERF_EFFECT_SPANS is not 1, returns the effect unchanged (native default / prod OFF).
 * Span attributes are sanitized — digests and bounded tokens only, never PII.
 */
export const withCriticalPathSpan = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  label: CriticalPathLabel,
  options: WithCriticalPathSpanOptions = {}
): Effect.Effect<A, E, R> => {
  if (!isCriticalPathLabel(label)) {
    throw new Error(`Unsupported critical-path label: ${String(label)}`);
  }
  if (!isEffectPerformanceSpansEnabled()) {
    return effect;
  }
  const attributes = sanitizeCriticalPathSpanAttributes({
    ...options.attributes,
    label,
  });
  const traced = Effect.withSpan(effect, criticalPathSpanName(label), {
    attributes,
  });
  return bridgeNativeCriticalPath(traced, label);
};

/**
 * Annotate the current Effect span with sanitized critical-path attributes.
 * No-op (identity) when Effect performance spans are disabled.
 */
export const annotateCriticalPathSpan = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  attributes: CriticalPathSpanAttributes
): Effect.Effect<A, E, R> => {
  if (!isEffectPerformanceSpansEnabled()) {
    return effect;
  }
  const sanitized = sanitizeCriticalPathSpanAttributes(attributes);
  if (Object.keys(sanitized).length === 0) {
    return effect;
  }
  return Effect.annotateSpans(effect, sanitized);
};
