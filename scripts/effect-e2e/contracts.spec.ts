import { describe, expect, it } from "bun:test";

import { readEffectE2eConfig } from "./contracts";

const validEnvironment = {
  EFFECT_E2E_API_URL: "http://localhost:3000",
  EFFECT_E2E_ARTIFACT_DIR: "/tmp/effect-e2e/run-abc",
  EFFECT_E2E_BASE_URL: "http://localhost:3001",
  EFFECT_E2E_CANARY_DIGEST: "a".repeat(64),
  EFFECT_E2E_CANARY_ID: "11111111-1111-4111-8111-111111111111",
  EFFECT_E2E_DATABASE_NAME: "ji_effect_e2e",
  EFFECT_E2E_DATABASE_URL:
    "postgresql://ji_app:synthetic-only@postgres:5432/ji_effect_e2e",
  EFFECT_E2E_DB_MARKER: "effect-e2e-run-abc",
  EFFECT_E2E_DISPOSABLE_DB: "1",
  EFFECT_E2E_EXPECTED_SHA: "b".repeat(40),
  EFFECT_E2E_PRIVATE_DIR: "/tmp/effect-e2e-private/run-abc",
  EFFECT_E2E_SYNTHETIC: "1",
  JI_EFFECT_DB: "1",
  JI_EFFECT_SERVER: "1",
  JI_EFFECT_WORKER: "1",
  PERF_EFFECT_SPANS: "1",
};

describe("Effect E2E environment contract", () => {
  it("reads the explicit disposable database contract", () => {
    expect(readEffectE2eConfig(validEnvironment)).toMatchObject({
      canaryId: validEnvironment.EFFECT_E2E_CANARY_ID,
      databaseName: validEnvironment.EFFECT_E2E_DATABASE_NAME,
      runId: "run-abc",
    });
  });

  it("accepts the runner-shaped lowercase run identity and marker", () => {
    const runId = "20260919t095543z-31034";
    const canaryId = validEnvironment.EFFECT_E2E_CANARY_ID;

    expect(
      readEffectE2eConfig({
        ...validEnvironment,
        EFFECT_E2E_ARTIFACT_DIR: `/tmp/effect-e2e/${runId}`,
        EFFECT_E2E_CANARY_ID: canaryId,
        EFFECT_E2E_DB_MARKER: `effect-e2e-${runId}-${canaryId.slice(0, 12)}`,
        EFFECT_E2E_PRIVATE_DIR: `/tmp/effect-e2e-private/${runId}`,
      })
    ).toMatchObject({ runId });
  });

  it("refuses a missing disposable database guard", () => {
    expect(() =>
      readEffectE2eConfig({
        ...validEnvironment,
        EFFECT_E2E_DISPOSABLE_DB: "0",
      })
    ).toThrow("EFFECT_E2E_DISPOSABLE_DB=1");
  });

  it("refuses a non-synthetic lane", () => {
    expect(() =>
      readEffectE2eConfig({
        ...validEnvironment,
        EFFECT_E2E_SYNTHETIC: "0",
      })
    ).toThrow("EFFECT_E2E_SYNTHETIC=1");
  });

  it("refuses a lane with an Effect surface disabled", () => {
    expect(() =>
      readEffectE2eConfig({
        ...validEnvironment,
        JI_EFFECT_WORKER: "0",
      })
    ).toThrow("JI_EFFECT_WORKER=1");
  });

  it("refuses fixture mode even when the target is disposable", () => {
    expect(() =>
      readEffectE2eConfig({
        ...validEnvironment,
        NEXT_PUBLIC_USE_FIXTURES: "1",
      })
    ).toThrow("NEXT_PUBLIC_USE_FIXTURES=1");
  });

  it("refuses private credentials inside the working tree", () => {
    expect(() =>
      readEffectE2eConfig({
        ...validEnvironment,
        EFFECT_E2E_PRIVATE_DIR: `${process.cwd()}/.artifacts/private`,
      })
    ).toThrow("outside the working tree");
  });
});
