import { Schema } from "effect";

import {
  FiniteNumber,
  NonNegativeInteger,
  toCapabilitySchema,
  UuidString,
} from "../schema-helpers";
import type { SliceAHandlerDeps } from "./deps";

export { emptyObjectSchema as getBronOverlapInputSchema } from "../schema-helpers";

const overlapGroupView = Schema.Struct({
  aanvraagCount: NonNegativeInteger,
  bronCount: NonNegativeInteger,
  bronIds: Schema.Array(UuidString),
  bronNamen: Schema.Array(Schema.String),
  groepId: UuidString,
});

const bronShareView = Schema.Struct({
  bronId: UuidString,
  naam: Schema.String,
  overlappingAanvragen: NonNegativeInteger,
  share: Schema.NullOr(FiniteNumber),
  totalAanvragen: NonNegativeInteger,
});

export const getBronOverlapOutputSchema = toCapabilitySchema(
  Schema.Struct({
    overlapGroepCount: NonNegativeInteger,
    perBron: Schema.Array(bronShareView),
    topGroups: Schema.Array(overlapGroupView),
  })
);

export const createGetBronOverlapHandler =
  (deps: SliceAHandlerDeps) => async () => {
    if (!deps.bronOverlapReader) {
      throw new Error("BronOverlapReader unavailable");
    }
    const overlap = await deps.bronOverlapReader.bronOverlap();
    return {
      ok: true as const,
      value: {
        overlapGroepCount: overlap.overlapGroepCount,
        perBron: overlap.perBron.map((row) => ({
          bronId: row.bronId,
          naam: row.naam,
          overlappingAanvragen: row.overlappingAanvragen,
          share: row.share,
          totalAanvragen: row.totalAanvragen,
        })),
        topGroups: overlap.topGroups.map((group) => ({
          aanvraagCount: group.aanvraagCount,
          bronCount: group.bronCount,
          bronIds: [...group.bronIds],
          bronNamen: [...group.bronNamen],
          groepId: group.groepId,
        })),
      },
    };
  };
