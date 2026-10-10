import { describe, expect, test } from "bun:test";

import {
  resolveCanonicalContractType,
  toCanonicalContractType,
  toCanonicalEmploymentTypes,
} from "./contract-type";

describe("toCanonicalContractType", () => {
  test("maps detachering-family tokens to detachering", () => {
    expect(toCanonicalContractType("detachering")).toBe("detachering");
    expect(toCanonicalContractType("  Detachering  ")).toBe("detachering");
  });

  test("maps interim-family tokens (temporary, tijdelijk, interim) to interim", () => {
    expect(toCanonicalContractType("temporary")).toBe("interim");
    expect(toCanonicalContractType("tijdelijk")).toBe("interim");
    expect(toCanonicalContractType("interim")).toBe("interim");
  });

  test("leaves the generic inhuur umbrella token unknown (ambiguous contract form)", () => {
    expect(toCanonicalContractType("inhuur")).toBeNull();
  });

  test("maps freelance-family tokens (contractor, zzp) case-insensitively to freelance", () => {
    expect(toCanonicalContractType("CONTRACTOR")).toBe("freelance");
    expect(toCanonicalContractType("contractor")).toBe("freelance");
    expect(toCanonicalContractType("freelance")).toBe("freelance");
    expect(toCanonicalContractType("zzp")).toBe("freelance");
  });

  test("maps vast-family tokens to vast", () => {
    expect(toCanonicalContractType("permanent")).toBe("vast");
    expect(toCanonicalContractType("vast")).toBe("vast");
    expect(toCanonicalContractType("vast dienstverband")).toBe("vast");
  });

  test("returns null for hours/employment tokens that are not a contract form", () => {
    expect(toCanonicalContractType("FULL_TIME")).toBeNull();
    expect(toCanonicalContractType("PART_TIME")).toBeNull();
    expect(toCanonicalContractType("OTHER")).toBeNull();
  });

  test("returns null for empty, null and undefined input", () => {
    expect(toCanonicalContractType("")).toBeNull();
    expect(toCanonicalContractType(null)).toBeNull();
    expect(toCanonicalContractType()).toBeNull();
  });
});

describe("resolveCanonicalContractType", () => {
  test("uses the first populated direct alias", () => {
    expect(
      resolveCanonicalContractType("FULL_TIME", "CONTRACTOR", "TEMPORARY")
    ).toBeNull();
    expect(resolveCanonicalContractType("", "CONTRACTOR", "TEMPORARY")).toBe(
      "freelance"
    );
  });

  test("canonicalizes comma-separated employment types", () => {
    expect(
      resolveCanonicalContractType(null, null, "TEMPORARY, FULL_TIME")
    ).toBe("interim");
    expect(
      resolveCanonicalContractType(null, null, "TEMPORARY, CONTRACTOR")
    ).toBeNull();
  });
});

describe("toCanonicalEmploymentTypes", () => {
  test("maps a single contract-form token the same as toCanonicalContractType", () => {
    expect(toCanonicalEmploymentTypes(["CONTRACTOR"])).toBe("freelance");
    expect(toCanonicalEmploymentTypes(["TEMPORARY"])).toBe("interim");
  });

  test("ignores hours tokens and resolves a lone contract-form token in a mixed array", () => {
    expect(toCanonicalEmploymentTypes(["TEMPORARY", "FULL_TIME"])).toBe(
      "interim"
    );
    expect(
      toCanonicalEmploymentTypes(["CONTRACTOR", "PART_TIME", "OTHER"])
    ).toBe("freelance");
  });

  test("returns null when two distinct contract forms are published (ambiguous)", () => {
    expect(
      toCanonicalEmploymentTypes(["TEMPORARY", "CONTRACTOR", "FULL_TIME"])
    ).toBeNull();
  });

  test("returns null for hours-only arrays and empty input", () => {
    expect(toCanonicalEmploymentTypes(["FULL_TIME", "PART_TIME"])).toBeNull();
    expect(toCanonicalEmploymentTypes(["OTHER"])).toBeNull();
    expect(toCanonicalEmploymentTypes([])).toBeNull();
  });
});
