import { describe, expect, it } from "bun:test";

import {
  InMemoryObjectStore,
  InMemoryObservationRecorder,
} from "@ji/connectors";
import { Effect } from "effect";

import { runUseCasePromise, UseCaseCancelFault } from "../effect";
import { InMemoryCurateStore } from "../identity/store";
import {
  processRecordedObservations,
  runProcessRecordedObservations,
} from "./index";

describe("ingest Effect dual-path", () => {
  it("processRecordedObservationsEffect drains zero observations", async () => {
    const input = {
      bronId: "bron-1",
      bronSlug: "tenderned" as const,
      curateStore: new InMemoryCurateStore(),
      objectStore: new InMemoryObjectStore(),
      observationRecorder: new InMemoryObservationRecorder(),
    };
    await processRecordedObservations(input);
    await runProcessRecordedObservations(input);
  });

  it("cancels hung Effect via AbortSignal", async () => {
    const controller = new AbortController();
    const pending = runUseCasePromise(Effect.never, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(UseCaseCancelFault);
  });
});
