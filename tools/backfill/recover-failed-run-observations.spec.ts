import { describe, expect, it } from "bun:test";

import {
  classifyRunEligibility,
  parseArguments,
  RUN_LEVEL_FAILURE_CODES,
} from "./recover-failed-run-observations";

const RUN_ID = "0f6b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4";

describe("classifyRunEligibility", () => {
  it("accepts a cancelled run regardless of its counters", () => {
    expect(
      classifyRunEligibility({
        failureCode: null,
        fouten: 12,
        status: "cancelled",
      })
    ).toEqual({ eligible: true, status: "cancelled" });
  });

  it("accepts a failed run with zero record errors", () => {
    expect(
      classifyRunEligibility({
        failureCode: "FETCH_FAILED",
        fouten: 0,
        status: "failed",
      })
    ).toEqual({ eligible: true, status: "failed" });
  });

  it("accepts a failed run whose failure is run-level even with record errors", () => {
    for (const failureCode of RUN_LEVEL_FAILURE_CODES) {
      expect(
        classifyRunEligibility({ failureCode, fouten: 3, status: "failed" })
      ).toEqual({ eligible: true, status: "failed" });
    }
  });

  it("rejects a failed run with per-record errors", () => {
    expect(
      classifyRunEligibility({
        failureCode: "FETCH_FAILED",
        fouten: 1,
        status: "failed",
      })
    ).toEqual({ eligible: false, reason: "per_record_failure" });
    expect(
      classifyRunEligibility({
        failureCode: "OBSERVATION_WRITE_FAILED",
        fouten: 4,
        status: "failed",
      })
    ).toEqual({ eligible: false, reason: "per_record_failure" });
  });

  it("leaves succeeded and running runs to the poll path", () => {
    expect(
      classifyRunEligibility({
        failureCode: null,
        fouten: 0,
        status: "succeeded",
      })
    ).toEqual({ eligible: false, reason: "run_succeeded" });
    expect(
      classifyRunEligibility({
        failureCode: null,
        fouten: 0,
        status: "running",
      })
    ).toEqual({ eligible: false, reason: "run_still_running" });
  });
});

describe("parseArguments", () => {
  it("defaults to a bounded report", () => {
    expect(parseArguments(["--run", RUN_ID])).toEqual({
      apply: false,
      limit: 100,
      scrapeRunId: RUN_ID,
    });
  });

  it("accepts apply only with ingest quiesced", () => {
    expect(
      parseArguments([
        "--run",
        RUN_ID.toUpperCase(),
        "--apply",
        "--ingest-quiesced",
        "--limit",
        "500",
      ])
    ).toEqual({ apply: true, limit: 500, scrapeRunId: RUN_ID });
  });

  it("rejects apply without quiescence and quiescence without apply", () => {
    expect(() => parseArguments(["--run", RUN_ID, "--apply"])).toThrowError(
      /quiesced/u
    );
    expect(() =>
      parseArguments(["--run", RUN_ID, "--ingest-quiesced"])
    ).toThrowError(/quiesced/u);
  });

  it("requires a uuid run id", () => {
    expect(() => parseArguments([])).toThrowError(/--run/u);
    expect(() => parseArguments(["--run", "latest"])).toThrowError(/uuid/u);
  });

  it("bounds the limit to the curation attempt ceiling", () => {
    expect(() =>
      parseArguments(["--run", RUN_ID, "--limit", "501"])
    ).toThrowError(/500/u);
    expect(() =>
      parseArguments(["--run", RUN_ID, "--limit", "0"])
    ).toThrowError(/500/u);
  });

  it("rejects unknown and duplicate flags", () => {
    expect(() => parseArguments(["--run", RUN_ID, "--bron", "x"])).toThrowError(
      /unsupported/iu
    );
    expect(() =>
      parseArguments(["--run", RUN_ID, "--run", RUN_ID])
    ).toThrowError(/duplicate/iu);
  });
});
