import { afterEach, describe, expect, it } from "bun:test";

import {
  EFFECT_SURFACES,
  isEffectSurfaceEnabled,
  listEnabledEffectSurfaces,
  readEffectSurfaceFlags,
} from "./effect-flags";

const clearFlagEnv = (): void => {
  delete process.env.JI_EFFECT_DB;
  delete process.env.JI_EFFECT_PERF;
  delete process.env.JI_EFFECT_SERVER;
  delete process.env.JI_EFFECT_WORKER;
  delete process.env.PERF_EFFECT_SPANS;
};

afterEach(() => {
  clearFlagEnv();
});

describe("effect-flags (CTP-479)", () => {
  it("defaults every surface OFF", () => {
    clearFlagEnv();
    expect(readEffectSurfaceFlags()).toEqual({
      db: false,
      perf: false,
      server: false,
      worker: false,
    });
    expect(listEnabledEffectSurfaces()).toEqual([]);
  });

  it("enables only the flipped surface (canary)", () => {
    clearFlagEnv();
    process.env.JI_EFFECT_DB = "1";
    expect(isEffectSurfaceEnabled("db")).toBe(true);
    expect(isEffectSurfaceEnabled("server")).toBe(false);
    expect(listEnabledEffectSurfaces()).toEqual(["db"]);
  });

  it("treats non-1 values as OFF (rollback-safe)", () => {
    clearFlagEnv();
    process.env.JI_EFFECT_DB = "true";
    process.env.JI_EFFECT_SERVER = "0";
    process.env.JI_EFFECT_WORKER = "yes";
    process.env.PERF_EFFECT_SPANS = "on";
    for (const surface of EFFECT_SURFACES) {
      expect(isEffectSurfaceEnabled(surface)).toBe(false);
    }
  });

  it("accepts JI_EFFECT_PERF as alias for PERF_EFFECT_SPANS", () => {
    clearFlagEnv();
    process.env.JI_EFFECT_PERF = "1";
    expect(isEffectSurfaceEnabled("perf")).toBe(true);
  });
});
