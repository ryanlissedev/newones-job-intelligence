import { describe, expect, it } from "bun:test";

import { BRON_REFERENTIE_MAX_LENGTH } from "@ji/domain";

import { boundBronReferentie } from "./bron-referentie";

const byteLength = (value: string): number =>
  new TextEncoder().encode(value).length;

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

describe("boundBronReferentie (CTP-500)", () => {
  it("leaves a reference under the cap unchanged so existing rows keep matching", () => {
    expect(boundBronReferentie("TN-100")).toBe("TN-100");
    expect(
      boundBronReferentie("interim-opdrachten/devops-engineer-1f2fde9f")
    ).toBe("interim-opdrachten/devops-engineer-1f2fde9f");
  });

  it("replaces a reference over the cap with a digest of stable length", () => {
    const oversized = "vacatures/".concat("x".repeat(3000));
    const bounded = boundBronReferentie(oversized);
    expect(bounded).toMatch(DIGEST_PATTERN);
    expect(byteLength(bounded)).toBe("sha256:".length + 64);
    expect(byteLength(bounded)).toBeLessThan(BRON_REFERENTIE_MAX_LENGTH);
    expect(boundBronReferentie(oversized)).toBe(bounded);
  });

  it("keeps two long references distinct when they differ only past the cap", () => {
    const prefix = "y".repeat(BRON_REFERENTIE_MAX_LENGTH + 10);
    expect(boundBronReferentie(`${prefix}a`)).not.toBe(
      boundBronReferentie(`${prefix}b`)
    );
  });

  it("leaves a reference exactly at the cap literal and digests one byte more", () => {
    const atCap = "z".repeat(BRON_REFERENTIE_MAX_LENGTH);
    expect(boundBronReferentie(atCap)).toBe(atCap);
    expect(boundBronReferentie(`${atCap}z`)).toMatch(DIGEST_PATTERN);
  });

  it("counts UTF-8 bytes rather than characters", () => {
    // Three bytes per euro sign: 600 chars fit, 700 chars do not.
    expect(boundBronReferentie("€".repeat(600))).toBe("€".repeat(600));
    expect(boundBronReferentie("€".repeat(700))).toMatch(DIGEST_PATTERN);
  });
});
