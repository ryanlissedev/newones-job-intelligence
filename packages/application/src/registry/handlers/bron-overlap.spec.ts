import { describe, expect, it } from "bun:test";

import { createTestSliceADeps } from "../test-fixtures";
import { createGetBronOverlapHandler } from "./bron-overlap";

describe("get_bron_overlap handler", () => {
  it("returns reader payload without inventing rates", async () => {
    const handler = createGetBronOverlapHandler({
      ...createTestSliceADeps(),
      bronOverlapReader: {
        bronOverlap: () =>
          Promise.resolve({
            overlapGroepCount: 2,
            perBron: [
              {
                bronId: "11111111-1111-4111-8111-111111111111",
                naam: "Hero",
                overlappingAanvragen: 3,
                share: 0.25,
                totalAanvragen: 12,
              },
            ],
            topGroups: [
              {
                aanvraagCount: 4,
                bronCount: 2,
                bronIds: [
                  "11111111-1111-4111-8111-111111111111",
                  "22222222-2222-4222-8222-222222222222",
                ],
                bronNamen: ["Hero", "Other"],
                groepId: "33333333-3333-4333-8333-333333333333",
              },
            ],
          }),
      },
    });

    const result = await handler();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.overlapGroepCount).toBe(2);
    expect(result.value.topGroups[0]?.bronNamen).toEqual(["Hero", "Other"]);
    expect(result.value.perBron[0]?.share).toBe(0.25);
  });

  it("fails closed when reader is missing", async () => {
    const handler = createGetBronOverlapHandler({
      ...createTestSliceADeps(),
      bronOverlapReader: undefined,
    });
    await expect(handler()).rejects.toThrow(/BronOverlapReader unavailable/u);
  });
});
