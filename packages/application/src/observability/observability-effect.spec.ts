import { describe, expect, it } from "bun:test";

import type { BronHealthInput } from "./bron-health";
import {
  deriveBronHealth,
  evaluateSilence,
  parseCronExpression,
  runDeriveBronHealth,
  runEvaluateSilence,
  runParseCronExpression,
} from "./index";

describe("observability Effect dual-path", () => {
  it("parseCronExpressionEffect matches native", async () => {
    const expression = "*/15 * * * *";
    expect(await runParseCronExpression(expression)).toEqual(
      parseCronExpression(expression)
    );
    expect(await runParseCronExpression("not-a-cron")).toBeNull();
  });

  it("evaluateSilenceEffect matches native non-silence", async () => {
    const input = {
      baseline: [],
      bronId: "bron-1",
      bronNaam: "TenderNed",
      detectedAt: new Date("2026-09-01T12:00:00.000Z"),
      httpStatus: 200,
      lastSuccessAt: new Date("2026-09-01T11:00:00.000Z"),
      metrics: {
        changed: 1,
        closed: 0,
        error: 0,
        found: 10,
        new: 2,
        rejected: 0,
        unchanged: 7,
      },
    };
    expect(await runEvaluateSilence(input)).toEqual(evaluateSilence(input));
  });

  it("deriveBronHealthEffect matches native for inactive bron", async () => {
    const now = new Date("2026-09-01T12:00:00.000Z");
    const input: BronHealthInput = {
      actief: false,
      bronId: "bron-1",
      failedRuns24h: 0,
      interval: "*/15 * * * *",
      lastFailureClass: null,
      lastFailureCode: null,
      lastRunAt: null,
      lastRunCircuitStatus: null,
      lastRunStatus: null,
      naam: "TenderNed",
      recentRuns: [],
      silenceAlertOpen: false,
    };
    expect(await runDeriveBronHealth(input, now)).toEqual(
      deriveBronHealth(input, now)
    );
  });
});
