/**
 * Seeds are insert-only: `INSERT … ON CONFLICT (id) DO NOTHING` keeps an
 * operator-reviewed row untouched. That is only safe when the existing row
 * is the same bron. When another bron already holds the id (2026-10: the
 * v1-backfill Werkzoeken/Starapple rows on the Stedin/Gasunie registry ids),
 * DO NOTHING silently skipped the seed and the source never got a row. Seed
 * writers now check the row that won the conflict and fail loudly instead.
 */
export class BronSeedIdCollisionError extends Error {
  readonly bronId: string;
  readonly dbNaam: string;
  readonly seedNaam: string;

  constructor(input: { bronId: string; dbNaam: string; seedNaam: string }) {
    super(
      `bron seed id collision: ${input.bronId} is held by "${input.dbNaam}" but the seed is "${input.seedNaam}". ` +
        "Two bronnen share one id; give one of them its own id (packages/application/src/sources or backfill bindings) " +
        "or, for an intentional rename, update the code naam. Nothing was written for this bron."
    );
    this.name = "BronSeedIdCollisionError";
    this.bronId = input.bronId;
    this.dbNaam = input.dbNaam;
    this.seedNaam = input.seedNaam;
  }
}

/** Same comparison as the `lower(naam)` unique index on curated.bron, plus trimming. */
const sameBronNaam = (left: string, right: string): boolean =>
  left.trim().toLowerCase() === right.trim().toLowerCase();

/**
 * Throws when a seed that was skipped by `ON CONFLICT (id) DO NOTHING` met a
 * row of a different bron. `existingNaam` is null when the insert went through
 * (or the row vanished), in which case there is nothing to compare.
 */
export const assertSeedHitSameBron = (input: {
  bronId: string;
  existingNaam: string | null;
  seedNaam: string;
}): void => {
  if (input.existingNaam === null) {
    return;
  }
  if (!sameBronNaam(input.existingNaam, input.seedNaam)) {
    throw new BronSeedIdCollisionError({
      bronId: input.bronId,
      dbNaam: input.existingNaam,
      seedNaam: input.seedNaam,
    });
  }
};
