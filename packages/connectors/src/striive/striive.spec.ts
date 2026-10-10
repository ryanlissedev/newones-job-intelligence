import { describe, expect, it } from "bun:test";

import {
  CrawlDelayLimiter,
  InMemoryObjectStore,
  InMemoryObservationRecorder,
  InMemoryRunLifecycleStore,
  runConnector,
} from "@ji/connectors";

import { createStriiveClient, striiveBronReferentie } from "./client";
import type { StriiveClient } from "./client";
import { createStriiveConnector, projectStriiveContacts } from "./connector";
import type { StriiveFetchedPayload, StriiveJob } from "./types";
import { STRIIVE_MAX_PAGES, STRIIVE_PAGE_SIZE } from "./types";

const retryPolicy = {
  initialDelayMs: 0,
  jitter: (delayMs: number) => delayMs,
  maxAttempts: 1,
  maxDelayMs: 0,
  multiplier: 1,
};

describe("Striive listing helpers", () => {
  it("uses the job id as bronReferentie", () => {
    expect(striiveBronReferentie({ id: "abc-123" })).toBe("abc-123");
  });
});

describe("Striive contact projection (CTP-610)", () => {
  it("folds the recruiter, order contact and requester slots", () => {
    expect(
      projectStriiveContacts({
        id: "j1",
        orderContactFullName: "K. Klant",
        recruiterEmail: "recruiter@example.invalid",
        recruiterFirstName: "J.",
        recruiterFunctionTitle: "Recruiter",
        recruiterLastName: "Cruiter",
        recruiterPhoneNumber: "+31000000000",
        requesterEmail: "aanvrager@example.invalid",
        title: "t",
      })
    ).toEqual([
      {
        email: "recruiter@example.invalid",
        naam: "J. Cruiter",
        rol: "Recruiter",
        telefoon: "+31000000000",
      },
      { naam: "K. Klant", rol: "ordercontact" },
      { email: "aanvrager@example.invalid", rol: "aanvrager" },
    ]);
  });

  it("drops orderContactLegalName (an org, not a person) and dedupes the requester", () => {
    expect(
      projectStriiveContacts({
        id: "j2",
        orderContactLegalName: "Klant BV",
        recruiterEmail: "shared@example.invalid",
        requesterEmail: "shared@example.invalid",
        title: "t",
      })
    ).toEqual([
      {
        email: "shared@example.invalid",
        naam: null,
        rol: null,
        telefoon: null,
      },
    ]);
  });

  it("returns null when every contact slot is empty (the fixture state)", () => {
    expect(projectStriiveContacts({ id: "j3", title: "t" })).toBeNull();
  });
});

describe("Striive connector", () => {
  it("ingests the real listing fixture with found/new/changed/rejected/error metrics", async () => {
    const bronId = "bron-striive-fixture";
    const result = await runConnector({
      bronId,
      bronSlug: "striive",
      checkpoint: null,
      connector: createStriiveConnector({
        bronId,
        client: createStriiveClient({ liveEnabled: false }),
      }),
      limiter: new CrawlDelayLimiter({ crawlDelayMs: 0 }),
      objectStore: new InMemoryObjectStore(),
      observationRecorder: new InMemoryObservationRecorder(),
      rawRetentionDays: 90,
      retryPolicy,
      runKind: "test",
      runLifecycleStore: new InMemoryRunLifecycleStore(),
      scrapeRunId: "run-striive-1",
      startedAt: new Date("2026-08-31T13:31:00.000Z"),
    });

    expect(result.metrics).toMatchObject({
      changed: 0,
      error: 0,
      found: 5,
      new: 5,
      rejected: 0,
    });
  });

  it("projects the real fixture job into a whitelisted payload with no recruiter PII", async () => {
    const bronId = "bron-striive-project";
    const connector = createStriiveConnector({
      bronId,
      client: createStriiveClient({ liveEnabled: false }),
    });
    const discovered = await connector.discover(null);
    const [target] = discovered.items;
    if (!target) {
      throw new Error("expected the fixture job in discovered items");
    }
    expect(target.bronReferentie).toBe("d0ab03db-13d1-42d4-a55d-3d238f02b3c0");
    const fetched = await connector.fetch(target);
    expect(fetched?.status).toBe("fetched");
    if (fetched?.status !== "fetched") {
      throw new Error("expected fetched result");
    }
    // SAFETY: the connector serialises StriiveFetchedPayload; only the
    // whitelisted job shape asserted below is inspected here.
    const payload = JSON.parse(
      new TextDecoder().decode(fetched.body)
    ) as StriiveFetchedPayload;

    expect(payload.job.title).toBe("Functioneel Beheerder Youforce");
    expect(payload.job.clientName).toBe("WMD Drinkwater N.V.");
    expect(payload.job.brokerUrl).toBe(
      "https://striive.com/nl/opdrachten?id=d0ab03db-13d1-42d4-a55d-3d238f02b3c0"
    );
    for (const piiKey of [
      "recruiterFirstName",
      "recruiterLastName",
      "recruiterEmail",
      "recruiterPhoneNumber",
    ]) {
      expect(payload.job).not.toHaveProperty(piiKey);
    }
    // CTP-524 F09: tariff fields are commercial facts, not PII -- DEC-008
    // does not exclude them. The fixture predates them, so the projection
    // fills each in as null rather than omitting the key.
    expect(payload.job.hasMaxRate).toBeNull();
    expect(payload.job.hourlyRateMin).toBeNull();
    expect(payload.job.hourlyRateMax).toBeNull();
    expect(payload.job.monthlyRateMin).toBeNull();
    expect(payload.job.monthlyRateMax).toBeNull();
    expect(payload.job.rateType).toBeNull();
    // CTP-524 F06/F15: jobType (contract) and tags (skills) are real live
    // fields (confirmed 2026-09-15), same treatment as tariff above.
    expect(payload.job.jobType).toBeNull();
    expect(payload.job.tags).toBeNull();
  });

  it("rejects a listing row missing an id/title", async () => {
    const bronId = "bron-striive-missing-id";
    const client: StriiveClient = {
      fetchListing: () =>
        Promise.resolve({
          data: [{ id: "", title: "" } satisfies StriiveJob],
          total: 1,
        }),
    };
    const connector = createStriiveConnector({ bronId, client });
    const discovered = await connector.discover(null);
    const [item] = discovered.items;
    if (!item) {
      throw new Error("expected one discover item");
    }
    const fetched = await connector.fetch(item);
    expect(fetched?.status).toBe("rejected");
  });

  it("replays fixture ingest without duplicate source records", async () => {
    const bronId = "bron-striive-replay";
    const recorder = new InMemoryObservationRecorder();
    const objectStore = new InMemoryObjectStore();
    const connector = createStriiveConnector({
      bronId,
      client: createStriiveClient({ liveEnabled: false }),
    });
    const sharedInput = {
      bronId,
      bronSlug: "striive" as const,
      checkpoint: null,
      connector,
      limiter: new CrawlDelayLimiter({ crawlDelayMs: 0 }),
      objectStore,
      observationRecorder: recorder,
      rawRetentionDays: 90,
      retryPolicy,
      runKind: "test" as const,
      runLifecycleStore: new InMemoryRunLifecycleStore(),
    };

    await runConnector({ ...sharedInput, scrapeRunId: "run-striive-replay-1" });
    await runConnector({ ...sharedInput, scrapeRunId: "run-striive-replay-2" });

    expect(recorder.records).toHaveLength(5);
    expect(
      new Set(recorder.records.map((record) => record.bronReferentie)).size
    ).toBe(5);
  });

  it("advances through listing pages until a short page signals the end", async () => {
    const jobs: StriiveJob[] = Array.from({ length: 30 }, (_, index) => ({
      id: `ST-${index + 1}`,
      title: `Job ${index + 1}`,
    }));
    const client: StriiveClient = {
      fetchListing: (page) => {
        if (page === 1) {
          return Promise.resolve({
            data: jobs.slice(0, STRIIVE_PAGE_SIZE),
            total: jobs.length,
          });
        }
        if (page === 2) {
          return Promise.resolve({
            data: jobs.slice(STRIIVE_PAGE_SIZE),
            total: jobs.length,
          });
        }
        return Promise.resolve({ data: [], total: jobs.length });
      },
    };
    const connector = createStriiveConnector({
      bronId: "bron-striive-pages",
      client,
    });
    const first = await connector.discover(null);
    expect(first.hasMore).toBe(true);
    expect(first.items).toHaveLength(STRIIVE_PAGE_SIZE);

    const second = await connector.discover(first.checkpoint);
    expect(second.hasMore).toBe(false);
    expect(second.truncated).toBe(false);
    expect(second.items).toHaveLength(jobs.length - STRIIVE_PAGE_SIZE);
  });

  it("reports truncated when the page cap stops the walk while Striive still has pages (RJC-397)", async () => {
    const fullPage: StriiveJob[] = Array.from(
      { length: STRIIVE_PAGE_SIZE },
      (_, index) => ({ id: `ST-CAP-${index + 1}`, title: `Job ${index + 1}` })
    );
    const client: StriiveClient = {
      fetchListing: () =>
        Promise.resolve({ data: fullPage, total: STRIIVE_PAGE_SIZE * 100 }),
    };
    const connector = createStriiveConnector({
      bronId: "bron-striive-cap",
      client,
    });

    const beforeCap = await connector.discover({ page: STRIIVE_MAX_PAGES - 1 });
    expect(beforeCap.hasMore).toBe(true);
    expect(beforeCap.truncated).toBe(false);

    const atCap = await connector.discover({ page: STRIIVE_MAX_PAGES });
    expect(atCap.hasMore).toBe(false);
    expect(atCap.truncated).toBe(true);
  });
});
