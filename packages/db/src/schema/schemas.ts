import { pgSchema } from "drizzle-orm/pg-core";

export const stagingSchema = pgSchema("staging");
export const curatedSchema = pgSchema("curated");
export const martsSchema = pgSchema("marts");
