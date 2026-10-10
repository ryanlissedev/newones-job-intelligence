import { describe, expect, it } from "bun:test";

import {
  createSpottClient,
  createSpottWriteClient,
  SpottRateLimitError,
  SPOTT_API_BASE_URL,
  SPOTT_API_KEY_HEADER,
  SPOTT_FIXTURE_CONTRACT_VERSION,
  loadSpottFixture,
} from "./index";
import type { SpottListVacanciesResponse } from "./index";

describe("Spott fixture loader", () => {
  it("loads repo-owned vacancy list fixtures", async () => {
    const fixture = await loadSpottFixture<SpottListVacanciesResponse>(
      "vacancies-page-0.json"
    );
    expect(fixture.contractVersion).toBe(SPOTT_FIXTURE_CONTRACT_VERSION);
    expect(fixture.endpoint).toBe("GET /vacancies");
    expect(fixture.payload.items).toHaveLength(2);
    expect(fixture.payload.items[0]?.id).toBe("vacancy-fixture-001");
  });
});

describe("Spott REST client (fixture mode)", () => {
  it("lists vacancies from fixtures without a live API key", async () => {
    const client = createSpottClient({ liveEnabled: false });
    const response = await client.listVacancies();

    expect(response.items).toHaveLength(2);
    expect(response.pageInfo.hasNextPage).toBe(true);
    expect(response.pageInfo.nextCursor).toBeTruthy();
  });

  it("returns an empty page when a cursor is supplied in fixture mode", async () => {
    const client = createSpottClient({ liveEnabled: false });
    const response = await client.listVacancies({
      cursor: "eyJpZCI6InZhY2FuY3ktZml4dHVyZS0wMDIifQ==",
    });

    expect(response.items).toHaveLength(0);
    expect(response.pageInfo.hasNextPage).toBe(false);
  });

  it("gets a vacancy by id from fixtures", async () => {
    const client = createSpottClient({ liveEnabled: false });
    const vacancy = await client.getVacancy("vacancy-fixture-001");

    expect(vacancy.id).toBe("vacancy-fixture-001");
    expect(vacancy.companyId).toBe("company-fixture-001");
    expect(vacancy.stageId).toBe("stage-fixture-001");
  });

  it("returns 404 for unknown vacancy ids in fixture mode", async () => {
    const client = createSpottClient({ liveEnabled: false });

    await expect(client.getVacancy("missing-vacancy")).rejects.toMatchObject({
      name: "SpottApiError",
      status: 404,
    });
  });
});

describe("Spott REST client (live mode via fetchImpl)", () => {
  it("sends x-api-key and hits GET /vacancies", async () => {
    let capturedUrl = "";
    let capturedHeaders: RequestInit["headers"];

    const client = createSpottClient({
      apiKey: "test-key-redacted",
      fetchImpl: (input, init) => {
        capturedUrl = String(input);
        capturedHeaders = init?.headers;
        return Promise.resolve(
          Response.json({
            items: [
              {
                description: null,
                id: "live-1",
                name: "Live",
                restricted: false,
              },
            ],
            pageInfo: { hasNextPage: false, nextCursor: null },
          })
        );
      },
      liveEnabled: true,
    });

    const response = await client.listVacancies({ limit: 25 });

    expect(capturedUrl).toBe(`${SPOTT_API_BASE_URL}/vacancies?limit=25`);
    expect(capturedHeaders).toMatchObject({
      [SPOTT_API_KEY_HEADER]: "test-key-redacted",
    });
    expect(response.items[0]?.id).toBe("live-1");
  });

  it("maps 429 responses to SpottRateLimitError", async () => {
    const client = createSpottClient({
      apiKey: "test-key-redacted",
      fetchImpl: () =>
        Promise.resolve(new Response("Too Many Requests", { status: 429 })),
      liveEnabled: true,
    });

    await expect(client.listVacancies()).rejects.toBeInstanceOf(
      SpottRateLimitError
    );
  });

  it("requires SPOTT_API_KEY when live and no apiKey option is passed", async () => {
    const previous = process.env.SPOTT_API_KEY;
    delete process.env.SPOTT_API_KEY;

    const client = createSpottClient({
      fetchImpl: () => Promise.resolve(Response.json({})),
      liveEnabled: true,
    });

    try {
      await expect(client.listVacancies()).rejects.toThrow(/SPOTT_API_KEY/u);
    } finally {
      if (previous === undefined) {
        delete process.env.SPOTT_API_KEY;
      } else {
        process.env.SPOTT_API_KEY = previous;
      }
    }
  });
});

describe("Spott write client guardrails", () => {
  it("creates vacancies in fixture mode without live network", async () => {
    const client = createSpottWriteClient({ liveEnabled: false });

    const response = await client.createVacancy({
      clientContactIds: [],
      companyId: "company-fixture-001",
      description: "Fixture write path",
      employmentType: "contract",
      endAt: null,
      location: null,
      locationType: "remote",
      name: "Fixture vacancy",
      salaryRange: null,
      stageId: "stage-fixture-001",
      startAt: null,
      targetCompanyId: null,
      teamUserIds: [],
    });

    expect(response.id).toMatch(/^spott-fixture-/u);
    const confirmed = await client.getVacancy(response.id);
    expect(confirmed.id).toBe(response.id);
    expect(confirmed.name).toBe("Fixture vacancy");
  });
});

describe("Spott external id contract", () => {
  it("uses vacancy id as the unique downstream identifier", async () => {
    const client = createSpottClient({ liveEnabled: false });
    const listed = await client.listVacancies();
    const firstId = listed.items[0]?.id;
    expect(firstId).toBeDefined();
    if (firstId === undefined) {
      throw new Error("expected at least one fixture vacancy");
    }

    const detail = await client.getVacancy(firstId);
    expect(detail.id).toBe(firstId);
    expect(detail.id.length).toBeGreaterThan(0);
  });
});
