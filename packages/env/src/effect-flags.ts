/**
 * Per-surface EffectTS production enablement flags (CTP-479 / Slice 14).
 *
 * All surfaces default OFF. Search has no flag since CTP-627: the Effect
 * Manticore client is its only transport.
 *
 * Remaining surfaces default OFF. Catapulze enables **one surface at a time** via Coolify
 * env (`=1`). Rollback = unset / any value other than exact `"1"` → prior/native path.
 *
 * These helpers read `process.env` directly (no createEnv boot) so search/db/worker
 * composition sites can share the same names without importing the full server schema.
 */

export const EFFECT_SURFACES = ["db", "server", "worker", "perf"] as const;

export type EffectSurface = (typeof EFFECT_SURFACES)[number];

/** Coolify / process env keys. Exact `"1"` enables; anything else is OFF. */
export const EFFECT_SURFACE_ENV_KEYS = {
  db: "JI_EFFECT_DB",
  perf: "PERF_EFFECT_SPANS",
  server: "JI_EFFECT_SERVER",
  worker: "JI_EFFECT_WORKER",
} as const satisfies Record<EffectSurface, string>;

const isExactOne = (value: string | undefined): boolean => value === "1";

/**
 * Optional alias for perf so operators can use the JI_EFFECT_* naming family.
 * Canonical key remains PERF_EFFECT_SPANS (CTP-478).
 */
const PERF_ALIAS_ENV_KEY = "JI_EFFECT_PERF";

export const isEffectSurfaceEnabled = (surface: EffectSurface): boolean => {
  if (surface === "perf") {
    return (
      isExactOne(process.env[EFFECT_SURFACE_ENV_KEYS.perf]) ||
      isExactOne(process.env[PERF_ALIAS_ENV_KEY])
    );
  }
  return isExactOne(process.env[EFFECT_SURFACE_ENV_KEYS[surface]]);
};

export const readEffectSurfaceFlags = () =>
  ({
    db: isEffectSurfaceEnabled("db"),
    perf: isEffectSurfaceEnabled("perf"),
    server: isEffectSurfaceEnabled("server"),
    worker: isEffectSurfaceEnabled("worker"),
  }) satisfies Record<EffectSurface, boolean>;

export const listEnabledEffectSurfaces = (): readonly EffectSurface[] =>
  EFFECT_SURFACES.filter((surface) => isEffectSurfaceEnabled(surface));
