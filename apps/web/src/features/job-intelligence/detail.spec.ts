import { describe, expect, it } from "bun:test";

import {
  createTestSliceARegistry,
  permissionsForRole,
} from "@ji/application/registry";

import { invokeMcpTool } from "../../../../server/src/capabilities/rest";
import { mapAanvraagToJobListing } from "./rest/aanvraag-mapping";
import { buildBronCatalog } from "./rest/bron-catalog";

const recruiterAuth = {
  principal: {
    kind: "agent" as const,
    permissions: permissionsForRole("recruiter"),
    subjectId: "ui-recruiter",
  },
  requestId: "req-ui-detail",
};

describe("AE3 detail provenance mapping", () => {
  it("maps bron, bron_referentie, scrape_run_id, normalisatieversie and raw preview", () => {
    const bronCatalog = buildBronCatalog([
      {
        bronId: "00000000-0000-4000-8000-000000000001",
        naam: "TenderNed",
      },
    ]);
    const job = mapAanvraagToJobListing({
      aanvraag: {
        beschrijving: "Azure platform beschrijving",
        bronId: "00000000-0000-4000-8000-000000000001",
        bronReferentie: "TN-883021",
        id: "00000000-0000-4000-8000-000000000010",
        rawPayloadRef: "raw/tn-883021.json",
        scrapeRunId: "00000000-0000-4000-8000-000000000020",
        status: "active",
        titel: "Azure engineer",
      },
      bronCatalog,
      rawPreview: '{"title":"Azure engineer"}',
      versies: [
        {
          geldigTot: null,
          geldigVan: "2026-08-01T00:00:00.000Z",
          id: "versie-1",
          normalisatieversie: "norm-v3",
          scrapeRunId: "00000000-0000-4000-8000-000000000020",
        },
      ],
    });

    expect(job.sourceRecords[0]?.reference).toBe("TN-883021");
    expect(job.sourceRecords[0]?.name).toBe("tenderned");
    expect(job.sourceRecords[0]?.displayName).toBe("TenderNed");
    expect(job.sourceRecords[0]?.scrapeRunId).toBe(
      "00000000-0000-4000-8000-000000000020"
    );
    expect(job.sourceRecords[0]?.normalizationVersion).toBe("norm-v3");
    expect(job.rawPreview).toBe('{"title":"Azure engineer"}');
    expect(job.contractType).toBeNull();
    expect(job.location).toBeNull();
    expect(job.organization).toBeNull();
    expect(job.publishedAt).toBeNull();
    expect(job.closingAt).toBeNull();
    expect(job.endDate).toBeNull();
    expect(job.hoursPerWeek).toBeNull();
    expect(job.remote).toBeNull();
    expect(job.startDate).toBeNull();
    expect(job.workArrangement).toBeNull();
    expect(job.country).toBeNull();
    expect(job.rate).toBeNull();
    expect(job.sourceRecords[0]?.firstSeenAt).toBeNull();
    expect(job.sourceRecords[0]?.lastSeenAt).toBeNull();
    expect(job.sourceRecords[0]?.validFrom).toBe("2026-08-01T00:00:00.000Z");
  });

  it("prefers bronUrl for the original vacancy link and accepts max-only rates", () => {
    const job = mapAanvraagToJobListing({
      aanvraag: {
        beschrijving: "Azure platform beschrijving",
        bronId: "bron-1",
        bronReferentie: "REF-1",
        bronUrl: "https://example.test/vacature/1",
        id: "aanvraag-1",
        rawPayloadRef: "raw/ref-1.json",
        scrapeRunId: "run-1",
        status: "active",
        tariefEenheid: "uur",
        tariefMax: 106.5,
        tariefMin: null,
        tariefValuta: "EUR",
        titel: "Azure engineer",
        werkvorm: "Hybride",
      },
      bronCatalog: new Map(),
      versies: [],
    });
    expect(job.sourceRecords[0]?.url).toBe("https://example.test/vacature/1");
    expect(job.rate).toEqual({
      currency: "EUR",
      max: 106.5,
      min: null,
      period: "hour",
    });
    expect(job.remote).toBe(true);
  });

  it("maps min-only rates and preserves every published period", () => {
    const baseAanvraag = {
      beschrijving: "Rate mapping",
      bronId: "bron-rate",
      bronReferentie: "RATE-1",
      id: "aanvraag-rate",
      rawPayloadRef: "raw/rate.json",
      scrapeRunId: "run-rate",
      status: "active",
      titel: "Rate mapping",
    };
    const cases = [
      {
        expected: { currency: "EUR", max: 4250, min: 3750, period: "unknown" },
        tariefEenheid: null,
        tariefMax: 4250,
        tariefMin: 3750,
      },
      {
        expected: { currency: "EUR", max: null, min: 88, period: "day" },
        tariefEenheid: "dag",
        tariefMax: null,
        tariefMin: 88,
      },
      {
        expected: { currency: "EUR", max: 6000, min: 4000, period: "month" },
        tariefEenheid: "maand",
        tariefMax: 6000,
        tariefMin: 4000,
      },
      {
        expected: {
          currency: "EUR",
          max: 120_000,
          min: 90_000,
          period: "year",
        },
        tariefEenheid: "jaar",
        tariefMax: 120_000,
        tariefMin: 90_000,
      },
      {
        expected: {
          currency: "EUR",
          max: 10_000,
          min: null,
          period: "unknown",
        },
        tariefEenheid: "per project",
        tariefMax: 10_000,
        tariefMin: null,
      },
    ] as const;

    for (const rateCase of cases) {
      const { expected, ...rate } = rateCase;
      const job = mapAanvraagToJobListing({
        aanvraag: {
          ...baseAanvraag,
          ...rate,
          tariefValuta: "EUR",
        },
        bronCatalog: new Map(),
        versies: [],
      });
      expect(job.rate).toEqual(expected);
    }
  });

  it("rejects non-EUR, invalid and inverted rates", () => {
    const baseAanvraag = {
      beschrijving: "Rate validation",
      bronId: "bron-rate-validation",
      bronReferentie: "RATE-INVALID",
      id: "aanvraag-rate-invalid",
      rawPayloadRef: "raw/rate-invalid.json",
      scrapeRunId: "run-rate-invalid",
      status: "active",
      tariefEenheid: "uur",
      titel: "Rate validation",
    };
    const invalidCases = [
      { tariefMax: 100, tariefMin: 90, tariefValuta: "USD" },
      { tariefMax: Number.NaN, tariefMin: 90, tariefValuta: "EUR" },
      { tariefMax: 100, tariefMin: -1, tariefValuta: "EUR" },
      { tariefMax: 100, tariefMin: 101, tariefValuta: "EUR" },
      { tariefMax: null, tariefMin: null, tariefValuta: "EUR" },
    ] as const;

    for (const rate of invalidCases) {
      const job = mapAanvraagToJobListing({
        aanvraag: { ...baseAanvraag, ...rate },
        bronCatalog: new Map(),
        versies: [],
      });
      expect(job.rate).toBeNull();
    }
  });

  it("rejects unsafe bronUrl schemes for Herkomst links", () => {
    const unsafeScheme = ["java", "script:"].join("");
    const job = mapAanvraagToJobListing({
      aanvraag: {
        beschrijving: "x",
        bronId: "bron-unsafe",
        bronReferentie: "REF-X",
        bronUrl: `${unsafeScheme}alert(1)`,
        id: "aanvraag-unsafe",
        rawPayloadRef: "raw/x.json",
        scrapeRunId: "run-x",
        status: "active",
        titel: "Unsafe url",
      },
      bronCatalog: new Map(),
      versies: [],
    });
    expect(job.sourceRecords[0]?.url).toBe("#bron/bron-unsafe");
  });

  it("maps only available curated commercial facts", () => {
    const job = mapAanvraagToJobListing({
      aanvraag: {
        beschrijving: "Azure platform beschrijving",
        bronId: "bron-1",
        bronReferentie: "REF-1",
        contracttype: "detachering",
        eindDatum: "2027-02-28",
        id: "aanvraag-1",
        locatie: "Amsterdam, Noord-Holland",
        opdrachtgeverNaam: "Gemeente Amsterdam",
        publicatiedatum: "2026-08-03T09:00:00.000Z",
        rawPayloadRef: "raw/ref-1.json",
        scrapeRunId: "run-1",
        sluitingsdatum: "2026-09-01T12:00:00.000Z",
        startDatum: "2026-10-01",
        status: "active",
        tariefEenheid: "uur",
        tariefMax: 110,
        tariefMin: 90,
        tariefValuta: "EUR",
        titel: "Azure engineer",
        urenPerWeek: "32",
        werkvorm: "Volledig remote",
      },
      bronCatalog: new Map(),
      versies: [
        {
          geldigTot: "2026-08-04T00:00:00.000Z",
          geldigVan: "2026-08-02T00:00:00.000Z",
          id: "versie-1",
          normalisatieversie: "norm-v3",
          scrapeRunId: "run-1",
        },
      ],
    });

    expect(job).toMatchObject({
      closingAt: "2026-09-01T12:00:00.000Z",
      contractType: "detachering",
      endDate: "2027-02-28",
      hoursPerWeek: "32",
      location: "Amsterdam, Noord-Holland",
      organization: "Gemeente Amsterdam",
      publishedAt: "2026-08-03T09:00:00.000Z",
      rate: { currency: "EUR", max: 110, min: 90, period: "hour" },
      remote: true,
      startDate: "2026-10-01",
      workArrangement: "Volledig remote",
    });
  });

  it("maps whitespace-only optional facts to null", () => {
    const job = mapAanvraagToJobListing({
      aanvraag: {
        beschrijving: "Beschrijving",
        bronId: "bron-1",
        bronReferentie: "REF-1",
        eindDatum: "  ",
        id: "aanvraag-1",
        rawPayloadRef: "raw/ref-1.json",
        scrapeRunId: "run-1",
        startDatum: "\t",
        status: "active",
        titel: "Opdracht",
        urenPerWeek: "   ",
      },
      bronCatalog: new Map(),
      versies: [],
    });

    expect(job.endDate).toBeNull();
    expect(job.hoursPerWeek).toBeNull();
    expect(job.startDate).toBeNull();
  });
});

describe("AE5 markeren from UI is visible via MCP get_aanvraag", () => {
  it("returns markering after markeer_aanvraag", async () => {
    const bundle = createTestSliceARegistry();
    const aanvraagId = "00000000-0000-4000-8000-000000000010";
    bundle.deps.stores.aanvragen.seed({
      beschrijving: "Azure platform beschrijving",
      bronId: "00000000-0000-4000-8000-000000000001",
      bronReferentie: "TN-883021",
      id: aanvraagId,
      rawPayloadRef: "raw/tn-883021.json",
      scrapeRunId: "00000000-0000-4000-8000-000000000020",
      status: "active",
      titel: "Azure engineer",
      versies: [],
    });
    bundle.deps.stores.rawPayloads.seed({
      contentType: "application/json",
      full: '{"title":"Azure engineer"}',
      preview: '{"title":"Azure engineer"}',
      ref: "raw/tn-883021.json",
    });

    const markeer = await bundle.registry.createInvoker({
      capabilityId: "markeer_aanvraag",
      operation: "POST /v1/aanvragen/{id}/markering",
      transport: "rest",
    })(
      { aanvraagId, status: "relevant" },
      { ...recruiterAuth, requestId: "req-ui-mark" }
    );
    expect(markeer.ok).toBe(true);

    const mcpGet = await invokeMcpTool(
      bundle.registry,
      "get_aanvraag",
      { id: aanvraagId },
      recruiterAuth.principal,
      "req-ui-get"
    );
    expect(mcpGet.ok).toBe(true);
    if (!mcpGet.ok) {
      return;
    }

    expect(mcpGet.value.markering).toMatchObject({
      reden: null,
      revision: 1,
      status: "relevant",
      updatedAt: expect.any(String),
    });
  });
});

describe("AE3 HTML beschrijving summary (CTP-481)", () => {
  it("strips HTML tags from the list/detail summary while keeping description", () => {
    const job = mapAanvraagToJobListing({
      aanvraag: {
        beschrijving:
          "<p>Wij zoeken een <b>TypeScript</b> engineer.</p><ul><li>React</li></ul>",
        bronId: "bron-nvb",
        bronReferentie: "NVB-1",
        id: "aanvraag-html",
        rawPayloadRef: "raw/nvb-1.json",
        scrapeRunId: "run-nvb",
        status: "active",
        titel: "TypeScript engineer",
      },
      bronCatalog: buildBronCatalog([
        {
          bronId: "bron-nvb",
          naam: "Nationale Vacaturebank",
        },
      ]),
      versies: [],
    });

    expect(job.sourceRecords[0]?.name).toBe("nationale-vacaturebank");
    expect(job.description).toContain("<p>");
    expect(job.summary).toBe("Wij zoeken een TypeScript engineer. React");
    expect(job.summary).not.toContain("<");
  });
});

describe("AE3 entity-encoded beschrijving summary (CTP-483)", () => {
  it("decodes then strips entity-encoded HTML for list summaries", () => {
    const job = mapAanvraagToJobListing({
      aanvraag: {
        beschrijving:
          "&lt;p&gt;Wij zoeken een &lt;b&gt;TypeScript&lt;/b&gt; engineer.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;React&lt;/li&gt;&lt;/ul&gt;",
        bronId: "bron-nvb",
        bronReferentie: "NVB-1",
        id: "aanvraag-html-encoded",
        rawPayloadRef: "raw/nvb-1.json",
        scrapeRunId: "run-nvb",
        status: "active",
        titel: "TypeScript engineer",
      },
      bronCatalog: buildBronCatalog([
        {
          bronId: "bron-nvb",
          naam: "Nationale Vacaturebank",
        },
      ]),
      versies: [],
    });

    expect(job.summary).toBe("Wij zoeken een TypeScript engineer. React");
    expect(job.summary).not.toContain("<");
    expect(job.description).toContain("&lt;p&gt;");
  });
});

describe("CTP-482 enrichment provenance mapping", () => {
  it("passes enrichedFields through to JobListing for aangevuld UI", () => {
    const bronCatalog = buildBronCatalog([
      {
        bronId: "bron-1",
        naam: "TenderNed",
      },
    ]);
    const job = mapAanvraagToJobListing({
      aanvraag: {
        beschrijving: "Locatie onbekend in bron",
        bronId: "bron-1",
        bronReferentie: "REF-ENRICH",
        contracttype: "detachering",
        enrichedFields: [
          { confidence: 0.9, field: "locatie", source: "deterministic" },
          { confidence: 0.79, field: "tarief", source: "deterministic" },
        ],
        id: "aanvraag-enrich-1",
        locatie: "Utrecht",
        rawPayloadRef: "raw/x.json",
        scrapeRunId: "run-1",
        status: "active",
        titel: "Enriched opdracht",
      },
      bronCatalog,
      versies: [],
    });

    expect(job.location).toBe("Utrecht");
    expect(job.enrichedFields).toEqual([
      { confidence: 0.9, field: "locatie", source: "deterministic" },
      { confidence: 0.79, field: "tarief", source: "deterministic" },
    ]);
  });
});

describe("AE3 detail skills/provincie mapping (CTP-514)", () => {
  const bronCatalog = buildBronCatalog([
    {
      bronId: "00000000-0000-4000-8000-000000000001",
      naam: "TenderNed",
    },
  ]);
  const baseAanvraag = {
    beschrijving: "Azure platform beschrijving",
    bronId: "00000000-0000-4000-8000-000000000001",
    bronReferentie: "TN-883021",
    id: "00000000-0000-4000-8000-000000000010",
    rawPayloadRef: "raw/tn-883021.json",
    scrapeRunId: "00000000-0000-4000-8000-000000000020",
    status: "active",
    titel: "Azure engineer",
  };

  it("surfaces the skills and province the API returned", () => {
    const job = mapAanvraagToJobListing({
      aanvraag: {
        ...baseAanvraag,
        provincie: "Noord-Holland",
        skills: ["Java", "Kubernetes"],
      },
      bronCatalog,
      versies: [],
    });

    expect(job.skills).toEqual(["Java", "Kubernetes"]);
    expect(job.provincie).toBe("Noord-Holland");
  });

  it("stays empty when the API returned neither", () => {
    const job = mapAanvraagToJobListing({
      aanvraag: baseAanvraag,
      bronCatalog,
      versies: [],
    });

    expect(job.skills).toEqual([]);
    expect(job.provincie).toBeNull();
  });

  it("surfaces the duur (looptijd) the API returned", () => {
    const job = mapAanvraagToJobListing({
      aanvraag: { ...baseAanvraag, duur: "4 maanden" },
      bronCatalog,
      versies: [],
    });

    expect(job.duration).toBe("4 maanden");
  });

  it("stays null when the API returned no duur", () => {
    const job = mapAanvraagToJobListing({
      aanvraag: baseAanvraag,
      bronCatalog,
      versies: [],
    });

    expect(job.duration).toBeNull();
  });
});
