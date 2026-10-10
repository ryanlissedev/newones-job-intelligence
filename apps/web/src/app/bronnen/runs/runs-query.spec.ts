import { describe, expect, it } from "bun:test";

import {
  DEFAULT_RUN_KIND,
  parseRunsQuery,
  runsHref,
  toScrapeRunsApiQuery,
} from "./runs-query";

describe("parseRunsQuery", () => {
  it("defaults runKind to poll when unset (backfill OFF)", () => {
    expect(parseRunsQuery({}).runKind).toBe(DEFAULT_RUN_KIND);
    expect(parseRunsQuery({ runKind: "nope" }).runKind).toBe("poll");
  });

  it("accepts known filters and drops invalid bronId", () => {
    const query = parseRunsQuery({
      bronId: "not-a-uuid",
      failureCode: "FETCH_FAILED",
      runKind: "all",
      status: "failed",
    });
    expect(query).toEqual({
      bronId: undefined,
      cursor: undefined,
      failureCode: "FETCH_FAILED",
      runKind: "all",
      status: "failed",
    });
  });

  it("keeps valid uuid bronId and ISO|uuid cursor", () => {
    const bronId = "00000000-0000-4000-8000-000000000001";
    const query = parseRunsQuery({
      bronId,
      cursor: "2026-09-06T12:00:00.000Z|00000000-0000-4000-8000-0000000000aa",
      runKind: "backfill",
    });
    expect(query.bronId).toBe(bronId);
    expect(query.cursor).toBe(
      "2026-09-06T12:00:00.000Z|00000000-0000-4000-8000-0000000000aa"
    );
    expect(query.runKind).toBe("backfill");
  });

  it("drops malformed cursors that would break Postgres uuid casts", () => {
    expect(
      parseRunsQuery({ cursor: "2026-09-06T12:00:00.000Z|not-a-uuid" }).cursor
    ).toBeUndefined();
    expect(parseRunsQuery({ cursor: "c1" }).cursor).toBeUndefined();
  });
});

describe("runsHref / toScrapeRunsApiQuery", () => {
  it("serializes runKind always and clears cursor on override", () => {
    const base = parseRunsQuery({
      cursor: "2026-09-06T12:00:00.000Z|00000000-0000-4000-8000-0000000000aa",
      failureCode: "FETCH_FAILED",
      runKind: "poll",
      status: "failed",
    });
    expect(runsHref(base)).toContain("runKind=poll");
    expect(runsHref(base)).toContain("cursor=");
    expect(runsHref(base, { cursor: undefined })).not.toContain("cursor=");
    expect(toScrapeRunsApiQuery(base)).toContain("failureCode=FETCH_FAILED");
  });
});
