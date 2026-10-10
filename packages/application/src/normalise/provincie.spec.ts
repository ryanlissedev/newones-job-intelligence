import { describe, expect, test } from "bun:test";

import {
  findProvincieInText,
  NL_PROVINCIES,
  toCanonicalProvincie,
} from "./provincie";

describe("toCanonicalProvincie", () => {
  test("accepts every canonical name unchanged", () => {
    for (const provincie of NL_PROVINCIES) {
      expect(toCanonicalProvincie(provincie)).toBe(provincie);
    }
  });

  test("maps source spellings to the canonical name", () => {
    expect(toCanonicalProvincie("Fryslân")).toBe("Friesland");
    expect(toCanonicalProvincie("noord holland")).toBe("Noord-Holland");
    expect(toCanonicalProvincie("N-Brabant")).toBe("Noord-Brabant");
    expect(toCanonicalProvincie(" Provincie Utrecht ")).toBe("Utrecht");
    expect(toCanonicalProvincie("Provincie: Utrecht")).toBe("Utrecht");
    expect(toCanonicalProvincie("ZH")).toBe("Zuid-Holland");
  });

  test("returns null for cities, empty and unknown text", () => {
    expect(toCanonicalProvincie("Amsterdam")).toBeNull();
    expect(toCanonicalProvincie("Enschede")).toBeNull();
    expect(toCanonicalProvincie("")).toBeNull();
    expect(toCanonicalProvincie(null)).toBeNull();
    expect(toCanonicalProvincie()).toBeNull();
    expect(toCanonicalProvincie("Randstad")).toBeNull();
  });
});

describe("findProvincieInText", () => {
  test("finds a province inside a title or location string", () => {
    expect(findProvincieInText("Projectleider (Zuid-Holland)")).toBe(
      "Zuid-Holland"
    );
    expect(findProvincieInText("Amsterdam, Noord-Holland")).toBe(
      "Noord-Holland"
    );
    expect(findProvincieInText("Medewerker Noord Brabant 36 uur")).toBe(
      "Noord-Brabant"
    );
  });

  test("takes the last match, since source text puts the city before the province (Striive)", () => {
    expect(findProvincieInText("Zeeland Noord-Brabant")).toBe("Noord-Brabant");
    expect(findProvincieInText("Utrecht Overijssel")).toBe("Overijssel");
  });

  test("returns null when only a city or nothing is named", () => {
    expect(findProvincieInText("Senior developer Amsterdam")).toBeNull();
    expect(findProvincieInText("Projectleider NB 32 uur")).toBeNull();
    expect(findProvincieInText("Regio ZH/NH")).toBeNull();
    expect(findProvincieInText("")).toBeNull();
    expect(findProvincieInText(null)).toBeNull();
  });
});
