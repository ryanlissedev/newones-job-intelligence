import { Schema } from "effect";

import {
  MARTS_DICTIONARY,
  searchMartsQueryCatalog,
} from "../marts/data-dictionary";
import {
  NonEmptyString,
  optionalField,
  PositiveInteger,
  toCapabilitySchema,
  UnknownRecord,
} from "../schema-helpers";
import type { SliceAHandlerDeps } from "./deps";

export { emptyObjectSchema as getDataDictionaryInputSchema } from "../schema-helpers";
export { emptyObjectSchema as listMartsTablesInputSchema } from "../schema-helpers";

export const MARTS_ROW_CAP = 10_000 as const;

const MARTS_SCHEMA_VERSION = "marts-v1" as const;
const SQL_MAX_LENGTH = 20_000;

const sqlString = NonEmptyString.check(Schema.isMaxLength(SQL_MAX_LENGTH));

const columnDoc = Schema.Struct({
  dataType: Schema.String,
  name: Schema.String,
  nullable: Schema.Boolean,
});

export const listMartsTablesOutputSchema = toCapabilitySchema(
  Schema.Struct({
    schemaVersion: Schema.String,
    tables: Schema.Array(
      Schema.Struct({
        columns: Schema.Array(columnDoc),
        name: Schema.String,
      })
    ),
  })
);

const queryExecutionResult = Schema.Struct({
  columns: Schema.Array(Schema.String),
  mode: Schema.Literal("execute"),
  rowCap: PositiveInteger,
  rows: Schema.Array(UnknownRecord),
  sql: sqlString,
  truncated: Schema.Boolean,
});

const queryExplainResult = Schema.Struct({
  mode: Schema.Literal("explain"),
  plan: Schema.Array(Schema.String),
  sql: sqlString,
});

/**
 * `mode` discriminates the analytics-template contract: `explain` is the
 * dry-run validation, `execute` is the guarded run. `sql` is echoed in both so
 * the UI's "SQL zichtbaar" rule (JI-DSH-07) holds even mid-iteration.
 */
export const queryMartsOutputSchema = (() => {
  const base = toCapabilitySchema(
    Schema.Union([queryExecutionResult, queryExplainResult])
  );
  const { toJsonSchema } = base;
  return {
    ...base,
    // The union emits a bare `anyOf` root; the MCP catalog contract requires
    // a concrete `type` on every tool output schema. Both members are
    // objects, so `type: "object"` is accurate, not cosmetic.
    toJsonSchema: (io: "input" | "output" = "input") => ({
      ...toJsonSchema(io),
      type: "object",
    }),
  };
})();

export const queryMartsInputSchema = toCapabilitySchema(
  Schema.Struct({
    dryRun: optionalField(Schema.Boolean),
    sql: sqlString,
  })
);

const recipeView = Schema.Struct({
  name: Schema.String,
  notes: optionalField(Schema.String),
  question: Schema.String,
  sql: Schema.String,
  tables: Schema.Array(Schema.String),
});

export const searchQueryCatalogInputSchema = toCapabilitySchema(
  Schema.Struct({
    limit: optionalField(PositiveInteger),
    query: NonEmptyString,
  })
);

export const searchQueryCatalogOutputSchema = toCapabilitySchema(
  Schema.Struct({
    recipes: Schema.Array(recipeView),
  })
);

const dictionaryColumnDoc = Schema.Struct({
  description: Schema.String,
  name: Schema.String,
});

export const getDataDictionaryOutputSchema = toCapabilitySchema(
  Schema.Struct({
    conventions: Schema.Array(Schema.String),
    metrics: Schema.Array(
      Schema.Struct({
        description: Schema.String,
        name: Schema.String,
        sql: Schema.String,
      })
    ),
    recipes: Schema.Array(recipeView),
    tables: Schema.Array(
      Schema.Struct({
        columns: Schema.Array(dictionaryColumnDoc),
        description: Schema.String,
        grain: Schema.String,
        name: Schema.String,
      })
    ),
    version: Schema.String,
  })
);

const requireMartsReader = (deps: SliceAHandlerDeps) => {
  if (!deps.martsReader) {
    throw new Error("MartsReader unavailable");
  }
  return deps.martsReader;
};

export const createListMartsTablesHandler =
  (deps: SliceAHandlerDeps) => async () => {
    const reader = requireMartsReader(deps);
    const tables = await reader.listTables();
    return {
      ok: true as const,
      value: {
        schemaVersion: MARTS_SCHEMA_VERSION,
        tables: tables.map((table) => ({
          columns: table.columns.map((column) => ({
            dataType: column.dataType,
            name: column.name,
            nullable: column.nullable,
          })),
          name: table.name,
        })),
      },
    };
  };

const sqlFailure = (
  stage: "explain" | "execute" | "guard",
  sql: string,
  reason: string
) =>
  ({
    error: {
      code: stage === "guard" ? "VALIDATION_ERROR" : "SYNTAX_ERROR",
      details: { sql, stage },
      message: reason,
    },
    ok: false,
  }) as const;

/**
 * `explain` always runs first — it is the parse/plan validation the dry-run
 * contract promises. With `dryRun` the caller gets the plan back; without it
 * the same validated statement executes inside the reader's read-only
 * transaction (statement timeout + row cap live there).
 */
export const createQueryMartsHandler =
  (deps: SliceAHandlerDeps) =>
  async (input: { readonly dryRun?: boolean; readonly sql: string }) => {
    const reader = requireMartsReader(deps);
    const plan = await reader.explain(input.sql);
    if (!plan.ok) {
      return sqlFailure("explain", input.sql, plan.reason);
    }
    if (input.dryRun) {
      return {
        ok: true as const,
        value: {
          mode: "explain" as const,
          plan: [...plan.value],
          sql: input.sql,
        },
      };
    }
    const result = await reader.query(input.sql);
    if (!result.ok) {
      return sqlFailure("execute", input.sql, result.reason);
    }
    return {
      ok: true as const,
      value: {
        columns: [...result.value.columns],
        mode: "execute" as const,
        rowCap: MARTS_ROW_CAP,
        rows: result.value.rows.map((row) => ({ ...row })),
        sql: input.sql,
        truncated: result.value.truncated,
      },
    };
  };

export const createSearchQueryCatalogHandler =
  (_deps: SliceAHandlerDeps) =>
  (input: { readonly limit?: number; readonly query: string }) => {
    const recipes = searchMartsQueryCatalog(input.query, input.limit ?? 5);
    return {
      ok: true as const,
      value: {
        recipes: recipes.map((recipe) => ({
          name: recipe.name,
          notes: recipe.notes,
          question: recipe.question,
          sql: recipe.sql,
          tables: [...recipe.tables],
        })),
      },
    };
  };

export const createGetDataDictionaryHandler =
  (_deps: SliceAHandlerDeps) => () => ({
    ok: true as const,
    value: {
      conventions: [...MARTS_DICTIONARY.conventions],
      metrics: MARTS_DICTIONARY.metrics.map((metric) => ({ ...metric })),
      recipes: MARTS_DICTIONARY.recipes.map((recipe) => ({
        name: recipe.name,
        notes: recipe.notes,
        question: recipe.question,
        sql: recipe.sql,
        tables: [...recipe.tables],
      })),
      tables: MARTS_DICTIONARY.tables.map((table) => ({
        columns: table.columns.map((column) => ({ ...column })),
        description: table.description,
        grain: table.grain,
        name: table.name,
      })),
      version: MARTS_DICTIONARY.version,
    },
  });
