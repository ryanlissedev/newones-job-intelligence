import { afterEach, describe, expect, it } from "bun:test";

process.env.NEXT_PUBLIC_SERVER_URL ??= "http://server.test";

const { createRestJobActions } = await import("./rest-job-data-adapter");

const SNAPSHOT_ID = "00000000-0000-4000-8000-0000000000aa";

const originalFetch = globalThis.fetch;

interface FakeSnapshotServerOptions {
  readonly approvalStatus?: number;
  readonly denyApproval?: boolean;
  readonly denyExport?: boolean;
}

const forbidden = (capability: string): Response =>
  Response.json(
    {
      error: {
        code: "FORBIDDEN",
        message: `The principal is not allowed to invoke ${capability}`,
      },
    },
    { status: 403 }
  );

const createFakeSnapshotServer = ({
  approvalStatus = 200,
  denyApproval = false,
  denyExport = false,
}: FakeSnapshotServerOptions = {}) => {
  const requests: { body: unknown; method: string; url: URL }[] = [];
  const fetch = (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString()
    );
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    const rawBody = init?.body;
    // The capability client always serializes JSON bodies with
    // JSON.stringify, so a present body is already a JSON string.
    const body = rawBody ? JSON.parse(String(rawBody)) : null;
    requests.push({ body, method, url });

    if (url.pathname === `/v1/snapshots/${SNAPSHOT_ID}` && method === "GET") {
      return Promise.resolve(
        Response.json({
          approval: null,
          createdAt: "2026-09-25T08:00:00.000Z",
          freshness: {
            searchAppliedSequence: "42",
            searchGeneration: 3,
          },
          id: SNAPSHOT_ID,
          provenance: { parserVersion: "v2", schemaVersion: "slice-a-v1" },
          queryDigest: "a".repeat(64),
          resultIds: ["job-1", "job-2"],
          savedSearchId: null,
          scope: "active",
          selectionDigest: "b".repeat(64),
        })
      );
    }
    if (url.pathname === `/v1/snapshots/${SNAPSHOT_ID}/approval`) {
      if (denyApproval) {
        return Promise.resolve(forbidden("approve_snapshot"));
      }
      if (method === "GET") {
        if (approvalStatus === 400) {
          return Promise.resolve(
            Response.json(
              {
                error: {
                  code: "APPROVAL_NOT_FOUND",
                  details: { id: SNAPSHOT_ID },
                  message: "No approval exists for this snapshot",
                },
              },
              { status: 400 }
            )
          );
        }
        return Promise.resolve(
          Response.json({
            actorId: "actor-1",
            createdAt: "2026-09-25T09:00:00.000Z",
            expiresAt: "2026-10-02T09:00:00.000Z",
            id: "approval-1",
            motivatie: "Klant akkoord",
            resultIds: ["job-1", "job-2"],
            snapshotId: SNAPSHOT_ID,
            valid: true,
          })
        );
      }
      if (method === "POST") {
        return Promise.resolve(
          Response.json({
            actorId: "actor-1",
            auditEventId: "audit-1",
            createdAt: "2026-09-25T09:00:00.000Z",
            expiresAt: "2026-10-02T09:00:00.000Z",
            id: "approval-1",
            motivatie: "Klant akkoord",
            resultIds: ["job-1", "job-2"],
            snapshotId: SNAPSHOT_ID,
          })
        );
      }
    }
    if (url.pathname === "/v1/exports" && method === "POST") {
      if (denyExport) {
        return Promise.resolve(forbidden("commit_export"));
      }
      return Promise.resolve(
        Response.json({
          approvalId: "approval-1",
          auditEventId: "audit-2",
          results: [
            {
              canonicalVacancyId: "job-1",
              externalId: "spott-1",
              idempotencyKey: "key-1",
              receiptId: "receipt-1",
              status: "created",
            },
          ],
          snapshotId: SNAPSHOT_ID,
          summary: { created: 1, failed: 0, skipped: 1 },
        })
      );
    }
    if (url.pathname === `/v1/exports/${SNAPSHOT_ID}` && method === "GET") {
      return Promise.resolve(
        Response.json({
          attempts: [
            {
              canonicalVacancyId: "job-1",
              createdAt: "2026-09-25T09:05:00.000Z",
              errorMessage: null,
              externalId: "spott-1",
              id: "attempt-1",
              idempotencyKey: "key-1",
              receipt: { id: "receipt-1", responseHash: "c".repeat(64) },
              status: "attempted",
            },
          ],
          liveConfirmationAvailable: false,
          snapshotId: SNAPSHOT_ID,
          status: "attempted",
        })
      );
    }
    return Promise.resolve(
      Response.json(
        { error: { code: "NOT_FOUND", message: url.pathname } },
        { status: 404 }
      )
    );
  };
  return { fetch, requests };
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("REST snapshot/approval/export actions (CTP-652)", () => {
  it("GETs /v1/snapshots/{id} for getSnapshot", async () => {
    const server = createFakeSnapshotServer();
    // SAFETY: the fake implements the fetch surface the client uses.
    globalThis.fetch = server.fetch as typeof fetch;
    const actions = createRestJobActions({ baseUrl: "http://server.test" });

    const snapshot = await actions.getSnapshot(SNAPSHOT_ID);

    expect(snapshot.id).toBe(SNAPSHOT_ID);
    expect(snapshot.resultIds).toEqual(["job-1", "job-2"]);
    expect(snapshot.approval).toBeNull();
    expect(
      server.requests.filter(
        (request) => request.url.pathname === `/v1/snapshots/${SNAPSHOT_ID}`
      )
    ).toHaveLength(1);
  });

  it("maps APPROVAL_NOT_FOUND (400) to null on getSnapshotApproval", async () => {
    const server = createFakeSnapshotServer({ approvalStatus: 400 });
    // SAFETY: the fake implements the fetch surface the client uses.
    globalThis.fetch = server.fetch as typeof fetch;
    const actions = createRestJobActions({ baseUrl: "http://server.test" });

    await expect(actions.getSnapshotApproval(SNAPSHOT_ID)).resolves.toBeNull();
  });

  it("returns the approval view when one exists", async () => {
    const server = createFakeSnapshotServer();
    // SAFETY: the fake implements the fetch surface the client uses.
    globalThis.fetch = server.fetch as typeof fetch;
    const actions = createRestJobActions({ baseUrl: "http://server.test" });

    const approval = await actions.getSnapshotApproval(SNAPSHOT_ID);

    expect(approval?.valid).toBe(true);
    expect(approval?.motivatie).toBe("Klant akkoord");
  });

  it("POSTs {expiresAt, motivatie} to /v1/snapshots/{id}/approval", async () => {
    const server = createFakeSnapshotServer();
    // SAFETY: the fake implements the fetch surface the client uses.
    globalThis.fetch = server.fetch as typeof fetch;
    const actions = createRestJobActions({ baseUrl: "http://server.test" });

    const view = await actions.approveSnapshot({
      expiresAt: "2026-10-02T09:00:00.000Z",
      id: SNAPSHOT_ID,
      motivatie: "Klant akkoord",
    });

    expect(view.id).toBe("approval-1");
    expect(view.auditEventId).toBe("audit-1");
    const post = server.requests.find(
      (request) =>
        request.url.pathname === `/v1/snapshots/${SNAPSHOT_ID}/approval` &&
        request.method === "POST"
    );
    expect(post?.body).toEqual({
      expiresAt: "2026-10-02T09:00:00.000Z",
      motivatie: "Klant akkoord",
    });
  });

  it("propagates a 403 from approveSnapshot as a permission failure", async () => {
    const server = createFakeSnapshotServer({ denyApproval: true });
    // SAFETY: the fake implements the fetch surface the client uses.
    globalThis.fetch = server.fetch as typeof fetch;
    const actions = createRestJobActions({ baseUrl: "http://server.test" });

    await expect(
      actions.approveSnapshot({
        expiresAt: "2026-10-02T09:00:00.000Z",
        id: SNAPSHOT_ID,
        motivatie: "x",
      })
    ).rejects.toMatchObject({
      body: { error: { code: "FORBIDDEN" } },
      status: 403,
    });
  });

  it("POSTs {snapshotId} to /v1/exports and returns the summary", async () => {
    const server = createFakeSnapshotServer();
    // SAFETY: the fake implements the fetch surface the client uses.
    globalThis.fetch = server.fetch as typeof fetch;
    const actions = createRestJobActions({ baseUrl: "http://server.test" });

    const result = await actions.commitExport(SNAPSHOT_ID);

    expect(result.summary).toEqual({ created: 1, failed: 0, skipped: 1 });
    expect(result.results[0]?.externalId).toBe("spott-1");
    const post = server.requests.find(
      (request) =>
        request.url.pathname === "/v1/exports" && request.method === "POST"
    );
    expect(post?.body).toEqual({ snapshotId: SNAPSHOT_ID });
  });

  it("propagates a 403 from commitExport", async () => {
    const server = createFakeSnapshotServer({ denyExport: true });
    // SAFETY: the fake implements the fetch surface the client uses.
    globalThis.fetch = server.fetch as typeof fetch;
    const actions = createRestJobActions({ baseUrl: "http://server.test" });

    await expect(actions.commitExport(SNAPSHOT_ID)).rejects.toMatchObject({
      body: { error: { code: "FORBIDDEN" } },
      status: 403,
    });
  });

  it("GETs /v1/exports/{snapshotId} and returns attempts with receipts", async () => {
    const server = createFakeSnapshotServer();
    // SAFETY: the fake implements the fetch surface the client uses.
    globalThis.fetch = server.fetch as typeof fetch;
    const actions = createRestJobActions({ baseUrl: "http://server.test" });

    const status = await actions.getExportStatus(SNAPSHOT_ID);

    expect(status.status).toBe("attempted");
    expect(status.attempts[0]?.receipt?.id).toBe("receipt-1");
    expect(status.liveConfirmationAvailable).toBe(false);
  });
});
