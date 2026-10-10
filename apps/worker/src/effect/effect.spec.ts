import { describe, expect, it } from "bun:test";

import { Effect } from "effect";

import {
  WorkerCancelFault,
  WorkerDependencyFault,
  WorkerNotFoundFault,
  WorkerUnavailableFault,
  WorkerValidationFault,
  isWorkerFault,
  mapUnknownToWorkerFault,
} from "./faults";
import { fromWorkerPromise } from "./from-promise";
import { runWorkerPromise } from "./run";

describe("mapUnknownToWorkerFault", () => {
  it("maps not-found / validation / unavailable messages onto tagged faults", () => {
    expect(mapUnknownToWorkerFault(new Error("bron not found"))).toBeInstanceOf(
      WorkerNotFoundFault
    );
    expect(
      mapUnknownToWorkerFault(new Error("DATABASE_URL is required"))
    ).toBeInstanceOf(WorkerValidationFault);
    expect(
      mapUnknownToWorkerFault(new Error("connection ECONNREFUSED"))
    ).toBeInstanceOf(WorkerUnavailableFault);
    expect(mapUnknownToWorkerFault(new Error("boom"))).toBeInstanceOf(
      WorkerDependencyFault
    );
  });

  it("maps abort-like errors to cancel", () => {
    expect(
      mapUnknownToWorkerFault(new DOMException("Aborted", "AbortError"))
    ).toBeInstanceOf(WorkerCancelFault);
  });
});

describe("runWorkerPromise", () => {
  it("returns the success value", async () => {
    await expect(runWorkerPromise(Effect.succeed("ok"))).resolves.toBe("ok");
  });

  it("rethrows typed WorkerFaults", async () => {
    const pending = runWorkerPromise(
      Effect.fail(new WorkerNotFoundFault({ message: "missing" }))
    );
    await expect(pending).rejects.toBeInstanceOf(WorkerNotFoundFault);
    await expect(pending).rejects.toMatchObject({ _tag: "not_found" });
  });

  it("maps an aborted signal to WorkerCancelFault", async () => {
    const controller = new AbortController();
    const pending = runWorkerPromise(
      fromWorkerPromise(
        () =>
          // oxlint-disable-next-line promise/avoid-new -- Deliberately pending call verifies abort/cancel mapping.
          new Promise(() => {})
      ),
      { signal: controller.signal }
    );
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(WorkerCancelFault);
    await expect(pending).rejects.toMatchObject({ _tag: "cancel" });
  });

  it("maps a rejected Error through fromWorkerPromise", async () => {
    const pending = runWorkerPromise(
      fromWorkerPromise(() => Promise.reject(new Error("payload not found")))
    );
    await expect(pending).rejects.toBeInstanceOf(WorkerNotFoundFault);
  });

  it("isWorkerFault recognises thrown faults", async () => {
    try {
      await runWorkerPromise(
        Effect.fail(new WorkerValidationFault({ message: "bad" }))
      );
      expect.unreachable();
    } catch (error) {
      expect(isWorkerFault(error)).toBe(true);
    }
  });
});

describe("Trigger durability contract (Slice 10)", () => {
  it("preserves Trigger maxAttempts and leaves Motian backfill Effect-free", async () => {
    const drainSource = await Bun.file(
      new URL("../tasks/drain-outbox.ts", import.meta.url)
    ).text();
    const enrichScheduleSource = await Bun.file(
      new URL("../tasks/schedule-enrich-incomplete.ts", import.meta.url)
    ).text();
    const backfillSource = await Bun.file(
      new URL("../tasks/backfill-neon-v1.ts", import.meta.url)
    ).text();
    const triggerConfig = await Bun.file(
      new URL("../../trigger.config.ts", import.meta.url)
    ).text();

    // CTP-479: default path still calls native runDrainOutbox; Effect is flag-gated.
    expect(drainSource).toContain("maxAttempts: 2");
    expect(drainSource).toContain("return runDrainOutbox(payload)");
    expect(drainSource).toContain("isEffectWorkerEnabled");
    expect(backfillSource).toContain("maxAttempts: 1");
    expect(backfillSource.includes('from "effect"')).toBe(false);
    expect(backfillSource.includes("from 'effect'")).toBe(false);
    expect(backfillSource.includes("runWorkerPromise")).toBe(false);
    expect(backfillSource.includes("fromWorkerPromise")).toBe(false);
    expect(backfillSource.includes("WorkerFault")).toBe(false);
    expect(enrichScheduleSource).toContain("schedules.task");
    expect(enrichScheduleSource).toContain('id: "schedule-enrich-incomplete"');
    expect(enrichScheduleSource.includes("runWorkerPromise")).toBe(false);
    expect(triggerConfig).toContain('runtime: "bun"');
    expect(triggerConfig.toLowerCase().includes("effect")).toBe(false);
  });
});
