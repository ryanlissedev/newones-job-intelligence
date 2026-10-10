import { isEffectSurfaceEnabled } from "@ji/env/effect-flags";

/**
 * Opt-in Effect performance spans (CTP-478 / Slice 12; canary via CTP-479).
 * Default OFF — native critical-path sessions remain default.
 * Rollback: unset PERF_EFFECT_SPANS / JI_EFFECT_PERF (or any value other than "1").
 */
export const isEffectPerformanceSpansEnabled = (): boolean =>
  isEffectSurfaceEnabled("perf");
