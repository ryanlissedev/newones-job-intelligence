import { describe, expect, it } from "bun:test";

import { Effect } from "effect";

import {
  runUseCasePromise,
  UseCaseCancelFault,
  UseCaseValidationFault,
} from "./index";

describe("application effect runUseCasePromise", () => {
  it("returns success values", async () => {
    await expect(runUseCasePromise(Effect.succeed(42))).resolves.toBe(42);
  });

  it("rethrows UseCaseFault", async () => {
    const fault = new UseCaseValidationFault({ message: "bad input" });
    await expect(runUseCasePromise(Effect.fail(fault))).rejects.toBe(fault);
  });

  it("maps abort signal to UseCaseCancelFault", async () => {
    const controller = new AbortController();
    const pending = runUseCasePromise(Effect.never, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(UseCaseCancelFault);
  });
});
