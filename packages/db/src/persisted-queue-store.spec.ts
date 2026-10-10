import { describe, expect, it } from "bun:test";

import { Cause, Effect, Exit } from "effect";
import { PersistedQueueError } from "effect/unstable/persistence/PersistedQueue";

import { recoverClaimFailure } from "./persisted-queue-store";

/**
 * The claim loop's recovery contract (CTP-622): a store failure is a wait,
 * an interrupt is a shutdown — only the second may leave the take hanging.
 */
describe("recoverClaimFailure", () => {
  it("re-fails an interrupt-only cause so the take ends instead of repolling", async () => {
    const exit = await Effect.runPromiseExit(
      recoverClaimFailure(Cause.interrupt(7))
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });

  it("turns a claim failure into an empty poll, not a lost take", async () => {
    const result = await Effect.runPromise(
      recoverClaimFailure(
        Cause.fail(new PersistedQueueError({ message: "claim blew up" }))
      )
    );
    expect(result).toEqual([]);
  });
});
