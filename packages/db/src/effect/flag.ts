import { isEffectSurfaceEnabled } from "@ji/env/effect-flags";

/**
 * Opt-in Effect store wrappers (CTP-479 / Slice 14 canary for db).
 * Default OFF — native Postgres*Store construction remains the production path.
 * Rollback: unset JI_EFFECT_DB (or any value other than "1").
 */
export const isEffectDbEnabled = (): boolean => isEffectSurfaceEnabled("db");
