import { describe, expect, it } from "bun:test";

import {
  activateBron,
  canTransitionBronStatus,
  shouldScheduleBronPoll,
  validateBronConfig,
} from "./bron-config";
import type { BronConfigInput } from "./bron-config";

const baseConfig = (): BronConfigInput => ({
  bronId: "bron-1",
  crawlDelayMs: 1000,
  interval: "*/15 * * * *",
  loginVereist: false,
  mappingRef: "fixtures/connectors/tenderned/mapping.json",
  method: "json-api",
  naam: "TenderNed",
  rateLimitPerMinute: 30,
  secretRef: null,
  status: "deferred",
  voorwaardenStatus: "toegestaan",
});

describe("bron config validation", () => {
  it("accepts json-api TenderNed without secret_ref", () => {
    const issues = validateBronConfig(baseConfig());
    expect(issues).toHaveLength(0);
  });

  it("rejects a naam past the bron_naam_lower_uidx cap (CTP-500)", () => {
    expect(
      validateBronConfig({ ...baseConfig(), naam: "n".repeat(201) })
    ).toContainEqual({
      field: "naam",
      message: "naam must be at most 200 characters",
    });
    expect(
      validateBronConfig({ ...baseConfig(), naam: "n".repeat(200) })
    ).toHaveLength(0);
  });

  it("requires secret_ref for login connectors", () => {
    const issues = validateBronConfig({
      ...baseConfig(),
      loginVereist: true,
      method: "playwright",
      secretRef: null,
    });

    expect(issues.some((issue) => issue.field === "secretRef")).toBe(true);
  });

  it("requires integer rate limits and crawl delays", () => {
    expect(
      validateBronConfig({
        ...baseConfig(),
        rateLimitPerMinute: 1.5,
      })
    ).toContainEqual({
      field: "rateLimitPerMinute",
      message: "rateLimitPerMinute must be a positive integer",
    });
    expect(
      validateBronConfig({
        ...baseConfig(),
        crawlDelayMs: 0.5,
      })
    ).toContainEqual({
      field: "crawlDelayMs",
      message: "crawlDelayMs must be a nonnegative integer",
    });
  });

  it("accepts a zero crawl delay", () => {
    expect(validateBronConfig({ ...baseConfig(), crawlDelayMs: 0 })).toEqual(
      []
    );
  });

  it("blocks verboden bron from becoming ready", () => {
    expect(canTransitionBronStatus("deferred", "ready", "verboden")).toBe(
      false
    );
  });
});

describe("bron scheduling", () => {
  it("does not schedule polls for deferred bronnen", () => {
    expect(
      shouldScheduleBronPoll({
        status: "deferred",
        voorwaardenStatus: "toegestaan",
      })
    ).toBe(false);
  });

  it("schedules polls only for ready bronnen with toegestaan voorwaarden", () => {
    expect(
      shouldScheduleBronPoll({
        status: "ready",
        voorwaardenStatus: "toegestaan",
      })
    ).toBe(true);
  });
});

describe("activateBron", () => {
  it("blocks activation without a passing test-import", () => {
    const result = activateBron({
      config: { ...baseConfig(), bronId: "bron-1" },
      testImportPassed: false,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("test-import");
    }
  });

  it("activates when test-import passed and voorwaarden are toegestaan", () => {
    const result = activateBron({
      config: { ...baseConfig(), bronId: "bron-1" },
      testImportPassed: true,
    });

    expect(result).toEqual({ ok: true, status: "ready" });
  });
});
