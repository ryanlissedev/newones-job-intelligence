import { describe, expect, it } from "bun:test";

import { CLEARED, CLEARED_BRON_MARKER_KEY } from "@ji/domain";

import {
  durableClearedIntersects,
  readDurableClearedKeys,
} from "./cleared-markers";

describe("readDurableClearedKeys", () => {
  it("reads durable _cleared markers without requiring CLEARED strings", () => {
    const keys = readDurableClearedKeys({
      [CLEARED_BRON_MARKER_KEY]: {
        locatie_tekst: true,
        tarief_min: true,
      },
      other: "ok",
    });
    expect(keys.has("locatie_tekst")).toBe(true);
    expect(keys.has("tarief_min")).toBe(true);
    expect(keys.has("other")).toBe(false);
  });

  it("also treats transient CLEARED string values as cleared", () => {
    const keys = readDurableClearedKeys({
      contracttype: CLEARED,
      werkvorm: "Hybride",
    });
    expect(keys.has("contracttype")).toBe(true);
    expect(keys.has("werkvorm")).toBe(false);
  });
});

describe("durableClearedIntersects", () => {
  it("returns true when any alias is marked", () => {
    const keys = readDurableClearedKeys({
      [CLEARED_BRON_MARKER_KEY]: { locatie_tekst: true },
    });
    expect(
      durableClearedIntersects(keys, [
        "locatie",
        "locatie_tekst",
        "locatieTekst",
      ])
    ).toBe(true);
  });
});
