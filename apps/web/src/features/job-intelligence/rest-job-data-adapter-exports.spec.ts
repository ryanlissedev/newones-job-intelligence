import { afterEach, describe, expect, it } from "bun:test";

process.env.NEXT_PUBLIC_SERVER_URL ??= "http://server.test";

const { createRestJobActions } = await import("./rest-job-data-adapter");
const { CapabilityRequestError } = await import("./rest/capability-client");

const originalFetch = globalThis.fetch;

const SNAPSHOT_ROW = {
  actorId: "recruiter-1",
  approval: { actorId: "approver-1", expiresAt: "2099-01-01T00:00:00.000Z" },
  createdAt: "2026-09-25T09:15:00.000Z",
  export: null,
  id: "00000000-0000-4000-8000-0000000000aa",
  query: "Azure AND data",
  resultCount: 3,
  status: "approved",
};

const createFakeListServer = ({
  deny = false,
}: { readonly deny?: boolean } = {}) => {
  const requestedUrls: URL[] = [];
  const fetch = (input: string | URL | Request): Promise<Response> => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString()
    );
    requestedUrls.push(url);
    if (url.pathname === "/v1/snapshots") {
      if (deny) {
        return Promise.resolve(
          Response.json(
            {
              error: {
                code: "FORBIDDEN",
                message:
                  "The principal is not allowed to invoke this capability",
              },
              ok: false,
            },
            { status: 403 }
          )
        );
      }
      return Promise.resolve(
        Response.json({ items: [SNAPSHOT_ROW], nextCursor: "cursor-2" })
      );
    }
    return Promise.resolve(
      Response.json(
        { error: { code: "NOT_FOUND", message: "not found" }, ok: false },
        { status: 404 }
      )
    );
  };
  return { fetch, requestedUrls };
};

describe("REST adapter listSnapshots (CTP-652)", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("GETs /v1/snapshots and returns the page verbatim", async () => {
    const fake = createFakeListServer();
    // SAFETY: the fake implements the fetch input used by the adapter and always returns Response.
    globalThis.fetch = fake.fetch as typeof fetch;

    const actions = createRestJobActions();
    const page = await actions.listSnapshots();

    expect(fake.requestedUrls.map((url) => url.pathname)).toEqual([
      "/v1/snapshots",
    ]);
    expect(fake.requestedUrls[0]?.search).toBe("");
    expect(page.items).toEqual([SNAPSHOT_ROW]);
    expect(page.nextCursor).toBe("cursor-2");
  });

  it("encodes limit and cursor as query params", async () => {
    const fake = createFakeListServer();
    // SAFETY: the fake implements the fetch input used by the adapter and always returns Response.
    globalThis.fetch = fake.fetch as typeof fetch;

    const actions = createRestJobActions();
    await actions.listSnapshots({ cursor: "abc.def", limit: 2 });

    const [url] = fake.requestedUrls;
    expect(url?.searchParams.get("limit")).toBe("2");
    expect(url?.searchParams.get("cursor")).toBe("abc.def");
  });

  it("propagates a 403 as CapabilityRequestError with the API message", async () => {
    const fake = createFakeListServer({ deny: true });
    // SAFETY: the fake implements the fetch input used by the adapter and always returns Response.
    globalThis.fetch = fake.fetch as typeof fetch;

    const actions = createRestJobActions();
    let failure: unknown;
    try {
      await actions.listSnapshots();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(CapabilityRequestError);
    if (failure instanceof CapabilityRequestError) {
      expect(failure.status).toBe(403);
      expect(failure.body.error.code).toBe("FORBIDDEN");
      expect(failure.body.error.message).toBe(
        "The principal is not allowed to invoke this capability"
      );
    }
  });
});
