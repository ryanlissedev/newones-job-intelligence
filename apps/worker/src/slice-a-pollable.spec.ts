import { describe, expect, it } from "bun:test";

import type {
  BronPersistence,
  BronRegisterRecord,
} from "@ji/application/bronnen";
import { SOURCES } from "@ji/application/sources";

import { listPollableSliceABronnen } from "./slice-a-pollable";

const recordFor = (slug: keyof typeof SOURCES): BronRegisterRecord => ({
  actief: true,
  bronId: SOURCES[slug].bronId,
  categorie: "overig",
  crawlDelayMs: 0,
  interval: "*/15 * * * *",
  lastRun: null,
  loginVereist: false,
  mappingRef: null,
  method: "html",
  naam: SOURCES[slug].naam,
  rateLimitPerMinute: 60,
  retentionDays: 90,
  secretRef: null,
  status: "ready",
  voorwaardenStatus: "toegestaan",
});

describe("listPollableSliceABronnen", () => {
  it("excludes all four paused sources while retaining an active source", async () => {
    const records = [
      recordFor("hays"),
      recordFor("tenderned"),
      recordFor("linkedin"),
      recordFor("intermediair"),
      recordFor("inhuurdesk"),
    ];
    const persistence: BronPersistence = {
      activate: () => Promise.reject(new Error("unused")),
      create: () => Promise.reject(new Error("unused")),
      findById: () => Promise.reject(new Error("unused")),
      list: () => Promise.resolve(records),
    };

    const result = await listPollableSliceABronnen({
      bronPersistence: persistence,
    });

    expect(result.map((entry) => entry.bronSlug)).toEqual(["inhuurdesk"]);
    expect(result[0]?.bronId).toBe(SOURCES.inhuurdesk.bronId);
  });
});
