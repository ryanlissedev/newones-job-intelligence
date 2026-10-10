import { describe, expect, it } from "bun:test";

import {
  MOTIAN_V1_BRON_BINDINGS,
  MOTIAN_V1_PLATFORMS,
  MOTIAN_V1_SOURCE_PLATFORMS,
  normalizeMotianPlatform,
  resolveMotianV1Binding,
  sourcePlatformsForMotianV1,
} from "./motian-v1-bindings";

describe("Motian v1 platform bindings", () => {
  it("defines exactly seven Motian Neon platforms", () => {
    expect(MOTIAN_V1_PLATFORMS).toEqual([
      "nationalevacaturebank",
      "opdrachtoverheid",
      "mipublic",
      "flextender",
      "striive",
      "werkzoeken",
      "starapple-nl",
    ]);
    expect(MOTIAN_V1_BRON_BINDINGS).toHaveLength(7);
  });

  it("maps each platform slug to a stable bron_id", () => {
    const expected = {
      flextender: "00000000-0000-4000-8000-000000000033",
      mipublic: "00000000-0000-4000-8000-000000000032",
      nationalevacaturebank: "00000000-0000-4000-8000-000000000030",
      opdrachtoverheid: "00000000-0000-4000-8000-0000000000ad",
      "starapple-nl": "00000000-0000-4000-8000-000000000036",
      striive: "00000000-0000-4000-8000-000000000008",
      werkzoeken: "00000000-0000-4000-8000-000000000035",
    } as const;
    for (const platform of MOTIAN_V1_PLATFORMS) {
      const binding = resolveMotianV1Binding(MOTIAN_V1_BRON_BINDINGS, platform);
      expect(binding?.platform).toBe(platform);
      expect(binding?.bronId).toBe(expected[platform]);
    }
  });

  it("normalizes legacy starapple slug to starapple-nl", () => {
    expect(normalizeMotianPlatform("starapple")).toBe("starapple-nl");
    const binding = resolveMotianV1Binding(
      MOTIAN_V1_BRON_BINDINGS,
      "starapple"
    );
    expect(binding?.platform).toBe("starapple-nl");
  });

  it("selects both canonical and legacy Starapple source slugs", () => {
    expect(MOTIAN_V1_SOURCE_PLATFORMS).toContain("starapple-nl");
    expect(MOTIAN_V1_SOURCE_PLATFORMS).toContain("starapple");
    expect(sourcePlatformsForMotianV1(["starapple-nl"])).toEqual([
      "starapple-nl",
      "starapple",
    ]);
  });
});
