import { describe, expect, it } from "bun:test";

import { PostgresFtsFallbackEngine } from "./postgres-fts-fallback";
import type { SearchDocument } from "./types";

const makeDocument = (id: string): SearchDocument => ({
  beschrijving: "beschrijving",
  bronId: "bron-1",
  contracttype: null,
  eindklantNaam: null,
  id,
  laatstGezienOp: new Date("2026-01-01T00:00:00.000Z"),
  locatieLand: "NL",
  opdrachtgeverNaam: null,
  provincie: null,
  publicatiedatum: null,
  skills: [],
  status: "active",
  tariefEenheid: null,
  tariefMax: null,
  tariefMin: null,
  titel: "titel",
  urenPerWeekMax: null,
  urenPerWeekMin: null,
  werkvorm: null,
});

describe("PostgresFtsFallbackEngine filter-only browse (RJC-430)", () => {
  it("applies list and range filters before matching a null AST", async () => {
    const engine = new PostgresFtsFallbackEngine(undefined, [
      makeDocument("wrong-source"),
      {
        ...makeDocument("rate-too-low"),
        bronId: "bron-2",
        status: "stale",
        tariefMax: 80,
      },
      {
        ...makeDocument("wanted"),
        bronId: "bron-2",
        status: "active",
        tariefMax: 120,
      },
    ]);

    const result = await engine.search({
      ast: null,
      filters: {
        bronIds: ["bron-2"],
        status: ["active"],
        tariefMin: 100,
      },
      limit: 10,
      offset: 0,
    });

    expect(result.hits.map((hit) => hit.id)).toEqual(["wanted"]);
    expect(result.total).toBe(1);
  });
});

describe("PostgresFtsFallbackEngine tie order (RJC-396)", () => {
  it("breaks ties in codepoint order, not locale-aware collation order", async () => {
    // "a" (0x61) sorts after "A" (0x41) by codepoint, the OPPOSITE of
    // case-insensitive locale collation order — see ast-hash.spec.ts for
    // the same divergence asserted directly on compareCodepoints.
    const engine = new PostgresFtsFallbackEngine(undefined, [
      makeDocument("a"),
      makeDocument("A"),
    ]);

    const result = await engine.search({
      ast: null,
      filters: {},
      limit: 10,
      offset: 0,
    });

    expect(result.hits.map((hit) => hit.id)).toEqual(["A", "a"]);
  });
});
