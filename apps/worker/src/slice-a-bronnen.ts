import {
  resolveSourceByNaam,
  SOURCES,
  SUPPORTED_BRON_SLUGS,
} from "@ji/application/sources";
import type { SupportedBronSlug } from "@ji/application/sources";
import type { BronId } from "@ji/domain";

export type SliceABronSlug = SupportedBronSlug;

export interface SliceABronDefinition {
  bronId: BronId;
  bronSlug: SliceABronSlug;
  naam: string;
}

export const SLICE_A_BRONNEN: readonly SliceABronDefinition[] =
  SUPPORTED_BRON_SLUGS.map((bronSlug) => ({
    bronId: SOURCES[bronSlug].bronId,
    bronSlug,
    naam: SOURCES[bronSlug].naam,
  }));

export const resolveSliceABronSlug = (naam: string): SliceABronSlug | null =>
  resolveSourceByNaam(naam)?.slug ?? null;
