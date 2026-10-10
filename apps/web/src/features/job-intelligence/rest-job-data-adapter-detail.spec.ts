import { afterEach, describe, expect, it } from "bun:test";

process.env.NEXT_PUBLIC_SERVER_URL ??= "http://server.test";

const { createRestJobDataAdapter } = await import("./rest-job-data-adapter");

const AANVRAAG_ID = "00000000-0000-4000-8000-000000000010";
const BRON_ID = "00000000-0000-4000-8000-000000000001";
const fullDescription = "Volledige opdrachtbeschrijving ".repeat(40);
const previewDescription = fullDescription.slice(0, 500);

const originalFetch = globalThis.fetch;

interface FakeDetailServerOptions {
  readonly denyFull?: boolean;
  readonly denyPreviewEnrichment?: boolean;
  readonly failVersions?: boolean;
}

const createFakeDetailServer = ({
  denyFull = false,
  denyPreviewEnrichment = false,
  failVersions = false,
}: FakeDetailServerOptions = {}) => {
  const requestedUrls: URL[] = [];
  const fetch = (input: string | URL | Request): Promise<Response> => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString()
    );
    requestedUrls.push(url);

    if (url.pathname === "/v1/bronnen") {
      if (denyPreviewEnrichment) {
        return Promise.resolve(
          Response.json(
            {
              error: {
                code: "FORBIDDEN",
                message:
                  "The principal is not allowed to invoke this capability",
              },
            },
            { status: 403 }
          )
        );
      }
      return Promise.resolve(
        Response.json([
          { actief: false, bronId: BRON_ID, naam: "Historisch Platform" },
        ])
      );
    }
    if (url.pathname === `/v1/aanvragen/${AANVRAAG_ID}`) {
      const requestsFull = url.searchParams.get("full") === "true";
      if (requestsFull && denyFull) {
        return Promise.resolve(
          Response.json(
            {
              error: {
                code: "FORBIDDEN_FULL",
                message: "Full detail requires the recruiter role",
              },
            },
            { status: 403 }
          )
        );
      }
      return Promise.resolve(
        Response.json({
          aanvraag: {
            beschrijving: requestsFull ? fullDescription : previewDescription,
            bronId: BRON_ID,
            bronReferentie: "HIST-1",
            id: AANVRAAG_ID,
            mode: requestsFull ? "full" : "preview",
            rawPayloadRef: "raw/hist-1.json",
            scrapeRunId: "run-1",
            status: "closed",
            titel: "Historische opdracht",
          },
          markering: null,
        })
      );
    }
    if (url.pathname === `/v1/aanvragen/${AANVRAAG_ID}/versies`) {
      if (failVersions) {
        return Promise.resolve(
          Response.json(
            {
              error: {
                code: "INTERNAL_ERROR",
                message: "Unexpected version-store failure",
              },
            },
            { status: 500 }
          )
        );
      }
      if (denyPreviewEnrichment) {
        return Promise.resolve(
          Response.json(
            {
              error: {
                code: "FORBIDDEN",
                message:
                  "The principal is not allowed to invoke this capability",
              },
            },
            { status: 403 }
          )
        );
      }
      return Promise.resolve(Response.json([]));
    }
    if (url.pathname === "/v1/raw/raw%2Fhist-1.json") {
      return Promise.resolve(Response.json({ preview: "{}" }));
    }
    return Promise.resolve(
      Response.json(
        { error: { code: "NOT_FOUND", message: url.pathname } },
        { status: 404 }
      )
    );
  };
  return { fetch, requestedUrls };
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("REST detail hydration", () => {
  it("requests the authorized full representation instead of the 500-character preview", async () => {
    const server = createFakeDetailServer();
    // SAFETY: the fake implements the fetch input used by the adapter and always returns Response.
    globalThis.fetch = server.fetch as typeof fetch;
    const adapter = createRestJobDataAdapter({ baseUrl: "http://server.test" });

    const detail = await adapter.getById(AANVRAAG_ID);

    expect(detail?.description).toBe(fullDescription);
    expect(detail?.description.length).toBeGreaterThan(500);
    const detailRequests = server.requestedUrls.filter(
      (url) => url.pathname === `/v1/aanvragen/${AANVRAAG_ID}`
    );
    expect(detailRequests).toHaveLength(1);
    expect(detailRequests[0]?.searchParams.get("full")).toBe("true");
  });

  it("keeps an authorized preview visible when recruiter-only enrichment is forbidden", async () => {
    const server = createFakeDetailServer({
      denyFull: true,
      denyPreviewEnrichment: true,
    });
    // SAFETY: the fake implements the fetch input used by the adapter and always returns Response.
    globalThis.fetch = server.fetch as typeof fetch;
    const adapter = createRestJobDataAdapter({ baseUrl: "http://server.test" });

    const detail = await adapter.getById(AANVRAAG_ID);

    expect(detail?.description).toBe(previewDescription);
    const detailRequests = server.requestedUrls.filter(
      (url) => url.pathname === `/v1/aanvragen/${AANVRAAG_ID}`
    );
    expect(detailRequests).toHaveLength(2);
    expect(detailRequests.map((url) => url.searchParams.get("full"))).toEqual([
      "true",
      null,
    ]);
    expect(detail?.sourceRecords[0]?.displayName).toBe(BRON_ID);
    expect(detail?.sourceRecords[0]?.normalizationVersion).toBe("onbekend");
    expect(
      server.requestedUrls.filter((url) => url.pathname === "/v1/bronnen")
    ).toHaveLength(1);
    expect(
      server.requestedUrls.filter(
        (url) => url.pathname === `/v1/aanvragen/${AANVRAAG_ID}/versies`
      )
    ).toHaveLength(1);
  });

  it("does not suppress enrichment permission errors after full detail succeeds", async () => {
    const server = createFakeDetailServer({ denyPreviewEnrichment: true });
    // SAFETY: the fake implements the fetch input used by the adapter and always returns Response.
    globalThis.fetch = server.fetch as typeof fetch;
    const adapter = createRestJobDataAdapter({ baseUrl: "http://server.test" });

    await expect(adapter.getById(AANVRAAG_ID)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("does not swallow non-permission enrichment failures", async () => {
    const server = createFakeDetailServer({
      denyFull: true,
      failVersions: true,
    });
    // SAFETY: the fake implements the fetch input used by the adapter and always returns Response.
    globalThis.fetch = server.fetch as typeof fetch;
    const adapter = createRestJobDataAdapter({ baseUrl: "http://server.test" });

    await expect(adapter.getById(AANVRAAG_ID)).rejects.toMatchObject({
      status: 500,
    });
  });
});
