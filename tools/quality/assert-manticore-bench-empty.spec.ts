import { describe, expect, it, mock } from "bun:test";

import { runAssertManticoreBenchEmpty } from "./assert-manticore-bench-empty";

const countResponse = (count: number): Response =>
  Response.json([{ data: [{ "count(*)": count }] }]);

describe("assert-manticore-bench-empty", () => {
  it("skips when MANTICORE_URL is unset and not required", async () => {
    const request = mock(() => Promise.resolve(countResponse(0)));
    await expect(runAssertManticoreBenchEmpty({}, request)).resolves.toBe(
      "skipped"
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("fails closed when required and MANTICORE_URL is unset", async () => {
    await expect(
      runAssertManticoreBenchEmpty({ BENCH_REQUIRE_MANTICORE: "1" })
    ).rejects.toThrow("requires a non-empty MANTICORE_URL");
  });

  it("passes when both bench tables count zero", async () => {
    const request = mock(() => Promise.resolve(countResponse(0)));
    await expect(
      runAssertManticoreBenchEmpty(
        { MANTICORE_URL: "http://manticore.test" },
        request
      )
    ).resolves.toBe("ok");
    expect(request).toHaveBeenCalled();
  });

  it("rejects a dirty bench table", async () => {
    let calls = 0;
    const request = mock(() => {
      calls += 1;
      return Promise.resolve(countResponse(calls === 1 ? 3 : 0));
    });
    await expect(
      runAssertManticoreBenchEmpty(
        { MANTICORE_URL: "http://manticore.test" },
        request
      )
    ).rejects.toThrow("aanvragen_bench_active=3");
  });
});
