import { describe, expect, it } from "bun:test";

import { enrichIncompleteDefaults } from "./enrich-incomplete-schema";
import { scheduleEnrichIncompletePayload } from "./schedule-enrich-incomplete";

describe("schedule-enrich-incomplete", () => {
  it("keeps dryRun true and LLM residual false with a small batch", () => {
    expect(scheduleEnrichIncompletePayload).toEqual({
      batchSize: enrichIncompleteDefaults.batchSize,
      dryRun: true,
      enableLlmResidual: false,
    });
    expect(scheduleEnrichIncompletePayload.batchSize).toBeLessThanOrEqual(50);
    expect(scheduleEnrichIncompletePayload.batchSize).toBeGreaterThanOrEqual(
      25
    );
  });

  it("declares an Amsterdam cron schedule for enrich-incomplete", async () => {
    const source = await Bun.file(
      new URL("schedule-enrich-incomplete.ts", import.meta.url)
    ).text();
    expect(source).toContain("schedules.task");
    expect(source).toContain('id: "schedule-enrich-incomplete"');
    expect(source).toContain('pattern: "5 * * * *"');
    expect(source).toContain('timezone: "Europe/Amsterdam"');
    expect(source).toContain("enrichIncompleteTask.trigger");
    expect(source).toContain('concurrencyKey: "enrich-incomplete"');
    // Ops flip is documented, not live.
    expect(source).toContain("Ops flip for live writes");
    expect(source).toMatch(/dryRun:\s*enrichIncompleteDefaults\.dryRun/u);
  });
});
