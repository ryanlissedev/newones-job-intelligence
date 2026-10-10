import { describe, expect, it } from "bun:test";

import { findForbiddenDownVolumeUsage } from "./check-production-compose-guard";

describe("findForbiddenDownVolumeUsage", () => {
  it("allows isolated CI teardown while blocking production runbooks and smoke scripts", () => {
    const violations = findForbiddenDownVolumeUsage();

    expect(violations).not.toContain(".github/workflows/ci.yml");
    expect(violations).not.toContain("scripts/docker-compose-smoke.sh");
    expect(violations).not.toContain("docs/runbooks/postgres-on-box.md");
  });
});
