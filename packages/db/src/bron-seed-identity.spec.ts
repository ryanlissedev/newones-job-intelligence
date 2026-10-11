import { describe, expect, it } from "bun:test";

import {
  assertSeedHitSameBron,
  BronSeedIdCollisionError,
} from "./bron-seed-identity";

const ID = "00000000-0000-4000-8000-000000000035";

describe("assertSeedHitSameBron", () => {
  it("accepts an inserted seed (no existing row to compare)", () => {
    expect(() =>
      assertSeedHitSameBron({
        bronId: ID,
        existingNaam: null,
        seedNaam: "Stedin",
      })
    ).not.toThrow();
  });

  it("accepts the same bron, ignoring case and surrounding whitespace like lower(naam)", () => {
    expect(() =>
      assertSeedHitSameBron({
        bronId: ID,
        existingNaam: " stedin ",
        seedNaam: "Stedin",
      })
    ).not.toThrow();
  });

  it("throws a named collision error when another bron holds the id", () => {
    const collision = (() => {
      try {
        assertSeedHitSameBron({
          bronId: ID,
          existingNaam: "Werkzoeken",
          seedNaam: "Stedin",
        });
        return null;
      } catch (error) {
        return error instanceof BronSeedIdCollisionError ? error : null;
      }
    })();
    expect(collision).toBeInstanceOf(BronSeedIdCollisionError);
    expect(collision?.bronId).toBe(ID);
    expect(collision?.dbNaam).toBe("Werkzoeken");
    expect(collision?.seedNaam).toBe("Stedin");
    expect(collision?.message).toContain(
      'held by "Werkzoeken" but the seed is "Stedin"'
    );
  });
});
