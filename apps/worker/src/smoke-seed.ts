import type { SourceDefinition } from "@ji/application/sources";
import { assertSeedHitSameBron } from "@ji/db";
import type { BronRuntimeDatabase } from "@ji/db";
import { bron } from "@ji/db/schema/curated";
import type { BronId } from "@ji/domain";
import { eq } from "drizzle-orm";

export const SLICE_A_BRON_INTERVAL = "*/15 * * * *";
const SMOKE_RATE_LIMIT_PER_MINUTE = 30;

export interface SliceABronSeedValues {
  actief: false;
  categorie: "overheidsportaal";
  crawlDelayMs: number;
  id: BronId;
  ingestieType: string;
  interval: typeof SLICE_A_BRON_INTERVAL;
  loginVereist: false;
  mappingRef: string;
  naam: string;
  rateLimitPerMinute: typeof SMOKE_RATE_LIMIT_PER_MINUTE;
  retentionDays: 90;
  secretRef: null;
  status: "deferred" | "ready";
  voorwaardenStatus: SourceDefinition["seed"]["voorwaardenStatus"];
}

const seedStatusFor = (
  voorwaardenStatus: SourceDefinition["seed"]["voorwaardenStatus"]
): SliceABronSeedValues["status"] =>
  voorwaardenStatus === "toegestaan" ? "ready" : "deferred";

export const buildSliceABronSeedValues = (
  definition: SourceDefinition
): SliceABronSeedValues => ({
  actief: false,
  categorie: "overheidsportaal",
  crawlDelayMs: definition.seed.crawlDelayMs,
  id: definition.bronId,
  ingestieType: definition.seed.methode,
  interval: SLICE_A_BRON_INTERVAL,
  loginVereist: false,
  mappingRef: `fixtures/connectors/${definition.slug}/mapping.json`,
  naam: definition.naam,
  rateLimitPerMinute: SMOKE_RATE_LIMIT_PER_MINUTE,
  retentionDays: 90,
  secretRef: null,
  status: seedStatusFor(definition.seed.voorwaardenStatus),
  voorwaardenStatus: definition.seed.voorwaardenStatus,
});

/**
 * Seeds only missing registry rows. `ON CONFLICT DO NOTHING` means an
 * operator-owned row keeps its status, interval and other settings. A row of
 * a different bron on the same id is not "present": it throws
 * `BronSeedIdCollisionError` instead of silently skipping the seed.
 */
export const ensureMissingSliceABronnen = async (
  database: BronRuntimeDatabase,
  definitions: readonly SourceDefinition[]
): Promise<void> => {
  for (const definition of definitions) {
    // oxlint-disable-next-line no-await-in-loop -- preserve readable seed order
    const inserted = await database
      .insert(bron)
      .values(buildSliceABronSeedValues(definition))
      .onConflictDoNothing({ target: bron.id })
      .returning({ id: bron.id });
    if (inserted.length > 0) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- one check per skipped seed
    const [existing] = await database
      .select({ naam: bron.naam })
      .from(bron)
      .where(eq(bron.id, definition.bronId))
      .limit(1);
    assertSeedHitSameBron({
      bronId: definition.bronId,
      existingNaam: existing?.naam ?? null,
      seedNaam: definition.naam,
    });
  }
};
