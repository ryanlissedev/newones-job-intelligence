import type { BronConfig, BronId } from "@ji/domain";

import type { BackfillBronBinding } from "./neon-v1-types";

/** Motian Neon `jobs.platform` slugs included in the U8 historical backfill. */
export const MOTIAN_V1_PLATFORMS = [
  "nationalevacaturebank",
  "opdrachtoverheid",
  "mipublic",
  "flextender",
  "striive",
  "werkzoeken",
  "starapple-nl",
] as const;

export type MotianV1Platform = (typeof MOTIAN_V1_PLATFORMS)[number];

export const normalizeMotianPlatform = (platform: string): string => {
  if (platform === "starapple") {
    return "starapple-nl";
  }
  return platform;
};

/**
 * Source-side slugs are deliberately distinct from canonical platform names:
 * old Motian rows still use `starapple`, while Catapulze stores both spellings
 * under the single `starapple-nl` bron binding.
 */
export const MOTIAN_V1_SOURCE_PLATFORMS = [
  ...MOTIAN_V1_PLATFORMS,
  "starapple",
] as const;

export const sourcePlatformsForMotianV1 = (
  platforms: readonly string[]
): string[] => {
  const sourcePlatforms = new Set<string>();
  for (const platform of platforms) {
    const normalized = normalizeMotianPlatform(platform);
    sourcePlatforms.add(normalized);
    if (normalized === "starapple-nl") {
      sourcePlatforms.add("starapple");
    }
  }
  return [...sourcePlatforms];
};

export const isMotianV1Platform = (
  platform: string
): platform is MotianV1Platform => {
  const normalized = normalizeMotianPlatform(platform);
  for (const candidate of MOTIAN_V1_PLATFORMS) {
    if (candidate === normalized) {
      return true;
    }
  }
  return false;
};

interface MotianV1BronDefinition {
  readonly bronId: BronId;
  readonly categorie: string;
  readonly mappingRef: string;
  readonly naam: string;
  readonly platform: MotianV1Platform;
  readonly website: string;
}

const definitions: readonly MotianV1BronDefinition[] = [
  {
    bronId: "00000000-0000-4000-8000-000000000030",
    categorie: "jobboard",
    mappingRef: "packages/application/src/backfill/neon-v1.ts",
    naam: "Nationale Vacaturebank",
    platform: "nationalevacaturebank",
    website: "https://www.nationalevacaturebank.nl",
  },
  {
    bronId: "00000000-0000-4000-8000-0000000000ad",
    categorie: "overheidsportaal",
    mappingRef: "packages/application/src/backfill/neon-v1.ts",
    naam: "Opdrachtoverheid",
    platform: "opdrachtoverheid",
    website: "https://www.opdrachtoverheid.nl",
  },
  {
    bronId: "00000000-0000-4000-8000-000000000032",
    categorie: "overheidsportaal",
    mappingRef: "packages/application/src/backfill/neon-v1.ts",
    naam: "MI Public",
    platform: "mipublic",
    website: "https://mipublic.nl",
  },
  {
    bronId: "00000000-0000-4000-8000-000000000033",
    categorie: "broker",
    mappingRef: "packages/application/src/backfill/neon-v1.ts",
    naam: "Flextender",
    platform: "flextender",
    website: "https://flextender.nl",
  },
  {
    bronId: "00000000-0000-4000-8000-000000000008",
    categorie: "broker",
    mappingRef: "packages/application/src/backfill/neon-v1.ts",
    naam: "Striive",
    platform: "striive",
    website: "https://www.striive.com",
  },
  {
    bronId: "00000000-0000-4000-8000-000000000035",
    categorie: "jobboard",
    mappingRef: "packages/application/src/backfill/neon-v1.ts",
    naam: "Werkzoeken",
    platform: "werkzoeken",
    website: "https://www.werkzoeken.nl",
  },
  {
    bronId: "00000000-0000-4000-8000-000000000036",
    categorie: "broker",
    mappingRef: "packages/application/src/backfill/neon-v1.ts",
    naam: "Starapple",
    platform: "starapple-nl",
    website: "https://www.starapple.nl",
  },
];

export const MOTIAN_V1_BRON_BINDINGS: readonly BackfillBronBinding[] =
  definitions.map(({ bronId, platform }) => ({ bronId, platform }));

const sharedBronConfig = {
  crawlDelayMs: 0,
  interval: "manual",
  loginVereist: false,
  method: "feed" as const,
  rateLimitPerMinute: 1,
  secretRef: null,
  status: "deferred" as const,
  voorwaardenStatus: "toegestaan" as const,
};

export const MOTIAN_V1_BRON_CONFIGS: readonly BronConfig[] = definitions.map(
  ({ bronId, mappingRef, naam }) => ({
    ...sharedBronConfig,
    bronId,
    mappingRef,
    naam,
  })
);

export const MOTIAN_V1_BRON_SEEDS = definitions.map(
  ({ bronId, categorie, mappingRef, naam, website }) => ({
    bronId,
    categorie,
    ingestieType: sharedBronConfig.method,
    mappingRef,
    naam,
    website,
  })
);

export const resolveMotianV1Binding = (
  bindings: readonly BackfillBronBinding[],
  platform: string
): BackfillBronBinding | null => {
  const normalized = normalizeMotianPlatform(platform);
  return bindings.find((binding) => binding.platform === normalized) ?? null;
};
