import type { JobSource } from "../types";

export interface BronCatalogEntry {
  readonly actief?: boolean;
  readonly bronId: string;
  readonly naam: string;
}

// RJC-368: the bron register grows (12+ sources today, see
// packages/application/src/sources/index.ts) so this derives a stable slug
// from whatever naam the API returns instead of matching against a fixed
// list of known brand names. Never returns null, so a source outside any
// previously-hardcoded list is no longer silently mislabeled as another bron.
export const bronNameToSource = (naam: string): JobSource =>
  naam
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");

export const buildBronCatalog = (
  bronnen: readonly BronCatalogEntry[]
): ReadonlyMap<string, BronCatalogEntry> =>
  new Map(bronnen.map((bron) => [bron.bronId, bron]));
