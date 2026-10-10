import { describe, expect, it } from "bun:test";

import type { JsonValue } from "@ji/application/normalise";

import {
  evaluateContractCoverage,
  evaluateProvinceCoverage,
  evaluatePublicationDateCoverage,
  evaluateSkillsCoverage,
} from "./field-coverage";

const bron = (value: Record<string, JsonValue>): Record<string, JsonValue> =>
  value;

describe("evaluateContractCoverage", () => {
  it("counts canonical contracttype values", () => {
    expect(evaluateContractCoverage(bron({ contracttype: "vast" }))).toBe(true);
    expect(evaluateContractCoverage(bron({ contracttype: "interim" }))).toBe(
      true
    );
  });

  it("counts canonical contract_type values", () => {
    expect(evaluateContractCoverage(bron({ contract_type: "freelance" }))).toBe(
      true
    );
    expect(
      evaluateContractCoverage(bron({ contract_type: "detachering" }))
    ).toBe(true);
  });

  it("counts employment_type when at least one token maps to a contract form", () => {
    expect(
      evaluateContractCoverage(bron({ employment_type: "TEMPORARY" }))
    ).toBe(true);
    expect(
      evaluateContractCoverage(
        bron({ employment_type: "TEMPORARY, FULL_TIME" })
      )
    ).toBe(true);
    expect(
      evaluateContractCoverage(
        bron({ employment_type: "CONTRACTOR, PART_TIME" })
      )
    ).toBe(true);
  });

  it("rejects employment_type tokens that do not describe contract form", () => {
    expect(
      evaluateContractCoverage(bron({ employment_type: "FULL_TIME" }))
    ).toBe(false);
    expect(
      evaluateContractCoverage(
        bron({ employment_type: "PART_TIME, FULL_TIME" })
      )
    ).toBe(false);
    expect(evaluateContractCoverage(bron({ employment_type: "OTHER" }))).toBe(
      false
    );
  });

  it("rejects conflicting contract forms in employment_type", () => {
    expect(
      evaluateContractCoverage(
        bron({ employment_type: "TEMPORARY, CONTRACTOR" })
      )
    ).toBe(false);
  });

  it("uses the same first-live-alias precedence as curation", () => {
    expect(
      evaluateContractCoverage(
        bron({ contract_type: "CONTRACTOR", contracttype: "FULL_TIME" })
      )
    ).toBe(false);
    expect(
      evaluateContractCoverage(
        bron({ contract_type: "CONTRACTOR", contracttype: "cleared" })
      )
    ).toBe(false);
    expect(
      evaluateContractCoverage(
        bron({ contract_type: "CONTRACTOR", contracttype: "" })
      )
    ).toBe(true);
  });

  it("ignores sentinel and blank values", () => {
    expect(evaluateContractCoverage(bron({ contracttype: "unknown" }))).toBe(
      false
    );
    expect(evaluateContractCoverage(bron({ contracttype: "" }))).toBe(false);
    expect(evaluateContractCoverage(bron({ contracttype: "   " }))).toBe(false);
  });

  it("returns false when no contract keys are present", () => {
    expect(evaluateContractCoverage(bron({}))).toBe(false);
    expect(evaluateContractCoverage(bron({ tarief: "40" }))).toBe(false);
  });
});

describe("evaluatePublicationDateCoverage", () => {
  it("counts valid ISO dates across all aliases", () => {
    expect(
      evaluatePublicationDateCoverage(bron({ publicatiedatum: "2024-06-12" }))
    ).toBe(true);
    expect(
      evaluatePublicationDateCoverage(
        bron({ gepubliceerd_op: "2024-06-12T08:30:00Z" })
      )
    ).toBe(true);
    expect(
      evaluatePublicationDateCoverage(bron({ publicatie_datum: "2024-06-12" }))
    ).toBe(true);
    expect(
      evaluatePublicationDateCoverage(
        bron({ json_ld_date_posted: "2024-06-12T08:30:00+02:00" })
      )
    ).toBe(true);
  });

  it("rejects malformed or non-date values", () => {
    expect(
      evaluatePublicationDateCoverage(bron({ publicatiedatum: "asap" }))
    ).toBe(false);
    expect(
      evaluatePublicationDateCoverage(bron({ publicatiedatum: "2024-13-01" }))
    ).toBe(false);
    expect(
      evaluatePublicationDateCoverage(bron({ publicatiedatum: "unknown" }))
    ).toBe(false);
    expect(evaluatePublicationDateCoverage(bron({ publicatiedatum: "" }))).toBe(
      false
    );
  });
});

describe("evaluateProvinceCoverage", () => {
  it("counts canonical Dutch province names", () => {
    expect(evaluateProvinceCoverage(bron({ provincie: "Noord-Holland" }))).toBe(
      true
    );
    expect(evaluateProvinceCoverage(bron({ provincie: "Utrecht" }))).toBe(true);
  });

  it("rejects non-canonical province values", () => {
    expect(evaluateProvinceCoverage(bron({ provincie: "Amsterdam" }))).toBe(
      false
    );
    expect(evaluateProvinceCoverage(bron({ provincie: "Noord Holland" }))).toBe(
      false
    );
    expect(evaluateProvinceCoverage(bron({ provincie: "unknown" }))).toBe(
      false
    );
    expect(evaluateProvinceCoverage(bron({ provincie: "" }))).toBe(false);
  });
});

describe("evaluateSkillsCoverage", () => {
  it("counts non-empty normalised skill arrays", () => {
    expect(
      evaluateSkillsCoverage(bron({ skills: ["Java", "Kubernetes"] }))
    ).toBe(true);
  });

  it("rejects arrays that normalise to empty", () => {
    expect(evaluateSkillsCoverage(bron({ skills: [] }))).toBe(false);
    expect(evaluateSkillsCoverage(bron({ skills: ["", "  ", 42, {}] }))).toBe(
      false
    );
  });

  it("rejects non-array values", () => {
    expect(evaluateSkillsCoverage(bron({ skills: "Java, Kubernetes" }))).toBe(
      false
    );
    expect(evaluateSkillsCoverage(bron({ skills: { 0: "Java" } }))).toBe(false);
  });
});
