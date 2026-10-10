import { describe, expect, it } from "bun:test";

import { JOB_FIXTURES } from "./fixtures";
import {
  parseJobSearchState,
  searchJobs,
  serializeJobSearchState,
  toggleSearchFilter,
} from "./search-state";
import { selectableJobSortOptions } from "./types";

describe("job search URL state", () => {
  it("round-trips shareable filters and selection", () => {
    const original = parseJobSearchState(
      new URLSearchParams(
        "q=data&source=inhuurdesk&source=tenderned&contract=interim&status=active&status=closed&location=Amsterdam&freshness=7d&minRate=90&sort=rate-high&page=2&job=job-001&preview=loading&archief=1"
      )
    );

    expect(parseJobSearchState(serializeJobSearchState(original))).toEqual(
      original
    );
  });

  it("rejects invalid enum and numeric values", () => {
    const state = parseJobSearchState(
      new URLSearchParams(
        "source=database&contract=stage&freshness=never&minRate=-10&sort=random&page=0&preview=done"
      )
    );

    // RJC-368: sources are opaque bron slugs from the live register, not a
    // fixed enum, so any provided value passes through unfiltered (deduped)
    // -- an unrecognized slug just matches zero bronnen/facets downstream.
    expect(state.filters.sources).toEqual(["database"]);
    expect(state.filters.contractTypes).toEqual([]);
    expect(state.filters.status).toEqual([]);
    expect(state.filters.freshness).toBe("all");
    expect(state.filters.minRate).toBeNull();
    expect(state.sort).toBe("relevance");
    expect(state.page).toBe(1);
    expect(state.previewStatus).toBe("ready");
  });

  it("preserves commas and quotes in scalar queries and repeated free-form locations", () => {
    const state = parseJobSearchState(
      new URLSearchParams(
        "q=%22Amsterdam%2C+Noord-Holland%22&location=Amsterdam%2C+Noord-Holland&location=Utrecht"
      )
    );

    expect(state.query).toBe('"Amsterdam, Noord-Holland"');
    expect(state.filters.locations).toEqual([
      "Amsterdam, Noord-Holland",
      "Utrecht",
    ]);
    expect(serializeJobSearchState(state).getAll("location")).toEqual([
      "Amsterdam, Noord-Holland",
      "Utrecht",
    ]);
  });

  it("supports comma-separated compatibility only for the contract enum", () => {
    const state = parseJobSearchState(
      new URLSearchParams("contract=interim%2Cdetachering&source=alpha%2Cbeta")
    );

    expect(state.filters.contractTypes).toEqual(["interim", "detachering"]);
    expect(state.filters.sources).toEqual(["alpha,beta"]);
  });

  it("accepts repeated lifecycle status values and drops invalid values", () => {
    const state = parseJobSearchState(
      new URLSearchParams(
        "status=active&status=closed&status=archived&status=active"
      )
    );

    expect(state.filters.status).toEqual(["active", "closed"]);
    expect(serializeJobSearchState(state).getAll("status")).toEqual([
      "active",
      "closed",
    ]);
  });

  it("defaults to the active scope and only serialises the archive opt-in (RJC-383)", () => {
    const active = parseJobSearchState(new URLSearchParams("q=data"));
    expect(active.scope).toBe("active");
    expect(serializeJobSearchState(active).has("archief")).toBe(false);
    const all = parseJobSearchState(new URLSearchParams("q=data&archief=1"));
    expect(all.scope).toBe("all");
    expect(serializeJobSearchState(all).get("archief")).toBe("1");
    expect(parseJobSearchState(new URLSearchParams("archief=yes")).scope).toBe(
      "active"
    );
  });

  it("round-trips Motian-parity filters and queryScope (CTP-507)", () => {
    const original = parseJobSearchState(
      new URLSearchParams(
        "arrangement=hybride&arrangement=remote&province=Utrecht&skill=Azure&minRate=80&maxRate=140&hoursMin=24&hoursMax=40&from=2026-08-01&to=2026-08-31&queryScope=all"
      )
    );

    expect(original.filters.werkvormen).toEqual(["hybride", "remote"]);
    expect(original.filters.provincies).toEqual(["Utrecht"]);
    expect(original.filters.skills).toEqual(["Azure"]);
    expect(original.filters.minRate).toBe(80);
    expect(original.filters.maxRate).toBe(140);
    expect(original.filters.urenPerWeekMin).toBe(24);
    expect(original.filters.urenPerWeekMax).toBe(40);
    expect(original.filters.publicatiedatumVanaf).toBe("2026-08-01");
    expect(original.filters.publicatiedatumTot).toBe("2026-08-31");
    expect(original.filters.queryScope).toBe("all");
    // queryScope is distinct from archive scope
    expect(original.scope).toBe("active");

    expect(parseJobSearchState(serializeJobSearchState(original))).toEqual(
      original
    );

    const defaults = parseJobSearchState(new URLSearchParams("q=x"));
    expect(defaults.filters.queryScope).toBe("all");
    expect(serializeJobSearchState(defaults).has("queryScope")).toBe(false);
    expect(
      parseJobSearchState(new URLSearchParams("arrangement=onsite")).filters
        .werkvormen
    ).toEqual([]);
    expect(
      parseJobSearchState(new URLSearchParams("from=not-a-date")).filters
        .publicatiedatumVanaf
    ).toBeNull();
  });
});

describe("fixture job search", () => {
  it("keeps closed listings in the archive: hidden and counted under active, listed under all (RJC-383)", () => {
    const closed = JOB_FIXTURES.filter((job) => job.status === "closed");
    expect(closed.length).toBeGreaterThan(0);
    const active = searchJobs(JOB_FIXTURES, parseJobSearchState({}));
    expect(active.items.some((job) => job.status === "closed")).toBe(false);
    expect(active.archiveTotal).toBe(closed.length);
    const all = searchJobs(
      JOB_FIXTURES,
      parseJobSearchState(new URLSearchParams("archief=1"))
    );
    expect(all.archiveTotal).toBeNull();
    expect(all.total).toBe(active.total + closed.length);
  });

  it("keeps an archive-only closed status truthful until archive scope is enabled", () => {
    const active = searchJobs(
      JOB_FIXTURES,
      parseJobSearchState(new URLSearchParams("status=closed"))
    );
    expect(active.items).toEqual([]);
    expect(active.total).toBe(0);
    expect(active.archiveTotal).toBeGreaterThan(0);

    const all = searchJobs(
      JOB_FIXTURES,
      parseJobSearchState(new URLSearchParams("status=closed&archief=1"))
    );
    expect(all.items.every((job) => job.status === "closed")).toBe(true);
    expect(all.total).toBeGreaterThan(0);
    expect(all.archiveTotal).toBeNull();
  });

  it("searches, filters and sorts deterministically", () => {
    const state = parseJobSearchState(
      new URLSearchParams(
        "q=Azure&source=inhuurdesk&source=tenderned&minRate=100&sort=rate-high"
      )
    );
    const result = searchJobs(JOB_FIXTURES, state);

    expect(result.items.map(({ id }) => id)).toEqual(["job-003", "job-001"]);
    expect(result.total).toBe(2);
    expect(result.status).toBe("ready");
  });

  it("applies the hourly minimum-rate filter to either published bound", () => {
    const [hourlyFixture, minOnlyBase, maxOnlyBase, dayBase] = JOB_FIXTURES;
    if (!hourlyFixture || !minOnlyBase || !maxOnlyBase || !dayBase) {
      throw new Error("Expected rate fixtures");
    }
    const jobs = [
      hourlyFixture,
      {
        ...minOnlyBase,
        id: "hour-min-only",
        rate: {
          currency: "EUR" as const,
          max: null,
          min: 100,
          period: "hour" as const,
        },
      },
      {
        ...maxOnlyBase,
        id: "hour-max-only",
        rate: {
          currency: "EUR" as const,
          max: 99,
          min: null,
          period: "hour" as const,
        },
      },
      {
        ...dayBase,
        id: "day-rate",
        rate: {
          currency: "EUR" as const,
          max: 500,
          min: 400,
          period: "day" as const,
        },
      },
    ];
    const result = searchJobs(
      jobs,
      parseJobSearchState(new URLSearchParams("minRate=100"))
    );

    expect(new Set(result.items.map(({ id }) => id))).toEqual(
      new Set([hourlyFixture.id, "hour-min-only"])
    );
  });

  it("returns an explicit empty presentation state", () => {
    const state = parseJobSearchState(
      new URLSearchParams("q=kwantumteleportatie")
    );
    const result = searchJobs(JOB_FIXTURES, state);

    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.status).toBe("empty");
    expect(result.message).toContain("Geen vacatures");
  });

  it("evaluates OR, NOT, groups and quoted phrases with Boolean precedence", () => {
    const orResult = searchJobs(
      JOB_FIXTURES,
      parseJobSearchState(new URLSearchParams("q=Azure OR BPMN"))
    );
    const groupedResult = searchJobs(
      JOB_FIXTURES,
      parseJobSearchState(
        new URLSearchParams('q=(Azure OR "Power BI") NOT Databricks')
      )
    );
    const phraseResult = searchJobs(
      JOB_FIXTURES,
      parseJobSearchState(new URLSearchParams('q="Machine Learning"'))
    );

    expect(orResult.items.map(({ id }) => id)).toEqual([
      "job-001",
      "job-002",
      "job-003",
    ]);
    expect(groupedResult.items.map(({ id }) => id)).toEqual([
      "job-003",
      "job-006",
    ]);
    expect(phraseResult.items.map(({ id }) => id)).toEqual(["job-010"]);
  });

  it("treats adjacent terms as AND and rejects malformed syntax", () => {
    const implicitAnd = searchJobs(
      JOB_FIXTURES,
      parseJobSearchState(new URLSearchParams("q=Azure Kubernetes"))
    );
    const malformed = searchJobs(
      JOB_FIXTURES,
      parseJobSearchState(new URLSearchParams("q=(Azure OR)"))
    );

    expect(implicitAnd.items.map(({ id }) => id)).toEqual(["job-003"]);
    expect(malformed.status).toBe("syntax-error");
    expect(malformed.items).toEqual([]);
  });

  it("sorts hourly and yearly rates within separate comparable groups", () => {
    const state = parseJobSearchState(new URLSearchParams("sort=rate-high"));
    const result = searchJobs(JOB_FIXTURES, { ...state, pageSize: 100 });
    const rates = result.items.map(({ id, rate }) => ({
      id,
      max: rate?.max ?? null,
      period: rate?.period ?? null,
    }));

    expect(rates).toEqual([
      { id: "job-003", max: 125, period: "hour" },
      { id: "job-005", max: 120, period: "hour" },
      { id: "job-001", max: 115, period: "hour" },
      { id: "job-dedup-001", max: 110, period: "hour" },
      { id: "job-dedup-002", max: 110, period: "hour" },
      { id: "job-004", max: 108, period: "hour" },
      { id: "job-007", max: 105, period: "hour" },
      { id: "job-009", max: 103, period: "hour" },
      { id: "job-002", max: 98, period: "hour" },
      { id: "job-006", max: 94, period: "hour" },
      { id: "job-html-nvb", max: 90, period: "hour" },
      { id: "job-stress-006", max: 88, period: "hour" },
      { id: "job-stress-005", max: 760, period: "day" },
      { id: "job-stress-001", max: 6500, period: "month" },
      { id: "job-stress-004", max: 4148, period: "month" },
      { id: "job-stress-003", max: 3510, period: "month" },
      { id: "job-008", max: 102_000, period: "year" },
      { id: "job-010", max: 96_000, period: "year" },
      { id: "job-011", max: null, period: null },
      { id: "job-stress-002", max: null, period: null },
    ]);
  });

  it("groups day, month and unknown rates after hourly rates", () => {
    const [fixture] = JOB_FIXTURES;
    if (!fixture) {
      throw new Error("Expected at least one job fixture");
    }
    const jobs = [
      {
        ...fixture,
        id: "hour",
        rate: {
          currency: "EUR" as const,
          max: null,
          min: 100,
          period: "hour" as const,
        },
      },
      {
        ...fixture,
        id: "day",
        rate: {
          currency: "EUR" as const,
          max: 500,
          min: null,
          period: "day" as const,
        },
      },
      {
        ...fixture,
        id: "month",
        rate: {
          currency: "EUR" as const,
          max: 300,
          min: null,
          period: "month" as const,
        },
      },
      {
        ...fixture,
        id: "year",
        rate: {
          currency: "EUR" as const,
          max: 120_000,
          min: null,
          period: "year" as const,
        },
      },
      {
        ...fixture,
        id: "unknown",
        rate: {
          currency: "EUR" as const,
          max: 9000,
          min: null,
          period: "unknown" as const,
        },
      },
      { ...fixture, id: "missing", rate: null },
    ];
    const result = searchJobs(jobs, {
      ...parseJobSearchState(new URLSearchParams("sort=rate-high")),
      pageSize: 100,
    });

    expect(result.items.map(({ id }) => id)).toEqual([
      "hour",
      "day",
      "month",
      "year",
      "unknown",
      "missing",
    ]);
  });

  it("paginates without mutating fixture order", () => {
    const before = JOB_FIXTURES.map(({ id }) => id);
    const state = parseJobSearchState(new URLSearchParams("page=2"));
    const result = searchJobs(JOB_FIXTURES, { ...state, pageSize: 3 });

    expect(result.items).toHaveLength(3);
    expect(result.page).toBe(2);
    expect(JOB_FIXTURES.map(({ id }) => id)).toEqual(before);
  });

  it("toggles a filter value without mutating the input", () => {
    const values = ["interim"] as const;

    expect(toggleSearchFilter(values, "vast")).toEqual(["interim", "vast"]);
    expect(toggleSearchFilter(values, "interim")).toEqual([]);
    expect(values).toEqual(["interim"]);
  });
});

// RJC-394: the deadline sort stays hidden until the loader provides real
// sluitingsdatum values; one flag flips it back on.
describe("selectableJobSortOptions", () => {
  it("hides closing-soon without enriched data and offers it with", () => {
    expect(selectableJobSortOptions(false)).toEqual([
      "relevance",
      "newest",
      "oldest",
      "rate-high",
      "rate-low",
      "title-asc",
      "company-asc",
    ]);
    expect(selectableJobSortOptions(true)).toContain("closing-soon");
  });

  it("parses a hidden sort from the URL back to relevance when disabled, keeps it when enabled", () => {
    const params = new URLSearchParams("sort=closing-soon");
    expect(parseJobSearchState(params, false).sort).toBe("relevance");
    expect(parseJobSearchState(params, true).sort).toBe("closing-soon");
  });
});
