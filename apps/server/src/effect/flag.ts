import { isEffectSurfaceEnabled } from "@ji/env/effect-flags";

/**
 * Opt-in Effect transport boundary (CTP-479 / Slice 14 canary for server).
 * Default OFF — REST/MCP keep the native Promise invoker path.
 * Rollback: unset JI_EFFECT_SERVER (or any value other than "1").
 */
export const isEffectServerEnabled = (): boolean =>
  isEffectSurfaceEnabled("server");
