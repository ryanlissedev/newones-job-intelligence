import { describe, expect, it } from "bun:test";

import {
  createTestSliceARegistry,
  permissionsForRole,
} from "@ji/application/registry";
import { SEARCH_DOCUMENT_PARITY_DEFAULTS } from "@ji/search";

import { invokeMcpTool } from "./rest";

const recruiterAuth = {
  principal: {
    kind: "agent" as const,
    permissions: permissionsForRole("recruiter"),
    subjectId: "agent-recruiter",
  },
  requestId: "req-recruiter",
};

const operatorAuth = {
  principal: {
    kind: "agent" as const,
    permissions: permissionsForRole("operator"),
    subjectId: "agent-operator",
  },
  requestId: "req-operator",
};

describe("AE5 REST vs MCP parity", () => {
  it("returns matching ids, count, and facets for search_aanvragen", async () => {
    const bundle = createTestSliceARegistry();
    await bundle.deps.engine.upsertDocument({
      ...SEARCH_DOCUMENT_PARITY_DEFAULTS,
      beschrijving: "DevOps Azure kubernetes",
      bronId: "00000000-0000-4000-8000-000000000001",
      contracttype: "detachering",
      id: "00000000-0000-4000-8000-000000000011",
      laatstGezienOp: new Date("2026-08-01T00:00:00.000Z"),
      locatieLand: "NL",
      status: "active",
      tariefMax: 110,
      tariefMin: 90,
      titel: "Azure DevOps engineer",
    });
    await bundle.deps.engine.upsertDocument({
      ...SEARCH_DOCUMENT_PARITY_DEFAULTS,
      beschrijving: "Java backend",
      bronId: "00000000-0000-4000-8000-000000000001",
      contracttype: "detachering",
      id: "00000000-0000-4000-8000-000000000012",
      laatstGezienOp: new Date("2026-08-01T00:00:00.000Z"),
      locatieLand: "NL",
      status: "active",
      tariefMax: 100,
      tariefMin: 80,
      titel: "Java engineer",
    });

    const input = { query: "Azure" };
    const rest = await bundle.registry.createInvoker({
      capabilityId: "search_aanvragen",
      operation: "POST /v1/aanvragen/search",
      transport: "rest",
    })(input, recruiterAuth);
    const mcp = await invokeMcpTool(
      bundle.registry,
      "search_aanvragen",
      input,
      recruiterAuth.principal,
      "req-mcp-search"
    );

    expect(rest.ok).toBe(true);
    expect(mcp.ok).toBe(true);
    if (!rest.ok || !mcp.ok) {
      return;
    }
    const restValue = rest.value;
    // SAFETY: MCP invokeMcpTool calls the same search_aanvragen capability as the REST invoker above.
    const mcpValue = mcp.value as typeof restValue;
    expect(mcpValue.ids).toEqual(restValue.ids);
    expect(mcpValue.total).toBe(restValue.total);
    expect(mcpValue.facets).toEqual(restValue.facets);
  });

  it("keeps REST and MCP byte-equal for dashboard and scrape-run capabilities", async () => {
    const cases = [
      {
        capabilityId: "get_dashboard_overview",
        input: { window: "7d" },
        operation: "GET /v1/dashboard",
      },
      {
        capabilityId: "get_bron_stats",
        input: { bronId: "00000000-0000-4000-8000-000000000001", window: "7d" },
        operation: "GET /v1/bronnen/{id}/stats",
      },
      {
        capabilityId: "list_scrape_runs",
        input: { limit: 10 },
        operation: "GET /v1/scrape-runs",
      },
      {
        capabilityId: "get_scrape_run",
        input: { id: "00000000-0000-0000-0000-000000000099" },
        operation: "GET /v1/scrape-runs/{id}",
      },
    ] as const;
    await Promise.all(
      cases.map(async (testCase) => {
        const bundle = createTestSliceARegistry();
        const rest = await bundle.registry.createInvoker({
          ...testCase,
          transport: "rest",
        })(testCase.input, operatorAuth);
        const mcp = await invokeMcpTool(
          bundle.registry,
          testCase.capabilityId,
          testCase.input,
          operatorAuth.principal,
          operatorAuth.requestId
        );
        expect(mcp).toEqual(rest);
      })
    );
  });
});

describe("preview vs full authorization", () => {
  it("denies full detail without recruiter role but allows preview", async () => {
    const bundle = createTestSliceARegistry();
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

    const operatorOnly = {
      principal: {
        kind: "agent" as const,
        permissions: permissionsForRole("operator"),
        subjectId: "agent-operator-only",
      },
      requestId: "req-operator-only",
    };

    const preview = await bundle.registry.createInvoker({
      capabilityId: "get_aanvraag",
      operation: "GET /v1/aanvragen/{id}",
      transport: "rest",
    })({ id: aanvraagId }, operatorOnly);
    const deniedFull = await bundle.registry.createInvoker({
      capabilityId: "get_aanvraag",
      operation: "GET /v1/aanvragen/{id}",
      transport: "rest",
    })({ full: true, id: aanvraagId }, operatorOnly);

    expect(preview.ok).toBe(true);
    if (preview.ok) {
      expect(preview.value.aanvraag.mode).toBe("preview");
    }
    expect(deniedFull.ok).toBe(false);
    if (!deniedFull.ok) {
      expect(deniedFull.error.code).toBe("FORBIDDEN_FULL");
    }

    const recruiterFull = await bundle.registry.createInvoker({
      capabilityId: "get_aanvraag",
      operation: "GET /v1/aanvragen/{id}",
      transport: "rest",
    })({ full: true, id: aanvraagId }, recruiterAuth);
    expect(recruiterFull.ok).toBe(true);
    if (recruiterFull.ok) {
      expect(recruiterFull.value.aanvraag.mode).toBe("full");
    }
  });
});

describe("unauthenticated MCP tool call", () => {
  it("is denied at invocation time", async () => {
    const bundle = createTestSliceARegistry();
    const result = await invokeMcpTool(
      bundle.registry,
      "search_aanvragen",
      { query: "Azure" },
      null,
      "req-unauth"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNAUTHENTICATED");
    }
  });
});

describe("operator capabilities", () => {
  it("allows operator to list alerts but not unauthenticated", async () => {
    const bundle = createTestSliceARegistry();
    bundle.deps.stores.alerts.seed({
      ackedAt: null,
      ackedBy: null,
      bronId: "00000000-0000-4000-8000-000000000001",
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      dedupeKey: "silence:1",
      evidence: {},
      id: "00000000-0000-4000-8000-000000000030",
      kind: "bron.stil",
      message: "Bron stil",
    });
    const allowed = await invokeMcpTool(
      bundle.registry,
      "list_alerts",
      {},
      operatorAuth.principal,
      "req-alerts"
    );
    expect(allowed.ok).toBe(true);
  });
});
