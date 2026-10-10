import { afterEach, describe, expect, it } from "bun:test";

import { geocodeNlLocation, projectToMapPercent } from "./nl-location-coords";
import {
  JOBS_PAGE_SIZE_STORAGE_KEY,
  JOBS_VIEW_MODE_STORAGE_KEY,
  readStoredJobPageSize,
  readStoredResultsViewMode,
  writeStoredJobPageSize,
  writeStoredResultsViewMode,
} from "./results-prefs";
import {
  parseJobPageSize,
  parseJobSearchState,
  serializeJobSearchState,
} from "./search-state";
import { JOB_PAGE_SIZE, JOB_PAGE_SIZE_OPTIONS } from "./types";

describe("CTP-509 page size options", () => {
  it("exposes 25/50/100/500/1000 and defaults to 50", () => {
    expect([...JOB_PAGE_SIZE_OPTIONS]).toEqual([25, 50, 100, 500, 1000]);
    expect(JOB_PAGE_SIZE).toBe(50);
  });

  it("parses Motian perPage allowlist and rejects unknown sizes", () => {
    expect(parseJobPageSize("25")).toBe(25);
    expect(parseJobPageSize("100")).toBe(100);
    expect(parseJobPageSize("1000")).toBe(1000);
    expect(parseJobPageSize("26")).toBe(JOB_PAGE_SIZE);
    expect(parseJobPageSize("1001")).toBe(JOB_PAGE_SIZE);
  });

  it("round-trips perPage in the shareable URL when not default", () => {
    const state = parseJobSearchState(
      new URLSearchParams("perPage=500&q=azure")
    );
    expect(state.pageSize).toBe(500);
    expect(serializeJobSearchState(state).get("perPage")).toBe("500");
    const defaulted = parseJobSearchState(new URLSearchParams("q=azure"));
    expect(defaulted.pageSize).toBe(JOB_PAGE_SIZE);
    expect(serializeJobSearchState(defaulted).has("perPage")).toBe(false);
  });
});

describe("CTP-509 results prefs", () => {
  const memory = new Map<string, string>();
  const original = globalThis.localStorage;

  afterEach(() => {
    memory.clear();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: original,
    });
  });

  it("persists page size and view mode in localStorage", () => {
    const stub = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        memory.set(key, value);
      },
    };
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: stub,
    });
    writeStoredJobPageSize(1000);
    writeStoredResultsViewMode("map");
    expect(memory.get(JOBS_PAGE_SIZE_STORAGE_KEY)).toBe("1000");
    expect(memory.get(JOBS_VIEW_MODE_STORAGE_KEY)).toBe("map");
    expect(readStoredJobPageSize()).toBe(1000);
    expect(readStoredResultsViewMode()).toBe("map");
  });
});

describe("CTP-509 NL map geocoder", () => {
  it("geocodes known cities and provinces", () => {
    expect(geocodeNlLocation("Amsterdam")).toMatchObject({
      label: "Amsterdam",
    });
    expect(geocodeNlLocation("Provincie Utrecht")).toMatchObject({
      label: "Utrecht",
    });
    expect(geocodeNlLocation("Onbekend Dorp XYZ")).toBeNull();
    const point = geocodeNlLocation("Rotterdam");
    if (point === null) {
      throw new Error("expected Rotterdam geocode");
    }
    const projected = projectToMapPercent(point);
    expect(projected.left).toBeGreaterThan(0);
    expect(projected.top).toBeGreaterThan(0);
  });
});
