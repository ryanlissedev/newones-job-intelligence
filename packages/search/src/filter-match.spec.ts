import { describe, expect, it } from "bun:test";

import {
  matchesSearchFilters,
  publicatiedatumTotExclusiveUtc,
} from "./filter-match";
import type { SearchDocument } from "./types";
import { SEARCH_DOCUMENT_PARITY_DEFAULTS } from "./types";

const document = (overrides: Partial<SearchDocument> = {}): SearchDocument => ({
  ...SEARCH_DOCUMENT_PARITY_DEFAULTS,
  beschrijving: "body",
  bronId: "bron",
  contracttype: null,
  id: "1",
  laatstGezienOp: new Date("2026-08-01T00:00:00.000Z"),
  locatieLand: "NL",
  skills: [],
  status: "active",
  tariefMax: null,
  tariefMin: null,
  titel: "title",
  ...overrides,
});

describe("matchesSearchFilters CTP-493", () => {
  it("compiles inclusive publicatiedatumTot as next UTC day exclusive", () => {
    expect(
      publicatiedatumTotExclusiveUtc(new Date("2026-08-10T15:30:00Z"))
    ).toEqual(new Date(Date.UTC(2026, 7, 11)));
  });

  it("does not invent province or end-client matches", () => {
    expect(matchesSearchFilters(document(), { provincies: ["Utrecht"] })).toBe(
      false
    );
    expect(
      matchesSearchFilters(document({ eindklantNaam: null }), {
        // no eindklant filter yet; provincie stays null
        provincies: ["Utrecht"],
      })
    ).toBe(false);
  });

  it("requires explicit skills on the document", () => {
    expect(matchesSearchFilters(document(), { skills: ["Java"] })).toBe(false);
    expect(
      matchesSearchFilters(document({ skills: ["Java"] }), { skills: ["Java"] })
    ).toBe(true);
  });
});
