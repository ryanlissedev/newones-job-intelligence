import { describe, expect, it } from "bun:test";

import { MemoryMartsReader } from "../stores/memory/marts-reader";
import { createTestSliceADeps } from "../test-fixtures";
import {
  createGetDataDictionaryHandler,
  createListMartsTablesHandler,
  createQueryMartsHandler,
  createSearchQueryCatalogHandler,
  listMartsTablesOutputSchema,
  queryMartsOutputSchema,
} from "./marts";

describe("list_marts_tables handler", () => {
  it("returns live introspection rows in wire shape", async () => {
    const martsReader = new MemoryMartsReader();
    martsReader.seedTable({
      columns: [
        { dataType: "uuid", name: "id", nullable: false },
        { dataType: "text", name: "titel", nullable: true },
      ],
      name: "aanvraag",
    });
    const handler = createListMartsTablesHandler({
      ...createTestSliceADeps(),
      martsReader,
    });

    const result = await handler();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.tables).toHaveLength(1);
    expect(result.value.tables[0]?.columns[1]?.nullable).toBe(true);
    expect(listMartsTablesOutputSchema.safeParse(result.value).success).toBe(
      true
    );
  });

  it("fails closed when the marts reader is absent", async () => {
    const handler = createListMartsTablesHandler({
      ...createTestSliceADeps(),
      martsReader: undefined,
    });
    await expect(handler()).rejects.toThrow(/MartsReader unavailable/u);
  });
});

describe("query_marts handler", () => {
  it("dry-run returns the explain plan without executing", async () => {
    let executed = false;
    const martsReader = new MemoryMartsReader();
    const originalQuery = martsReader.query.bind(martsReader);
    martsReader.query = (sql: string) => {
      executed = true;
      return originalQuery(sql);
    };
    const handler = createQueryMartsHandler({
      ...createTestSliceADeps(),
      martsReader,
    });

    const result = await handler({
      dryRun: true,
      sql: "SELECT count(*) FROM aanvraag",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.mode).toBe("explain");
    expect(executed).toBe(false);
    expect(queryMartsOutputSchema.safeParse(result.value).success).toBe(true);
  });

  it("executes a validated SELECT and echoes sql, columns and rows", async () => {
    const martsReader = new MemoryMartsReader();
    martsReader.seedResult("SELECT titel FROM aanvraag", {
      columns: ["titel"],
      rows: [{ titel: "Senior dev" }],
      truncated: false,
    });
    const handler = createQueryMartsHandler({
      ...createTestSliceADeps(),
      martsReader,
    });

    const result = await handler({ sql: "SELECT titel FROM aanvraag" });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value).toMatchObject({
      columns: ["titel"],
      mode: "execute",
      rowCap: 10_000,
      sql: "SELECT titel FROM aanvraag",
      truncated: false,
    });
    if (result.value.mode === "execute") {
      expect(result.value.rows).toEqual([{ titel: "Senior dev" }]);
    }
    expect(queryMartsOutputSchema.safeParse(result.value).success).toBe(true);
  });

  it("surfaces SQL rejections as domain failures with the sql in details", async () => {
    const handler = createQueryMartsHandler({
      ...createTestSliceADeps(),
      martsReader: new MemoryMartsReader(),
    });

    const result = await handler({ sql: "DELETE FROM aanvraag" });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("SYNTAX_ERROR");
    expect(result.error.details).toMatchObject({
      sql: "DELETE FROM aanvraag",
      stage: "explain",
    });
  });

  it("surfaces execute-stage rejections with the sql in details", async () => {
    const martsReader = new MemoryMartsReader();
    martsReader.query = () =>
      Promise.resolve({ ok: false, reason: "relation does not exist" });
    const handler = createQueryMartsHandler({
      ...createTestSliceADeps(),
      martsReader,
    });

    const result = await handler({ sql: "SELECT 1 FROM missing" });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.details).toMatchObject({ stage: "execute" });
  });
});

describe("search_query_catalog handler", () => {
  it("ranks matching recipes and honours the limit", () => {
    const handler = createSearchQueryCatalogHandler(createTestSliceADeps());

    const result = handler({ limit: 1, query: "tarief" });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.recipes).toHaveLength(1);
    expect(result.value.recipes[0]?.name).toBe("tarief_spreiding");
  });

  it("returns recipes for a known topic", () => {
    const handler = createSearchQueryCatalogHandler(createTestSliceADeps());

    const result = handler({ query: "aanvragen per bron" });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.recipes[0]?.name).toBe("aanvragen_per_bron");
  });
});

describe("get_data_dictionary handler", () => {
  it("returns the static seed with version", () => {
    const handler = createGetDataDictionaryHandler(createTestSliceADeps());

    const result = handler();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.version).toBe("marts-dict-v1");
    expect(result.value.tables.map((table) => table.name)).toContain(
      "aanvraag"
    );
    expect(result.value.recipes.length).toBeGreaterThan(0);
  });
});
