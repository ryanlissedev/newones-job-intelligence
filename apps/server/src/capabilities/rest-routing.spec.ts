import { describe, expect, it } from "bun:test";

import {
  createTestSliceARegistry,
  permissionsForRole,
} from "@ji/application/registry";
import { Hono } from "hono";

import type { PrincipalResolver } from "./auth";
import {
  createRestCapabilityHandler,
  matchPath,
  restRouteSpecificity,
  restRoutesFromRegistry,
} from "./rest";

const adminResolver: PrincipalResolver = () =>
  Promise.resolve({
    ok: true,
    principal: {
      kind: "user",
      permissions: permissionsForRole("admin"),
      subjectId: "rest-routing-admin",
    },
  });

const operatorResolver: PrincipalResolver = () =>
  Promise.resolve({
    ok: true,
    principal: {
      kind: "user",
      permissions: permissionsForRole("operator"),
      subjectId: "rest-routing-operator",
    },
  });

const recruiterResolver: PrincipalResolver = () =>
  Promise.resolve({
    ok: true,
    principal: {
      kind: "user",
      permissions: permissionsForRole("recruiter"),
      subjectId: "rest-routing-recruiter",
    },
  });

const mountRest = (resolver: PrincipalResolver = adminResolver) => {
  const bundle = createTestSliceARegistry();
  const routes = restRoutesFromRegistry(bundle.registry);
  const rest = createRestCapabilityHandler(bundle.registry, routes, resolver, {
    allowedCookieOrigin: "https://app.catapulze.test",
  });
  const app = new Hono();
  app.all("/v1/*", rest);
  return { app, bundle, routes };
};

const seedAanvraag = (bundle: ReturnType<typeof createTestSliceARegistry>) => {
  const aanvraagId = "00000000-0000-4000-8000-000000000010";
  bundle.deps.stores.aanvragen.seed({
    beschrijving: "Lang ".repeat(200),
    bronId: "00000000-0000-4000-8000-000000000001",
    bronReferentie: "TN-1",
    id: aanvraagId,
    rawPayloadRef: "raw/tn-1.json",
    scrapeRunId: "00000000-0000-4000-8000-000000000020",
    status: "active",
    titel: "Test",
    versies: [],
  });
  return aanvraagId;
};

describe("REST route specificity (CTP-417 overlap shadow)", () => {
  it("ranks static /v1/bronnen/overlap above /v1/bronnen/{id}", () => {
    expect(restRouteSpecificity("/v1/bronnen/overlap")).toBeGreaterThan(
      restRouteSpecificity("/v1/bronnen/{id}")
    );
  });

  it("lists get_bron_overlap before get_bron for the overlap pathname", () => {
    const { routes } = mountRest();
    const pathname = "/v1/bronnen/overlap";
    const matches = routes.filter(
      (route) =>
        route.method === "GET" &&
        matchPath(route.pathPattern, pathname) !== null
    );
    expect(matches.map((route) => route.capabilityId)).toEqual([
      "get_bron_overlap",
      "get_bron",
    ]);
  });

  it("serves GET /v1/bronnen/overlap via get_bron_overlap (200)", async () => {
    const { app } = mountRest();
    const response = await app.request("/v1/bronnen/overlap");
    expect(response.status).toBe(200);
    // SAFETY: get_bron_overlap output schema guarantees this shape on 200.
    const body = (await response.json()) as {
      readonly overlapGroepCount: number;
      readonly perBron: unknown[];
      readonly topGroups: unknown[];
    };
    expect(body.overlapGroepCount).toBe(0);
    expect(body.perBron).toEqual([]);
    expect(body.topGroups).toEqual([]);
  });

  it("still resolves UUID bron ids through get_bron", async () => {
    const { app } = mountRest();
    const response = await app.request(
      "/v1/bronnen/00000000-0000-4000-8000-000000000001"
    );
    expect(response.status).toBe(200);
    // SAFETY: get_bron output includes bronId for a known fixture id.
    const body = (await response.json()) as { readonly bronId: string };
    expect(body.bronId).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("keeps /v1/bronnen/overview as get_bron INVALID_INPUT (not a capability)", async () => {
    // No REST /v1/bronnen/overview — operator KPIs use GET /v1/dashboard.
    // Without a static sibling, {id} still captures the slug and UuidString
    // rejects it. Same failure mode Catapulze saw next to overlap; separate
    // from the overlap shadow once overlap is unshadowed.
    const { app } = mountRest();
    const response = await app.request("/v1/bronnen/overview");
    expect(response.status).toBe(400);
    // SAFETY: registry INVALID_INPUT failures always carry error.code.
    const body = (await response.json()) as {
      readonly error: { readonly code: string };
    };
    expect(body.error.code).toBe("INVALID_INPUT");
  });
});

describe("REST get_aanvraag full query normalization", () => {
  it("keeps preview accessible to operators and does not treat full=false as true", async () => {
    const { app, bundle } = mountRest(operatorResolver);
    const aanvraagId = seedAanvraag(bundle);

    const response = await app.request(
      `/v1/aanvragen/${aanvraagId}?full=false`
    );

    expect(response.status).toBe(200);
    // SAFETY: a 200 get_aanvraag response is validated by the registry output schema.
    const body = (await response.json()) as {
      readonly aanvraag: { readonly mode: string };
    };
    expect(body.aanvraag.mode).toBe("preview");
  });

  it("denies normalized full=true to operators", async () => {
    const { app, bundle } = mountRest(operatorResolver);
    const aanvraagId = seedAanvraag(bundle);

    const response = await app.request(`/v1/aanvragen/${aanvraagId}?full=true`);

    expect(response.status).toBe(403);
    // SAFETY: domain failures from the REST handler always carry error.code.
    const body = (await response.json()) as {
      readonly error: { readonly code: string };
    };
    expect(body.error.code).toBe("FORBIDDEN_FULL");
  });

  it("rejects malformed full values instead of silently returning preview", async () => {
    const { app, bundle } = mountRest(recruiterResolver);
    const aanvraagId = seedAanvraag(bundle);

    const response = await app.request(`/v1/aanvragen/${aanvraagId}?full=1`);

    expect(response.status).toBe(400);
    // SAFETY: registry input-validation failures always carry error.code.
    const body = (await response.json()) as {
      readonly error: { readonly code: string };
    };
    expect(body.error.code).toBe("INVALID_INPUT");
  });

  it("keeps POST boolean fields strict outside get_aanvraag", async () => {
    const { app } = mountRest(recruiterResolver);

    const response = await app.request("/v1/aanvragen/batch", {
      body: JSON.stringify({
        full: "true",
        ids: ["00000000-0000-4000-8000-000000000010"],
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(400);
    // SAFETY: registry input-validation failures always carry error.code.
    const body = (await response.json()) as {
      readonly error: { readonly code: string };
    };
    expect(body.error.code).toBe("INVALID_INPUT");
  });

  it("returns the full representation to recruiters", async () => {
    const { app, bundle } = mountRest(recruiterResolver);
    const aanvraagId = seedAanvraag(bundle);

    const response = await app.request(`/v1/aanvragen/${aanvraagId}?full=true`);

    expect(response.status).toBe(200);
    // SAFETY: a 200 get_aanvraag response is validated by the registry output schema.
    const body = (await response.json()) as {
      readonly aanvraag: {
        readonly beschrijving: string;
        readonly mode: string;
      };
    };
    expect(body.aanvraag.mode).toBe("full");
    expect(body.aanvraag.beschrijving.length).toBeGreaterThan(500);
  });
});
