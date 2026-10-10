import { describe, expect, test } from "bun:test";

import { normaliseSkills } from "./skills";

describe("normaliseSkills", () => {
  test("trims, drops empties and dedupes case-insensitively in source order", () => {
    expect(normaliseSkills(["Java", " java ", "", "Kubernetes"])).toEqual([
      "Java",
      "Kubernetes",
    ]);
  });

  test("keeps the first spelling of a duplicate", () => {
    expect(normaliseSkills(["  Terraform", "TERRAFORM"])).toEqual([
      "Terraform",
    ]);
  });

  test("drops entries longer than 80 characters instead of truncating", () => {
    const tooLong = "a".repeat(81);
    expect(normaliseSkills([tooLong, "a".repeat(80)])).toEqual([
      "a".repeat(80),
    ]);
  });

  test("caps the list at 40 entries", () => {
    const many = Array.from({ length: 50 }, (_, index) => `skill-${index}`);
    const skills = normaliseSkills(many);
    expect(skills).toHaveLength(40);
    expect(skills.at(-1)).toBe("skill-39");
  });

  test("ignores non-string entries", () => {
    expect(normaliseSkills(["React", 42, null, { name: "Go" }])).toEqual([
      "React",
    ]);
  });

  test("returns an empty list for anything that is not an array", () => {
    expect(normaliseSkills()).toEqual([]);
    expect(normaliseSkills(null)).toEqual([]);
    expect(normaliseSkills("Java, Kubernetes")).toEqual([]);
    expect(normaliseSkills({ skills: ["Java"] })).toEqual([]);
  });
});
