import { isEffectSurfaceEnabled } from "@ji/env/effect-flags";

/**
 * Opt-in Effect worker task-body boundary (CTP-479 / Slice 14 canary for worker).
 * Default OFF — Trigger schemaTask `run` stays native runPollBron / runDrainOutbox.
 * Rollback: unset JI_EFFECT_WORKER (or any value other than "1").
 *
 * Worker does not boot `@ji/env/server`; it shares the flag name SoT via effect-flags.
 */
export const isEffectWorkerEnabled = (): boolean =>
  isEffectSurfaceEnabled("worker");
