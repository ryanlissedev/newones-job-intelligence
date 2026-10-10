import { describe, expect, it } from "bun:test";

import { tableExistsInShowTables } from "./show-tables";

describe("tableExistsInShowTables", () => {
  it("matches the legacy Index column", () => {
    const raw = JSON.stringify([
      { data: [{ Index: "aanvragen", Type: "rt" }] },
    ]);

    expect(tableExistsInShowTables(raw, "aanvragen")).toBe(true);
  });

  it("matches the Table column", () => {
    const raw = JSON.stringify([
      { data: [{ Table: "aanvragen", Type: "rt" }] },
    ]);

    expect(tableExistsInShowTables(raw, "aanvragen")).toBe(true);
  });

  it("returns false when the table is not listed", () => {
    const raw = JSON.stringify([
      { data: [{ Table: "some_other_table", Type: "rt" }] },
    ]);

    expect(tableExistsInShowTables(raw, "aanvragen")).toBe(false);
  });

  it("returns false for empty data", () => {
    expect(
      tableExistsInShowTables(JSON.stringify([{ data: [] }]), "aanvragen")
    ).toBe(false);
  });

  it("returns false for a non-array payload", () => {
    expect(tableExistsInShowTables("{}", "aanvragen")).toBe(false);
  });
});
