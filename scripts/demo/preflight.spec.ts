import { describe, expect, it } from "bun:test";

import { resolveDemoTargets, runDemoPreflight } from "./preflight";

const zeroLagFetcher = (input: string): Promise<Response> => {
  if (input.endsWith("/version")) {
    return Promise.resolve(
      Response.json({
        releaseSha: "b4988e2dfc4203e750039c65eab3b6b89f5aec08",
      })
    );
  }
  if (input.endsWith("/readyz")) {
    return Promise.resolve(
      Response.json({
        components: {
          searchProjection: { lagEvents: 0, status: "ok" },
        },
        status: "ready",
      })
    );
  }
  return Promise.resolve(new Response("ok", { status: 200 }));
};

const laggedFetcher = (input: string): Promise<Response> => {
  if (input.endsWith("/version")) {
    return Promise.resolve(
      Response.json({
        releaseSha: "b4988e2dfc4203e750039c65eab3b6b89f5aec08",
      })
    );
  }
  if (input.endsWith("/readyz")) {
    return Promise.resolve(
      Response.json({
        components: {
          searchProjection: { lagEvents: "3", status: "ok" },
        },
        status: "ready",
      })
    );
  }
  return Promise.resolve(new Response("ok", { status: 200 }));
};

describe("resolveDemoTargets", () => {
  it("strips trailing slashes and honors overrides", () => {
    expect(
      resolveDemoTargets({
        JI_DEMO_API_URL: "https://api.example.test/",
        JI_DEMO_APP_URL: "https://app.example.test/",
      })
    ).toEqual({
      apiUrl: "https://api.example.test",
      appUrl: "https://app.example.test",
    });
  });
});

describe("runDemoPreflight", () => {
  it("accepts ready tip with zero lag", async () => {
    const calls: string[] = [];
    const fetcher = (input: string): Promise<Response> => {
      calls.push(input);
      return zeroLagFetcher(input);
    };

    const result = await runDemoPreflight(
      {
        apiUrl: "https://api.example.test",
        appUrl: "https://app.example.test",
      },
      { fetcher }
    );

    expect(result.releaseSha).toBe("b4988e2dfc4203e750039c65eab3b6b89f5aec08");
    expect(result.lagEvents).toBe(0);
    expect(calls).toEqual([
      "https://api.example.test/version",
      "https://api.example.test/readyz",
      "https://app.example.test",
    ]);
  });

  it("rejects non-zero lag", async () => {
    await expect(
      runDemoPreflight(
        {
          apiUrl: "https://api.example.test",
          appUrl: "https://app.example.test",
        },
        { fetcher: laggedFetcher }
      )
    ).rejects.toThrow(/lagEvents is 3/u);
  });
});
