import { describe, expect, it } from "bun:test";

import {
  createTestSliceARegistry,
  permissionsForRole,
} from "@ji/application/registry";
import { SEARCH_DOCUMENT_PARITY_DEFAULTS } from "@ji/search";

import { createRestCapabilityHandler, restRoutesFromRegistry } from "./rest";

const allowedOrigin = "https://app.catapulze.test";
const browserSessionHeaders = (): Headers =>
  new Headers({
    Cookie: "better-auth.session_token=valid-session",
    Origin: allowedOrigin,
  });

const resolveRecruiter = () =>
  Promise.resolve({
    ok: true as const,
    principal: {
      kind: "user" as const,
      permissions: permissionsForRole("recruiter"),
      subjectId: "user-1",
    },
  });

describe("REST search contract", () => {
  it("returns structured syntax errors for invalid Boolean input", async () => {
    const bundle = createTestSliceARegistry();
    const handler = createRestCapabilityHandler(
      bundle.registry,
      restRoutesFromRegistry(bundle.registry),
      resolveRecruiter,
      { allowedCookieOrigin: allowedOrigin }
    );
    const mockContext = {
      req: {
        json: () => Promise.resolve({ query: "(Azure" }),
        method: "POST",
        path: "/v1/aanvragen/search",
        raw: { headers: browserSessionHeaders() },
        url: "http://localhost/v1/aanvragen/search",
      },
    };
    // SAFETY: The mock supplies only the Hono Context fields exercised by the handler.
    const response = await handler(mockContext as never);
    expect(response.status).toBe(400);
    // SAFETY: The handler returns a registry syntax-error envelope for invalid Boolean input.
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("SYNTAX_ERROR");
  });

  it("returns hits for a valid authenticated search", async () => {
    const bundle = createTestSliceARegistry();
    await bundle.deps.engine.upsertDocument({
      ...SEARCH_DOCUMENT_PARITY_DEFAULTS,
      beschrijving: "Azure kubernetes",
      bronId: "00000000-0000-4000-8000-000000000001",
      contracttype: "detachering",
      id: "00000000-0000-4000-8000-000000000011",
      laatstGezienOp: new Date("2026-08-01T00:00:00.000Z"),
      locatieLand: "NL",
      status: "active",
      tariefMax: 110,
      tariefMin: 90,
      titel: "Azure engineer",
    });
    const handler = createRestCapabilityHandler(
      bundle.registry,
      restRoutesFromRegistry(bundle.registry),
      resolveRecruiter,
      { allowedCookieOrigin: allowedOrigin }
    );
    const mockContext = {
      req: {
        json: () => Promise.resolve({ query: "Azure" }),
        method: "POST",
        path: "/v1/aanvragen/search",
        raw: { headers: browserSessionHeaders() },
        url: "http://localhost/v1/aanvragen/search",
      },
    };
    // SAFETY: The mock supplies only the Hono Context fields exercised by the handler.
    const response = await handler(mockContext as never);
    expect(response.status).toBe(200);
    // SAFETY: The handler returns the validated search_aanvragen output envelope.
    const body = (await response.json()) as { ids: string[]; total: number };
    expect(body.total).toBe(1);
    expect(body.ids).toEqual(["00000000-0000-4000-8000-000000000011"]);
  });

  it("filters lifecycle status in the all-scope REST search and rejects unknown values", async () => {
    const bundle = createTestSliceARegistry();
    const documents = [
      {
        id: "00000000-0000-4000-8000-000000000021",
        status: "active" as const,
        titel: "Active status fixture",
      },
      {
        id: "00000000-0000-4000-8000-000000000022",
        status: "stale" as const,
        titel: "Stale status fixture",
      },
      {
        id: "00000000-0000-4000-8000-000000000023",
        status: "closed" as const,
        titel: "Closed status fixture",
      },
    ];
    await Promise.all(
      documents.map((document) =>
        bundle.deps.engine.upsertDocument({
          ...SEARCH_DOCUMENT_PARITY_DEFAULTS,
          beschrijving: "Lifecycle status fixture",
          bronId: "00000000-0000-4000-8000-000000000001",
          contracttype: null,
          id: document.id,
          laatstGezienOp: new Date("2026-09-01T00:00:00.000Z"),
          locatieLand: "NL",
          status: document.status,
          tariefMax: null,
          tariefMin: null,
          titel: document.titel,
        })
      )
    );

    const handler = createRestCapabilityHandler(
      bundle.registry,
      restRoutesFromRegistry(bundle.registry),
      resolveRecruiter,
      { allowedCookieOrigin: allowedOrigin }
    );
    // SAFETY: this request stub provides the complete context consumed by the REST handler.
    const search = await handler({
      req: {
        json: () =>
          Promise.resolve({
            filters: { status: ["closed"] },
            limit: 10,
            offset: 0,
            query: "",
            scope: "all",
            sort: "relevance",
          }),
        method: "POST",
        path: "/v1/aanvragen/search",
        raw: { headers: browserSessionHeaders() },
        url: "http://localhost/v1/aanvragen/search",
      },
    } as never);
    expect(search.status).toBe(200);
    // SAFETY: the handler returns the validated search_aanvragen output envelope.
    const body = (await search.json()) as {
      facets: { status: { count: number; value: string }[] };
      ids: string[];
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.ids).toEqual(["00000000-0000-4000-8000-000000000023"]);
    expect(body.facets.status).toEqual([{ count: 1, value: "closed" }]);

    // SAFETY: this request stub provides the complete context consumed by the REST handler.
    const invalid = await handler({
      req: {
        json: () =>
          Promise.resolve({
            filters: { status: ["archived"] },
            query: "",
          }),
        method: "POST",
        path: "/v1/aanvragen/search",
        raw: { headers: browserSessionHeaders() },
        url: "http://localhost/v1/aanvragen/search",
      },
    } as never);
    expect(invalid.status).toBe(400);
    // SAFETY: the handler returns the standard REST capability error envelope.
    const invalidBody = (await invalid.json()) as { error: { code: string } };
    expect(invalidBody.error.code).toBe("INVALID_INPUT");
  });
});
