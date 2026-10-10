import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  assertFixtureOnly,
  buildDryRunArtifact,
  loadTemplate,
  transferredGitMetadata,
  validateBaselineArtifact,
} from "./harness";
import { measureNativeCohort } from "./measure";
import { readToolchainPins } from "./versions";

const ROOT = path.resolve(import.meta.dir, "../..");

describe("effect-baseline harness", () => {
  test("template is fixture-only and forbids blind write retries", () => {
    const template = loadTemplate();
    expect(template.workload.fixtureOnly).toBe(true);
    expect(template.workload.liveProviders).toBe(false);
    expect(template.retryOwnership.blindWriteRetries).toBe(false);
    expect(template.retryOwnership.requestMaxAttempts).toBe(3);
    expect(template.retryOwnership.triggerMaxAttempts).toBe(2);
    assertFixtureOnly(template);
  });

  test("toolchain pins reflect first-party Effect RC pin after CTP-455", () => {
    const pins = readToolchainPins("1.4.0");
    expect(pins.bunPackageManager).toBe("bun@1.3.14");
    expect(pins.typescript).toBe("6.0.3");
    expect(pins.typesBun).toBe("1.4.0");
    expect(pins.effectDirect).toBe("catalog:");
    expect(pins.effectTransitive).toMatch(/^4\.0\.0-rc\./u);
    expect(pins.compatibilityNotes.some((n) => /CTP-455/u.test(n))).toBe(true);
  });

  test("dry-run artifact validates and keeps metrics unmeasured", () => {
    const artifact = buildDryRunArtifact("cold");
    validateBaselineArtifact(artifact);
    expect(artifact.status).toBe("dry-run");
    expect(artifact.issue).toBe("CTP-454");
    expect(artifact.cohort.runKind).toBe("cold");
    expect(artifact.workload.adapters).toContain("json-ld-listing");
    expect(artifact.workload.adapters).toContain("spott-get");
    expect(artifact.metrics.latencyMs).toEqual({
      failures: 0,
      n: 0,
      p50: null,
      p95: null,
    });
    expect(artifact.git.headSha).toMatch(/^[0-9a-f]{40}$/u);
  });

  test("schema and ADR files exist for CTP-454", () => {
    for (const relative of [
      "docs/adr/ADR-0013-effectts-platform-baseline.md",
      "docs/effectts/json-ld-spott-wire-contract.md",
      "scripts/effect-baseline/baseline-artifact.schema.json",
      "scripts/effect-baseline/baseline-artifact.template.json",
    ]) {
      const contents = readFileSync(path.join(ROOT, relative), "utf-8");
      expect(contents.length).toBeGreaterThan(20);
    }
  });

  test("assertFixtureOnly rejects live providers", () => {
    const template = loadTemplate();
    expect(() =>
      assertFixtureOnly({
        ...template,
        workload: { ...template.workload, liveProviders: true },
      })
    ).toThrow(/refuses live providers/u);
  });
});

describe("effect-baseline measure (native fixtures)", () => {
  test("measured warm cohort fills metrics and keeps production off", async () => {
    const artifact = await measureNativeCohort({
      iterations: 2,
      runKind: "warm",
      warmup: 1,
    });
    expect(artifact.status).toBe("measured");
    expect(artifact.workload.fixtureOnly).toBe(true);
    expect(artifact.workload.liveProviders).toBe(false);
    expect(artifact.metrics.latencyMs.n).toBeGreaterThanOrEqual(2);
    expect(artifact.metrics.latencyMs.p50).not.toBeNull();
    expect(artifact.metrics.directDependencyCount).toBeGreaterThan(0);
    expect(artifact.metrics.adapterLocObserve).toBeGreaterThan(0);
    expect(artifact.reviewRubric.retryOwnerIdentifiable).toBe(true);
    expect(artifact.notes).toContain("blocked");
    validateBaselineArtifact(artifact);
  }, 120_000);
});

describe("effect-baseline git identity without a workspace", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";

  test("uses the transferred shadow identity", () => {
    expect(
      transferredGitMetadata({
        CRABBOX_SOURCE_GIT_SHA: sha,
        CRABBOX_SOURCE_GIT_STATE: "clean",
      })
    ).toEqual({ branch: null, dirty: false, headSha: sha });
  });

  test("refuses to invent an identity", () => {
    expect(() => transferredGitMetadata({})).toThrow(
      "No git workspace and no valid CRABBOX_SOURCE_GIT_SHA/CRABBOX_SOURCE_GIT_STATE"
    );
    expect(() =>
      transferredGitMetadata({
        CRABBOX_SOURCE_GIT_SHA: "abc",
        CRABBOX_SOURCE_GIT_STATE: "clean",
      })
    ).toThrow("No git workspace");
  });
});
