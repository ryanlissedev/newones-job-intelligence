import { describe, expect, it } from "bun:test";

import type {
  BackfillFailureDiagnostic,
  BackfillFailureEvidence,
} from "@ji/application/backfill";

import {
  formatBackfillFailureDiagnostic,
  resolveConcurrency,
} from "./backfill-neon-v1";

const failure: BackfillFailureEvidence = {
  code: "PROVENANCE_WRITE_FAILED",
  phase: "provenance",
};

class PostgresError extends Error {
  override readonly name = "PostgresError";
}

describe("formatBackfillFailureDiagnostic", () => {
  it("prints row context and redacts postgres URLs from the cause message", () => {
    const cause = new PostgresError(
      "duplicate at postgresql://example.invalid/db via postgres://fallback.invalid/db"
    );
    const diagnostic: BackfillFailureDiagnostic = {
      error: new Error("backfill wrapper", { cause }),
      platform: "nationalevacaturebank",
      sourceJobId: "v1-job-000001",
    };

    const formatted = formatBackfillFailureDiagnostic(failure, diagnostic);

    expect(formatted).toBe(
      'backfill failure code=PROVENANCE_WRITE_FAILED phase=provenance platform="nationalevacaturebank" sourceJobId="v1-job-000001" cause="PostgresError" message="duplicate at <url> via <url>"'
    );
    expect(formatted).not.toContain("example.invalid");
    expect(formatted).not.toContain("fallback.invalid");
  });

  it("does not stringify non-Error causes or allow multiline diagnostics", () => {
    const diagnostic: BackfillFailureDiagnostic = {
      error: new Error("backfill wrapper", {
        cause: { payload: "must-not-be-printed" },
      }),
      platform: "source\nplatform",
      sourceJobId: "row\ridentifier",
    };

    const formatted = formatBackfillFailureDiagnostic(failure, diagnostic);

    expect(formatted).toContain('platform="source platform"');
    expect(formatted).toContain('sourceJobId="row identifier"');
    expect(formatted).toContain('cause="UnknownError"');
    expect(formatted).toContain('message="No underlying error"');
    expect(formatted).not.toContain("must-not-be-printed");
    expect(formatted.split("\n")).toHaveLength(1);
  });
});

describe("resolveConcurrency", () => {
  it("defaults to 16 and accepts the bounded maximum", () => {
    const original = process.env.NEON_V1_CONCURRENCY;
    try {
      delete process.env.NEON_V1_CONCURRENCY;
      expect(resolveConcurrency()).toBe(16);
      process.env.NEON_V1_CONCURRENCY = "64";
      expect(resolveConcurrency()).toBe(64);
    } finally {
      if (original === undefined) {
        delete process.env.NEON_V1_CONCURRENCY;
      } else {
        process.env.NEON_V1_CONCURRENCY = original;
      }
    }
  });

  it("rejects values outside the fail-closed bound", () => {
    const original = process.env.NEON_V1_CONCURRENCY;
    try {
      for (const invalid of ["0", "65", "1.5", "not-a-number"]) {
        process.env.NEON_V1_CONCURRENCY = invalid;
        expect(() => resolveConcurrency()).toThrow(
          "NEON_V1_CONCURRENCY must be an integer between 1 and 64"
        );
      }
    } finally {
      if (original === undefined) {
        delete process.env.NEON_V1_CONCURRENCY;
      } else {
        process.env.NEON_V1_CONCURRENCY = original;
      }
    }
  });
});
