import type { VoorwaardenStatus } from "@ji/domain";

import type { SourceDefinition } from "./definition";

/** The operator-owned columns of one `curated.bron` row that the reconcile compares. */
export interface BronSeedRow {
  actief: boolean;
  id: string;
  naam: string;
  status: string;
  voorwaardenStatus: VoorwaardenStatus;
}

export interface SeedVoorwaardenDrift {
  bronId: string;
  code: VoorwaardenStatus;
  db: VoorwaardenStatus;
  slug: string;
}

/**
 * Differences between the code registry (`SOURCES`) and the bron rows in a
 * database. It is only a report: nothing here writes, and every
 * difference is resolved by an operator, never by re-seeding. Seeds are
 * insert-only (`ON CONFLICT DO NOTHING`), so a reviewed `toegestaan` row is
 * never re-gated by the code default `te_toetsen`.
 */
export interface SeedNaamConflict {
  bronId: string;
  codeNaam: string;
  dbNaam: string;
  slug: string;
}

export interface SeedReconcileReport {
  /**
   * Rows that carry a code source's bronId under a different naam. This is
   * either a rename or two bronnen sharing one id, e.g. the v1-backfill
   * Starapple/Werkzoeken rows on the Gasunie/Stedin ids. Such a source is not
   * counted as present, and its terms are not compared.
   */
  naamConflicts: SeedNaamConflict[];
  /** Rows that exist but are switched off (`actief = false`), so they are never polled. */
  inactiveRows: { bronId: string; naam: string; status: string }[];
  /** True when no row is missing, unknown, conflicting or drifted. Inactive rows are listed but do not count. */
  inSync: boolean;
  /** Code sources without a bron row: there is nothing to poll for them. */
  missingRows: { bronId: string; naam: string; slug: string }[];
  totals: { codeSources: number; dbRows: number };
  /** Bron rows with no code source (feed/manual/backfill bronnen, or removed sources). */
  unknownRows: { actief: boolean; bronId: string; naam: string }[];
  /** Rows whose reviewed `voorwaarden_status` differs from the code seed default. */
  voorwaardenDrift: SeedVoorwaardenDrift[];
}

const byKey =
  <T>(key: (value: T) => string) =>
  (left: T, right: T): number =>
    key(left).localeCompare(key(right));

export const reconcileSourceSeeds = (
  definitions: readonly SourceDefinition[],
  rows: readonly BronSeedRow[]
): SeedReconcileReport => {
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const naamConflicts = definitions
    .flatMap((definition) => {
      const row = rowsById.get(definition.bronId);
      return row && row.naam !== definition.naam
        ? [
            {
              bronId: definition.bronId,
              codeNaam: definition.naam,
              dbNaam: row.naam,
              slug: definition.slug,
            },
          ]
        : [];
    })
    .toSorted(byKey((entry) => entry.slug));
  const conflictIds = new Set(naamConflicts.map((entry) => entry.bronId));
  const codeIds = new Set(definitions.map((definition) => definition.bronId));
  const slugById = new Map(
    definitions.map((definition) => [definition.bronId, definition.slug])
  );

  const missingRows = definitions
    .filter((definition) => !rowsById.has(definition.bronId))
    .map((definition) => ({
      bronId: definition.bronId,
      naam: definition.naam,
      slug: definition.slug,
    }))
    .toSorted(byKey((entry) => entry.slug));

  const voorwaardenDrift = definitions
    .flatMap((definition) => {
      const row = rowsById.get(definition.bronId);
      if (
        !row ||
        conflictIds.has(definition.bronId) ||
        row.voorwaardenStatus === definition.seed.voorwaardenStatus
      ) {
        return [];
      }
      return [
        {
          bronId: definition.bronId,
          code: definition.seed.voorwaardenStatus,
          db: row.voorwaardenStatus,
          slug: definition.slug,
        },
      ];
    })
    .toSorted(byKey((entry) => entry.slug));

  const unknownRows = rows
    .filter((row) => !codeIds.has(row.id))
    .map((row) => ({ actief: row.actief, bronId: row.id, naam: row.naam }))
    .toSorted(byKey((entry) => entry.naam));

  const inactiveRows = rows
    .filter(
      (row) => !row.actief && slugById.has(row.id) && !conflictIds.has(row.id)
    )
    .map((row) => ({ bronId: row.id, naam: row.naam, status: row.status }))
    .toSorted(byKey((entry) => entry.naam));

  return {
    inSync:
      missingRows.length === 0 &&
      naamConflicts.length === 0 &&
      unknownRows.length === 0 &&
      voorwaardenDrift.length === 0,
    inactiveRows,
    missingRows,
    naamConflicts,
    totals: { codeSources: definitions.length, dbRows: rows.length },
    unknownRows,
    voorwaardenDrift,
  };
};

/** Compact, log-friendly counts (plus slugs) for a boot-time warning line. */
export const summariseSeedReconcile = (report: SeedReconcileReport) => ({
  codeSources: report.totals.codeSources,
  dbRows: report.totals.dbRows,
  inSync: report.inSync,
  inactive: report.inactiveRows.map((row) => row.naam),
  missingRows: report.missingRows.map((row) => row.slug),
  naamConflicts: report.naamConflicts.map(
    (entry) => `${entry.slug}: ${entry.dbNaam}`
  ),
  unknownRows: report.unknownRows.map((row) => row.naam),
  voorwaardenDrift: report.voorwaardenDrift.length,
  voorwaardenDriftByPair: Object.fromEntries(
    Object.entries(
      Object.groupBy(
        report.voorwaardenDrift,
        (entry) => `${entry.code}->${entry.db}`
      )
    ).map(([pair, entries]) => [pair, entries?.length ?? 0])
  ),
});
