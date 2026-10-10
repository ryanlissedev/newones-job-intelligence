import { AanvraagLifecycleSchema } from "./aanvraag";
import type { AanvraagLifecycle } from "./aanvraag";
import { NonNegativeInteger, PositiveInteger, Schema } from "./schema-helpers";

export const DEFAULT_MISSED_POLLS_BEFORE_STALE = 3;

/**
 * Why a lifecycle status changed without the source saying so (RJC-397).
 * Carried in the outbox payload (`reden`) and the SCD2 snapshot so an
 * operator can tell a listing-disappearance close from a date-based one.
 *
 * Effect Schema SoT (ADR-0014 Slice 5 / CTP-470). Pure transition helpers
 * below stay Effect-free.
 */
export const LIFECYCLE_REDENEN = [
  /** Missed `missedPollsBeforeStale` complete listing runs in a row. */
  "listing_verdwenen",
  /** Reappeared in a complete listing run after being stale. */
  "listing_teruggekeerd",
] as const;

/** Effect Schema SoT for lifecycle reden. */
export const LifecycleRedenSchema = Schema.Literals(LIFECYCLE_REDENEN);

export type LifecycleReden = typeof LifecycleRedenSchema.Type;

/** Effect Schema SoT for lifecycle transition inputs. */
export const LifecycleTransitionInputSchema = Schema.Struct({
  bronSaysClosed: Schema.Boolean,
  current: AanvraagLifecycleSchema,
  missedPolls: NonNegativeInteger,
  missedPollsBeforeStale: Schema.optionalKey(PositiveInteger),
  seenOpen: Schema.Boolean,
  sluitingsdatumPassed: Schema.Boolean,
});

export type LifecycleTransitionInput =
  typeof LifecycleTransitionInputSchema.Type;

/**
 * Two independent close signals feed this derivation, and they are owned by
 * two different steps:
 *
 * - `bronSaysClosed` / `sluitingsdatumPassed` come from the normaliser
 *   (RJC-377) and yield `closed`. Being observed again never reopens a
 *   `closed` record here: `seenOpen` is checked after the close signals.
 * - `missedPolls` is counted per COMPLETE listing run at the run boundary
 *   (`reconcileMissedPolls`, RJC-397) and yields `stale`, never `closed`.
 *   A `stale` record that reappears in a listing is live again and goes
 *   back to `active` (`listing_teruggekeerd`). Normalisers pass
 *   `missedPolls: 0` because the count is unknown at normalise time.
 *
 * `closed` therefore always outranks `stale`: a date-closed record that
 * also disappears stays `closed`, and a stale record whose source later
 * publishes a closing date becomes `closed` through the normaliser path.
 */
export const resolveLifecycleStatus = (
  input: LifecycleTransitionInput
): AanvraagLifecycle => {
  const staleThreshold =
    input.missedPollsBeforeStale ?? DEFAULT_MISSED_POLLS_BEFORE_STALE;

  if (input.bronSaysClosed || input.sluitingsdatumPassed) {
    return "closed";
  }

  if (input.seenOpen) {
    return "active";
  }

  if (input.missedPolls >= staleThreshold) {
    return input.current === "closed" ? "closed" : "stale";
  }

  if (input.current === "unknown") {
    return "unknown";
  }

  return input.current;
};

export const canReopenFromClosed = (input: {
  bronSaysClosed: boolean;
  sluitingsdatumPassed: boolean;
  seenOpen: boolean;
}): boolean =>
  input.seenOpen && !input.bronSaysClosed && !input.sluitingsdatumPassed;
