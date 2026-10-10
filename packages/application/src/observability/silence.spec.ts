import { describe, expect, it } from "bun:test";

import { emptyRunMetrics } from "@ji/connectors";

import { createMemorySliceAStores } from "../registry/stores/memory";
import type { RunBaselineSample } from "./silence";
import {
  DEFAULT_VOLUME_DROP_THRESHOLD,
  SOURCE_SILENCE_RUNBOOK_PATH,
  buildSilenceDedupeKey,
  evaluateSilence,
  observeConnectorRunSilence,
} from "./silence";
import { createSilenceAlertWriter } from "./writer";

const bronId = "00000000-0000-4000-8000-000000000010";
const bronNaam = "TenderNed";

const baselineSamples = (): RunBaselineSample[] => {
  const detectedAt = new Date("2026-08-29T12:00:00.000Z");
  return Array.from({ length: 7 }, (_, index) => ({
    at: new Date(detectedAt.getTime() - (index + 1) * 86_400_000),
    changed: 4,
    found: 40,
    new: 8,
  }));
};

const zeroActivityMetrics = () => ({
  ...emptyRunMetrics(),
  found: 10,
});

describe("AE7 source silence detection", () => {
  it("emits one silence event when a 200 run has zero new/changed and volume dropped past threshold", () => {
    const event = evaluateSilence({
      baseline: baselineSamples(),
      bronId,
      bronNaam,
      detectedAt: new Date("2026-08-29T12:00:00.000Z"),
      httpStatus: 200,
      lastSuccessAt: new Date("2026-08-28T12:00:00.000Z"),
      metrics: zeroActivityMetrics(),
      thresholdRatio: DEFAULT_VOLUME_DROP_THRESHOLD,
    });

    expect(event).not.toBeNull();
    expect(event?.dedupeKey).toBe(buildSilenceDedupeKey(bronId));
    expect(event?.bron).toBe(bronId);
    expect(event?.detectietijd).toBe("2026-08-29T12:00:00.000Z");
    expect(event?.laatsteSucces).toBe("2026-08-28T12:00:00.000Z");
    expect(event?.drempel).toBe(DEFAULT_VOLUME_DROP_THRESHOLD);
    expect(event?.eigenaar).toMatch(/@/u);
    expect(event?.runbook).toBe(SOURCE_SILENCE_RUNBOOK_PATH);
    expect(event?.evidence.current_new).toBe(0);
    expect(event?.evidence.current_changed).toBe(0);
    expect(event?.evidence.http_status).toBe(200);
  });

  it("dedupes a second identical silence event", async () => {
    const stores = createMemorySliceAStores();
    const writer = createSilenceAlertWriter(stores);
    const sharedInput = {
      baseline: baselineSamples(),
      bronId,
      bronNaam,
      detectedAt: new Date("2026-08-29T12:00:00.000Z"),
      httpStatus: 200,
      lastSuccessAt: new Date("2026-08-28T12:00:00.000Z"),
      metrics: zeroActivityMetrics(),
      writer,
    };

    const first = await observeConnectorRunSilence(sharedInput);
    const second = await observeConnectorRunSilence(sharedInput);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(first.alertId).toBe(second.alertId);
    expect(await stores.alerts.listOpen()).toHaveLength(1);

    const [alert] = await stores.alerts.listOpen();
    expect(alert?.dedupeKey).toBe(buildSilenceDedupeKey(bronId));
    expect(alert?.evidence.detectietijd).toBe("2026-08-29T12:00:00.000Z");
    expect(alert?.evidence.laatste_succes).toBe("2026-08-28T12:00:00.000Z");
    expect(alert?.evidence.runbook).toBe(SOURCE_SILENCE_RUNBOOK_PATH);
    expect(alert?.evidence.eigenaar).toMatch(/@/u);
    expect(alert?.evidence.drempel).toBe(DEFAULT_VOLUME_DROP_THRESHOLD);
    expect(await stores.bronHealth.getByBronId(bronId)).toMatchObject({
      silenceAlertOpen: true,
    });
  });

  it("does not emit when the connector reports new or changed records", () => {
    const event = evaluateSilence({
      baseline: baselineSamples(),
      bronId,
      bronNaam,
      detectedAt: new Date("2026-08-29T12:00:00.000Z"),
      httpStatus: 200,
      lastSuccessAt: new Date("2026-08-28T12:00:00.000Z"),
      metrics: {
        changed: 1,
        error: 0,
        found: 40,
        new: 0,
        rejected: 0,
        unchanged: 0,
      },
    });

    expect(event).toBeNull();
  });
});
