import { z } from "zod";

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ])
);

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { readonly [key: string]: JsonValue };

export const restJsonBodySchema = z.record(z.string(), jsonValueSchema);

export type RestJsonBody = z.infer<typeof restJsonBodySchema>;

export const pathParamsSchema = z.record(z.string(), z.string());

export type PathParams = z.infer<typeof pathParamsSchema>;

/** REST query strings are always strings; keep unknown keys (filters/cursors). */
export const restQuerySchema = z.record(z.string(), z.string());

export type RestQuery = z.infer<typeof restQuerySchema>;
