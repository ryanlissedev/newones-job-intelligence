import { describe, expect, it } from "bun:test";

import { parseArguments } from "./curation-backlog-repair";

describe("parseArguments", () => {
  it("defaults to bounded report mode", () => {
    expect(parseArguments(["--bron", "bron-uuid"])).toEqual({
      apply: false,
      bronId: "bron-uuid",
      ingestQuiesced: false,
      limit: 1000,
    });
  });

  it("accepts apply only with ingest quiesced", () => {
    expect(
      parseArguments([
        "--bron",
        "bron-uuid",
        "--apply",
        "--ingest-quiesced",
        "--limit",
        "500",
      ])
    ).toEqual({
      apply: true,
      bronId: "bron-uuid",
      ingestQuiesced: true,
      limit: 500,
    });
  });

  it("rejects apply without quiescence", () => {
    expect(() =>
      parseArguments(["--bron", "bron-uuid", "--apply"])
    ).toThrowError(/quiesced/u);
  });

  it("rejects quiescence in report mode", () => {
    expect(() =>
      parseArguments(["--bron", "bron-uuid", "--ingest-quiesced"])
    ).toThrowError(/quiesced/u);
  });

  it("requires --bron", () => {
    expect(() => parseArguments([])).toThrowError(/--bron/u);
  });

  it("rejects unknown flags", () => {
    expect(() =>
      parseArguments(["--bron", "bron-uuid", "--requeue-all"])
    ).toThrowError(/unsupported/iu);
  });

  it("rejects duplicate options", () => {
    expect(() => parseArguments(["--bron", "a", "--bron", "b"])).toThrowError(
      /duplicate/iu
    );
  });

  it("bounds --limit", () => {
    expect(() =>
      parseArguments(["--bron", "bron-uuid", "--limit", "0"])
    ).toThrowError(/--limit/u);
    expect(() =>
      parseArguments(["--bron", "bron-uuid", "--limit", "10001"])
    ).toThrowError(/--limit/u);
    expect(() =>
      parseArguments(["--bron", "bron-uuid", "--limit", "abc"])
    ).toThrowError(/--limit/u);
  });
});
