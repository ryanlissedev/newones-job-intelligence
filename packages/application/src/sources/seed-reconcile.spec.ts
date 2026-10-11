import { describe, expect, it } from "bun:test";

import { MOTIAN_V1_BRON_SEEDS } from "../backfill";
import { SOURCES } from "./registry";
import { reconcileSourceSeeds, summariseSeedReconcile } from "./seed-reconcile";
import type { BronSeedRow } from "./seed-reconcile";

const definitions = Object.values(SOURCES);

/** The 11 code sources with no prod bron row (MEASURED.md, 2026-10-09). */
const MEASURED_MISSING = new Set([
  "alliander",
  "circle8",
  "enexis",
  "essent",
  "gasunie",
  "indeed",
  "linkedin",
  "mercell",
  "stedin",
  "tennet",
  "werk-nl",
]);
const MEASURED_INACTIVE = new Set(["intermediair", "prounity", "rabobank"]);
/** The 5 prod rows with no code source: deferred v1-backfill feed bronnen. */
const MEASURED_EXTRA = [
  "Flextender",
  "MI Public",
  "Nationale Vacaturebank",
  "Starapple",
  "Werkzoeken",
];

/** Mirrors the measured prod registry: every row is reviewed `toegestaan`. */
const measuredProdRows = (): BronSeedRow[] => [
  ...definitions
    .filter((definition) => !MEASURED_MISSING.has(definition.slug))
    .map((definition) => ({
      actief: !MEASURED_INACTIVE.has(definition.slug),
      id: definition.bronId,
      naam: definition.naam,
      status: "ready",
      voorwaardenStatus: "toegestaan" as const,
    })),
  ...MEASURED_EXTRA.map((naam) => ({
    actief: false,
    id: crypto.randomUUID(),
    naam,
    status: "deferred",
    voorwaardenStatus: "toegestaan" as const,
  })),
];

describe("reconcileSourceSeeds", () => {
  it("reports the measured prod drift: missing rows, unknown rows, reviewed terms and inactive rows", () => {
    const rows = measuredProdRows();
    const report = reconcileSourceSeeds(definitions, rows);

    expect(report.totals).toEqual({ codeSources: 49, dbRows: 43 });
    expect(report.inSync).toBe(false);
    expect(report.missingRows.map((row) => row.slug)).toEqual(
      [...MEASURED_MISSING].toSorted()
    );
    expect(report.unknownRows.map((row) => row.naam)).toEqual(MEASURED_EXTRA);
    expect(report.naamConflicts).toEqual([]);
    expect(report.inactiveRows.map((row) => row.bronId).toSorted()).toEqual(
      definitions
        .filter((definition) => MEASURED_INACTIVE.has(definition.slug))
        .map((definition) => definition.bronId)
        .toSorted()
    );
    // 37 code seeds say te_toetsen. 11 of them have no row, and the other 26 rows were reviewed to toegestaan.
    const teToetsen = definitions.filter(
      (definition) => definition.seed.voorwaardenStatus === "te_toetsen"
    );
    expect(teToetsen).toHaveLength(37);
    expect(report.voorwaardenDrift).toHaveLength(26);
    expect(
      report.voorwaardenDrift.every(
        (entry) => entry.code === "te_toetsen" && entry.db === "toegestaan"
      )
    ).toBe(true);
    expect(summariseSeedReconcile(report)).toMatchObject({
      codeSources: 49,
      dbRows: 43,
      inSync: false,
      voorwaardenDrift: 26,
      voorwaardenDriftByPair: { "te_toetsen->toegestaan": 26 },
    });
  });

  it("is a pure report: it never mutates the rows it was given", () => {
    const rows = measuredProdRows();
    const before = structuredClone(rows);
    reconcileSourceSeeds(definitions, rows);
    expect(rows).toEqual(before);
  });

  it("is in sync when every code source has a row with its seed terms and nothing extra exists", () => {
    const rows: BronSeedRow[] = definitions.map((definition) => ({
      actief: true,
      id: definition.bronId,
      naam: definition.naam,
      status:
        definition.seed.voorwaardenStatus === "toegestaan"
          ? "ready"
          : "deferred",
      voorwaardenStatus: definition.seed.voorwaardenStatus,
    }));
    const report = reconcileSourceSeeds(definitions, rows);
    expect(report.inSync).toBe(true);
    expect(report.missingRows).toEqual([]);
    expect(report.unknownRows).toEqual([]);
    expect(report.voorwaardenDrift).toEqual([]);
  });

  it("no longer reports the v1-backfill rows as Stedin/Gasunie conflicts: those sources have their own ids", () => {
    // Before 2026-10-11 the v1 seeds (Werkzoeken …035, Starapple …036) sat on the
    // Stedin/Gasunie registry ids. Stedin/Gasunie now use …046/…047.
    const rows: BronSeedRow[] = MOTIAN_V1_BRON_SEEDS.map((seed) => ({
      actief: false,
      id: seed.bronId,
      naam: seed.naam,
      status: "deferred",
      voorwaardenStatus: "toegestaan",
    }));
    const report = reconcileSourceSeeds(definitions, rows);
    expect(
      report.naamConflicts.filter(
        (entry) => entry.slug === "gasunie" || entry.slug === "stedin"
      )
    ).toEqual([]);
    expect(
      report.missingRows
        .filter((entry) => entry.slug === "gasunie" || entry.slug === "stedin")
        .map((entry) => entry.bronId)
    ).toEqual([SOURCES.gasunie.bronId, SOURCES.stedin.bronId]);
  });

  it("still flags any row that occupies a code source's bronId under another naam", () => {
    const rows: BronSeedRow[] = [
      {
        actief: false,
        id: SOURCES.stedin.bronId,
        naam: "Werkzoeken",
        status: "deferred",
        voorwaardenStatus: "toegestaan",
      },
    ];
    const report = reconcileSourceSeeds(definitions, rows);
    expect(
      report.naamConflicts.filter((entry) => entry.slug === "stedin")
    ).toEqual([
      {
        bronId: SOURCES.stedin.bronId,
        codeNaam: SOURCES.stedin.naam,
        dbNaam: "Werkzoeken",
        slug: "stedin",
      },
    ]);
    expect(report.inSync).toBe(false);
    expect(
      report.voorwaardenDrift.some((entry) => entry.slug === "stedin")
    ).toBe(false);
  });
});
