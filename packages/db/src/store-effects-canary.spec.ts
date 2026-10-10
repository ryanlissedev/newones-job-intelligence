import { afterEach, describe, expect, it } from "bun:test";

import { applyDbStoreEffectCanary } from "./store-effects";

afterEach(() => {
  delete process.env.JI_EFFECT_DB;
});

describe("applyDbStoreEffectCanary (CTP-479)", () => {
  it("returns the same store references when JI_EFFECT_DB is OFF", () => {
    delete process.env.JI_EFFECT_DB;
    const aanvragen = {
      getById: () => Promise.resolve(null),
      getByIds: () => Promise.resolve([]),
      listVersies: () => Promise.resolve([]),
    };
    const out = applyDbStoreEffectCanary({ aanvragen });
    expect(out.aanvragen).toBe(aanvragen);
  });

  it("wraps stores when JI_EFFECT_DB=1 (new object, same behaviour surface)", async () => {
    process.env.JI_EFFECT_DB = "1";
    const aanvragen = {
      getById: () => Promise.resolve(null),
      getByIds: () => Promise.resolve([]),
      listVersies: () => Promise.resolve([]),
    };
    const out = applyDbStoreEffectCanary({ aanvragen });
    expect(out.aanvragen).not.toBe(aanvragen);
    expect(out.aanvragen).toBeDefined();
    expect(await out.aanvragen?.getById("x")).toBeNull();
  });
});
