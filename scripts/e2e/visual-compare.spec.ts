import { describe, expect, it } from "bun:test";

import {
  decideVisualStatus,
  parseArgs,
  selectVisualArtifacts,
  shouldSkipCompare,
} from "./visual-compare";

describe("visual compare helpers", () => {
  it("parses compare arguments", () => {
    expect(
      parseArgs([
        "--suite",
        "fixtures",
        "--mode",
        "enforce",
        "--output",
        ".tmp-e2e",
        "--baseline-dir",
        "baselines",
        "--captured-only",
      ])
    ).toEqual({
      baselineDir: "baselines",
      capturedOnly: true,
      mode: "enforce",
      output: ".tmp-e2e",
      suite: "fixtures",
    });
  });

  it("selects the latest passed visual screenshot per name", () => {
    expect(
      selectVisualArtifacts({
        results: [
          {
            attempts: [
              {
                artifacts: [
                  { kind: "screenshot", path: "screenshots/visual-home.png" },
                ],
                status: "failed",
              },
              {
                artifacts: [
                  { kind: "screenshot", path: "screenshots/visual-home.png" },
                  { kind: "screenshot", path: "screenshots/visual-jobs.png" },
                ],
                status: "passed",
              },
            ],
          },
        ],
      })
    ).toEqual([
      { name: "home", path: "screenshots/visual-home.png" },
      { name: "jobs", path: "screenshots/visual-jobs.png" },
    ]);
  });

  it("decides report, update, and enforce statuses", () => {
    expect(decideVisualStatus("report", true, false, false)).toBe("seeded");
    expect(decideVisualStatus("update", true, true, false)).toBe("updated");
    expect(decideVisualStatus("enforce", true, false, false)).toBe(
      "missing-baseline"
    );
    expect(decideVisualStatus("enforce", true, true, false)).toBe("diff");
    expect(decideVisualStatus("report", false, true, false)).toBe(
      "missing-capture"
    );
    expect(decideVisualStatus("enforce", false, true, false, true)).toBe(
      "not-run"
    );
  });

  it("skips compare when the report has no visual captures", () => {
    expect(shouldSkipCompare([])).toBe(true);
    expect(shouldSkipCompare([{ name: "home", path: "visual-home.png" }])).toBe(
      false
    );
  });
});
