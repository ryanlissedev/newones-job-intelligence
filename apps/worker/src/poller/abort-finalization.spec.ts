import { expect, it } from "bun:test";

import { RunOwnershipLostError } from "@ji/connectors";

import { withAbortFinalization } from "./abort-finalization";
import { drainBacklog } from "./drain-backlog";

it("finalizes cancellation raised during work before propagating its reason", async () => {
  const controller = new AbortController();
  let finalized = 0;
  await expect(
    withAbortFinalization(
      controller.signal,
      () => {
        finalized += 1;
        return Promise.resolve();
      },
      () => {
        controller.abort(new Error("budget expired"));
        return Promise.reject(controller.signal.reason);
      }
    )
  ).rejects.toBe(controller.signal.reason);
  expect(finalized).toBe(1);
});

it.each([new Error("storage unavailable"), new RunOwnershipLostError()])(
  "finalizes a concurrent failure racing an abort and preserves its error: %s",
  async (failure) => {
    const controller = new AbortController();
    let finalized = false;
    await expect(
      withAbortFinalization(
        controller.signal,
        () => {
          finalized = true;
          return Promise.resolve();
        },
        () => {
          controller.abort(new Error("shutdown"));
          return Promise.reject(failure);
        }
      )
    ).rejects.toBe(failure);
    expect(finalized).toBe(true);
  }
);

it("finalizes when the abort surfaces as a fresh AbortError instead of the reason", async () => {
  const controller = new AbortController();
  let finalized = false;
  const freshAbortError = new DOMException("Aborted", "AbortError");
  await expect(
    withAbortFinalization(
      controller.signal,
      () => {
        finalized = true;
        return Promise.resolve();
      },
      () => {
        controller.abort();
        return Promise.reject(freshAbortError);
      }
    )
  ).rejects.toBe(freshAbortError);
  expect(finalized).toBe(true);
});

it("does not hide a rejected fenced finalization behind the abort reason", async () => {
  const controller = new AbortController();
  const ownershipError = new RunOwnershipLostError();
  controller.abort(new Error("shutdown"));
  await expect(
    withAbortFinalization(
      controller.signal,
      () => Promise.reject(ownershipError),
      () => Promise.resolve(1)
    )
  ).rejects.toBe(ownershipError);
});

it("finalizes shutdown between drain passes instead of reporting successful drain", async () => {
  const controller = new AbortController();
  let passes = 0;
  let finalized = 0;
  await expect(
    withAbortFinalization(
      controller.signal,
      () => {
        finalized += 1;
        return Promise.resolve();
      },
      () =>
        drainBacklog(
          {
            deadlineMs: 10,
            input: {},
            signal: controller.signal,
            start: { curated: 0, failed: 0, quarantined: 0, remaining: 2 },
          },
          () => {
            passes += 1;
            controller.abort(new Error("shutdown after first commit"));
            return Promise.resolve({
              curated: 1,
              failed: 0,
              quarantined: 0,
              remaining: 1,
            });
          },
          () => 0
        )
    )
  ).rejects.toBe(controller.signal.reason);
  expect(passes).toBe(1);
  expect(finalized).toBe(1);
});
