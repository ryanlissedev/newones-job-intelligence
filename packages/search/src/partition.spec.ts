import { describe, expect, it } from "bun:test";

import { AANVRAAG_LIFECYCLE } from "@ji/domain";

import {
  ACTIVE_RECENT_DAYS,
  documentPartition,
  otherPartition,
  partitionInScope,
  partitionTable,
  resolveSearchPartition,
  scopeTables,
} from "./partition";
import type { SearchDocument } from "./types";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const DAY = 86_400_000;
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY);

describe("resolveSearchPartition (RJC-383)", () => {
  it("is lifecycle-driven by default: closed and stale archive, active and unknown stay active, whatever the recency", () => {
    expect(ACTIVE_RECENT_DAYS).toBeNull();
    const table: Record<string, [boolean, number, string][]> = {};
    for (const status of AANVRAAG_LIFECYCLE) {
      table[status] = [];
      for (const sluitingsdatumPassed of [false, true]) {
        for (const age of [0, 29, 31, 400]) {
          table[status].push([
            sluitingsdatumPassed,
            age,
            resolveSearchPartition(
              status,
              sluitingsdatumPassed,
              daysAgo(age),
              NOW
            ),
          ]);
        }
      }
    }
    for (const status of ["closed", "stale"] as const) {
      expect(table[status]?.map((row) => row[2])).toEqual(
        Array.from({ length: 8 }, () => "archive")
      );
    }
    for (const status of ["active", "unknown"] as const) {
      for (const row of table[status] ?? []) {
        expect(row[2]).toBe(row[0] ? "archive" : "active");
      }
    }
  });

  it("honours a recency window when one is given: open but not seen within it archives, exactly at the edge stays", () => {
    const window = 30;
    expect(
      resolveSearchPartition("active", false, daysAgo(29), NOW, window)
    ).toBe("active");
    expect(
      resolveSearchPartition("active", false, daysAgo(30), NOW, window)
    ).toBe("active");
    expect(
      resolveSearchPartition("active", false, daysAgo(31), NOW, window)
    ).toBe("archive");
    expect(
      resolveSearchPartition("unknown", false, daysAgo(31), NOW, window)
    ).toBe("archive");
    // The window never rescues a closed document.
    expect(
      resolveSearchPartition("closed", false, daysAgo(0), NOW, window)
    ).toBe("archive");
  });

  it("documentPartition derives sluitingsdatumPassed from the document at `now`; missing deadlines never expire", () => {
    const base: SearchDocument = {
      beschrijving: "",
      bronId: "b",
      contracttype: null,
      eindklantNaam: null,
      id: "d",
      laatstGezienOp: daysAgo(1),
      locatieLand: "NL",
      opdrachtgeverNaam: null,
      provincie: null,
      publicatiedatum: null,
      skills: [],
      status: "active",
      tariefEenheid: null,
      tariefMax: null,
      tariefMin: null,
      titel: "t",
      urenPerWeekMax: null,
      urenPerWeekMin: null,
      werkvorm: null,
    };
    expect(documentPartition(base, NOW)).toBe("active");
    expect(documentPartition({ ...base, sluitingsdatum: null }, NOW)).toBe(
      "active"
    );
    expect(
      documentPartition({ ...base, sluitingsdatum: daysAgo(-1) }, NOW)
    ).toBe("active");
    expect(
      documentPartition({ ...base, sluitingsdatum: daysAgo(1) }, NOW)
    ).toBe("archive");
    expect(documentPartition({ ...base, status: "stale" }, NOW)).toBe(
      "archive"
    );
  });

  it("names tables and scopes deterministically", () => {
    expect(partitionTable("aanvragen", "active")).toBe("aanvragen_active");
    expect(partitionTable("aanvragen", "archive")).toBe("aanvragen_archive");
    expect(scopeTables("aanvragen", "active")).toBe("aanvragen_active");
    expect(scopeTables("aanvragen", "all")).toBe(
      "aanvragen_active,aanvragen_archive"
    );
    expect(otherPartition("active")).toBe("archive");
    expect(otherPartition("archive")).toBe("active");
    expect(partitionInScope("archive", "active")).toBe(false);
    expect(partitionInScope("archive", "all")).toBe(true);
    expect(partitionInScope("active", "active")).toBe(true);
  });
});
