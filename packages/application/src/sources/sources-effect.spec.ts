import { describe, expect, it } from "bun:test";

import {
  isSupportedBronSlug,
  resolveSourceByNaam,
  runIsSupportedBronSlug,
  runListSupportedBronSlugs,
  runResolveSourceByNaam,
  SUPPORTED_BRON_SLUGS,
} from "./index";

describe("sources Effect dual-path", () => {
  it("isSupportedBronSlugEffect matches native", async () => {
    expect(await runIsSupportedBronSlug("tenderned")).toBe(
      isSupportedBronSlug("tenderned")
    );
    expect(await runIsSupportedBronSlug("nope")).toBe(false);
  });

  it("resolveSourceByNaamEffect matches native", async () => {
    expect(await runResolveSourceByNaam("TenderNed")).toEqual(
      resolveSourceByNaam("TenderNed")
    );
  });

  it("listSupportedBronSlugsEffect returns registry slugs", async () => {
    expect(await runListSupportedBronSlugs()).toEqual(SUPPORTED_BRON_SLUGS);
  });
});
