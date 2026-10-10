import { afterEach, describe, expect, it } from "bun:test";

import { describeManticoreTable } from "./client";

// describeManticoreTable (RJC-391 readiness) talks to /sql?mode=raw
// directly rather than through ManticoreHttpClient, so these specs stub
// globalThis.fetch instead of the engine's mock client.
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const mockShowTablesResponse = (
  rows: readonly Record<string, string>[]
): void => {
  const showTablesFetch = (
    _url: string,
    _init?: RequestInit
  ): Promise<Response> => Promise.resolve(Response.json([{ data: rows }]));
  // SAFETY: showTablesFetch matches fetch's call signature (url, init) and
  // return type (Promise<Response>); it never needs the rest of the global
  // fetch overload set this test doesn't exercise — same pattern as
  // limits.spec.ts's hangingFetch/fastFetch stubs.
  globalThis.fetch = showTablesFetch as typeof fetch;
};

describe("describeManticoreTable", () => {
  it("reports exists: true when the legacy 'Index' column matches (Manticore <= 6.x)", async () => {
    mockShowTablesResponse([{ Index: "aanvragen", Type: "rt" }]);

    const result = await describeManticoreTable(
      "http://127.0.0.1:9308",
      "aanvragen"
    );

    expect(result).toEqual({ exists: true });
  });

  it("reports exists: true when the 'Table' column matches (Manticore 29.x)", async () => {
    mockShowTablesResponse([{ Table: "aanvragen", Type: "rt" }]);

    const result = await describeManticoreTable(
      "http://127.0.0.1:9308",
      "aanvragen"
    );

    expect(result).toEqual({ exists: true });
  });

  it("reports exists: false when neither column matches the requested table", async () => {
    mockShowTablesResponse([{ Table: "some_other_table", Type: "rt" }]);

    const result = await describeManticoreTable(
      "http://127.0.0.1:9308",
      "aanvragen"
    );

    expect(result).toEqual({ exists: false });
  });
});
