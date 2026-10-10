import { describe, expect, it } from "bun:test";

import { parseArgs, parseRepeatCount } from "./replay-run";

describe("parseRepeatCount", () => {
  it("defaults to 1 when --repeat is not given", () => {
    expect(parseRepeatCount()).toBe(1);
  });

  it("accepts a positive integer", () => {
    expect(parseRepeatCount("2")).toBe(2);
    expect(parseRepeatCount("10")).toBe(10);
  });

  it("rejects zero, negative, and non-integer values", () => {
    expect(parseRepeatCount("0")).toBeUndefined();
    expect(parseRepeatCount("-1")).toBeUndefined();
    expect(parseRepeatCount("1.5")).toBeUndefined();
    expect(parseRepeatCount("abc")).toBeUndefined();
  });
});

describe("parseArgs", () => {
  const base = [
    "--bron",
    "tenderned",
    "--fixture",
    "tenderned/listing-page-0.json",
  ];

  it("defaults repeat to 1", () => {
    expect(parseArgs(base).repeat).toBe(1);
  });

  it("parses --repeat", () => {
    expect(parseArgs([...base, "--repeat", "3"]).repeat).toBe(3);
  });
});
