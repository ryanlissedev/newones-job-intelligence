import { describe, expect, it } from "bun:test";

import {
  deselectPageIds,
  isPageFullySelected,
  selectAllMatchesPlan,
  selectPageIds,
  selectionCountLabel,
  SNAPSHOT_MAX_SELECTED_IDS,
  toggleSelectedId,
  tooManyMatchesMessage,
} from "./snapshot-selection";

describe("snapshot selection", () => {
  it("toggles ids by returning a new selection", () => {
    const selected = new Set(["one"]);
    expect(toggleSelectedId(selected, "two")).toEqual(new Set(["one", "two"]));
    expect(toggleSelectedId(selected, "one")).toEqual(new Set());
    expect(selected).toEqual(new Set(["one"]));
  });

  it("selects a page at the limit and rejects the next id", () => {
    const selected = new Set(
      Array.from({ length: SNAPSHOT_MAX_SELECTED_IDS - 1 }, (_, index) =>
        String(index)
      )
    );
    const atLimit = selectPageIds(selected, ["last"]);
    expect(atLimit).toEqual({
      kind: "ok",
      selected: new Set([...selected, "last"]),
    });

    const tooMany = selectPageIds(atLimit.selected, ["overflow"]);
    expect(tooMany).toEqual({
      kind: "too-many",
      max: SNAPSHOT_MAX_SELECTED_IDS,
      total: SNAPSHOT_MAX_SELECTED_IDS + 1,
    });
    expect(atLimit.selected.has("overflow")).toBe(false);
  });

  it("deselects page ids and checks full-page selection", () => {
    const selected = new Set(["one", "two", "other"]);
    expect(deselectPageIds(selected, ["one", "two"])).toEqual(
      new Set(["other"])
    );
    expect(isPageFullySelected(selected, ["one", "two"])).toBe(true);
    expect(isPageFullySelected(selected, ["one", "missing"])).toBe(false);
    expect(isPageFullySelected(selected, [])).toBe(false);
  });

  it("plans selecting all matches for empty, bounded, and oversized totals", () => {
    expect(selectAllMatchesPlan(0)).toEqual({ kind: "empty" });
    expect(selectAllMatchesPlan(SNAPSHOT_MAX_SELECTED_IDS)).toEqual({
      kind: "fetch",
      pageSize: SNAPSHOT_MAX_SELECTED_IDS,
    });
    expect(selectAllMatchesPlan(SNAPSHOT_MAX_SELECTED_IDS + 1)).toEqual({
      kind: "too-many",
      max: SNAPSHOT_MAX_SELECTED_IDS,
      total: SNAPSHOT_MAX_SELECTED_IDS + 1,
    });
  });

  it("formats selection labels and too-many messages", () => {
    expect(selectionCountLabel(2)).toBe("2 van maximaal 100 geselecteerd");
    expect(tooManyMatchesMessage(1234)).toBe(
      "Te veel matches om alles te selecteren (1.234). Een snapshot bevat maximaal 100 opdrachten; verfijn de zoekopdracht of selecteer handmatig."
    );
  });
});
