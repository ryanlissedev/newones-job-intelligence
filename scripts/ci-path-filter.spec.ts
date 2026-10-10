import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import picomatch from "picomatch";

const workflowPath = path.join(process.cwd(), ".github/workflows/ci.yml");

const readCodePatterns = (): string[] => {
  const workflow = readFileSync(workflowPath, "utf-8");
  const codeFilter = workflow.match(
    /filters: \|\n\s+code:\n(?<patterns>(?:\s+- "[^"]+"\n)+)/u
  );

  if (!codeFilter?.groups?.patterns) {
    throw new Error("Could not find the CI code path filter");
  }

  return [
    ...codeFilter.groups.patterns.matchAll(/- "(?<pattern>[^"]+)"/gu),
  ].map((match) => {
    if (!match.groups?.pattern) {
      throw new Error("Could not parse a CI code path filter pattern");
    }

    return match.groups.pattern;
  });
};

const isCodeChange = (changedPaths: string[]): boolean => {
  const codePatterns = readCodePatterns();
  const matchers = codePatterns.map((pattern) =>
    picomatch(pattern, { dot: true })
  );

  return changedPaths.some((changedPath) =>
    matchers.some((matches) => matches(changedPath))
  );
};

describe("CI code path filter", () => {
  it("classifies benchmark-only changes as code", () => {
    expect(isCodeChange(["benchmarks/search/profile.json"])).toBe(true);
  });

  it("classifies script-only changes as code", () => {
    expect(isCodeChange(["scripts/replay-run.ts"])).toBe(true);
  });

  it("classifies Docker build-context and Turbo config changes as code", () => {
    expect(isCodeChange([".dockerignore"])).toBe(true);
    expect(isCodeChange(["turbo.json"])).toBe(true);
  });

  it("classifies spec-only changes anywhere in the repository as code", () => {
    expect(isCodeChange(["standalone/contract.spec.ts"])).toBe(true);
  });

  it("classifies Playwright-only E2E changes as code", () => {
    expect(isCodeChange(["e2e/live-jobs/read-only.playwright.ts"])).toBe(true);
  });

  it("classifies live Playwright config changes as code", () => {
    expect(isCodeChange(["playwright.live.config.ts"])).toBe(true);
  });

  it("keeps documentation-only changes out of the full suite", () => {
    expect(isCodeChange(["docs/ci-path-filter.md"])).toBe(false);
  });
});
