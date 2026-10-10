import { describe, expect, it } from "bun:test";

import {
  CrawlDelayLimiter,
  hashContent,
  InMemoryObjectStore,
  InMemoryObservationRecorder,
  InMemoryRunLifecycleStore,
  runConnector,
} from "@ji/connectors";

import { createOnefellowClient } from "./client";
import type { OnefellowClient } from "./client";
import { createOnefellowConnector } from "./connector";
import { hashOnefellowListingItem } from "./hash";
import {
  ONEFELLOW_PARSER_VERSION,
  onefellowBronReferentie,
  onefellowDetailUrl,
} from "./types";
import type { OnefellowFetchedPayload, OnefellowJob } from "./types";

const retryPolicy = {
  initialDelayMs: 0,
  jitter: (delayMs: number) => delayMs,
  maxAttempts: 1,
  maxDelayMs: 0,
  multiplier: 1,
};

describe("Onefellow helpers", () => {
  it("includes the parser version in the listing hash payload", async () => {
    const item: OnefellowJob = {
      address_city: "Amsterdam",
      company: "Example BV",
      company_city: "Amsterdam",
      description: "Description",
      duration: "6 maanden",
      hours: "32",
      joborder_id: 920,
      max_rate: "100",
      salary: "",
      start_date: 1_790_812_800,
      status: "open",
      teaser: "Teaser",
      time_deadline: 1_793_404_800,
      title: "Developer",
      workplace_type: "hybrid",
    };
    const canonical = JSON.stringify({
      address_city: item.address_city ?? null,
      company: item.company ?? null,
      company_city: item.company_city ?? null,
      description: item.description ?? null,
      duration: item.duration ?? null,
      hours: item.hours ?? null,
      joborder_id: item.joborder_id,
      max_rate: item.max_rate ?? null,
      parser_version: ONEFELLOW_PARSER_VERSION,
      salary: item.salary ?? null,
      start_date: item.start_date ?? null,
      status: item.status ?? null,
      teaser: item.teaser ?? null,
      time_deadline: item.time_deadline ?? null,
      title: item.title,
      workplace_type: item.workplace_type ?? null,
    });

    expect(await hashOnefellowListingItem(item)).toBe(
      await hashContent(new TextEncoder().encode(canonical))
    );
  });

  it("stringifies joborder_id for bronReferentie", () => {
    expect(onefellowBronReferentie({ joborder_id: 920 })).toBe("920");
  });

  it("builds the public detail url from joborder_id", () => {
    expect(onefellowDetailUrl({ joborder_id: 920 })).toBe(
      "https://onefellow.nl/opdrachten/920"
    );
  });
});

describe("Onefellow connector", () => {
  it("ingests the real listing fixture with found/new/changed/rejected/error metrics", async () => {
    const bronId = "bron-onefellow-fixture";
    const result = await runConnector({
      bronId,
      bronSlug: "onefellow",
      checkpoint: null,
      connector: createOnefellowConnector({
        bronId,
        client: createOnefellowClient({ liveEnabled: false }),
      }),
      limiter: new CrawlDelayLimiter({ crawlDelayMs: 0 }),
      objectStore: new InMemoryObjectStore(),
      observationRecorder: new InMemoryObservationRecorder(),
      rawRetentionDays: 90,
      retryPolicy,
      runKind: "test",
      runLifecycleStore: new InMemoryRunLifecycleStore(),
      scrapeRunId: "run-of-1",
      startedAt: new Date("2026-08-31T13:30:47.000Z"),
    });

    expect(result.metrics).toMatchObject({
      changed: 0,
      error: 0,
      found: 6,
      new: 6,
      rejected: 0,
    });
  });

  it("never lets contact/recruiter/sourcer fields reach the fetched payload", async () => {
    const bronId = "bron-onefellow-whitelist";
    const connector = createOnefellowConnector({
      bronId,
      client: createOnefellowClient({ liveEnabled: false }),
    });
    const discovered = await connector.discover(null);
    const [target] = discovered.items;
    if (!target) {
      throw new Error("expected the fixture job in discovered items");
    }
    const fetched = await connector.fetch(target);
    expect(fetched?.status).toBe("fetched");
    if (fetched?.status !== "fetched") {
      throw new Error("expected fetched result");
    }
    const raw = new TextDecoder().decode(fetched.body);
    expect(raw).not.toContain("recruiter");
    expect(raw).not.toContain("sourcer");
    expect(raw).not.toContain("contact");

    // SAFETY: the connector serialises OnefellowFetchedPayload; only the
    // job shape asserted below is inspected here.
    const payload = JSON.parse(raw) as OnefellowFetchedPayload;
    expect(payload.job.joborder_id).toBe(920);
    expect(payload.job.title).toContain("Constructiemanager");
    expect(payload.job.max_rate).toBe("");
    expect(payload.job.hours).toBe("24-28");
  });

  it("has no pagination: discover() always reports hasMore false", async () => {
    const bronId = "bron-onefellow-no-pagination";
    const connector = createOnefellowConnector({
      bronId,
      client: createOnefellowClient({ liveEnabled: false }),
    });
    const discovered = await connector.discover(null);
    expect(discovered.hasMore).toBe(false);
    expect(discovered.items).toHaveLength(6);
  });

  it("rejects a listing row missing joborder_id/title", async () => {
    const bronId = "bron-onefellow-missing-fields";
    const client: OnefellowClient = {
      // SAFETY: test double covers only the fields discover()/fetch() read
      // (joborder_id/title); the real OnefellowJob type carries far more.
      fetchListing: () =>
        Promise.resolve([{ joborder_id: 0, title: "" } as OnefellowJob]),
    };
    const connector = createOnefellowConnector({ bronId, client });
    const discovered = await connector.discover(null);
    const [item] = discovered.items;
    if (!item) {
      throw new Error("expected one discover item");
    }
    const fetched = await connector.fetch(item);
    expect(fetched?.status).toBe("rejected");
  });

  it("replays fixture ingest without duplicate source records", async () => {
    const bronId = "bron-onefellow-replay";
    const recorder = new InMemoryObservationRecorder();
    const objectStore = new InMemoryObjectStore();
    const connector = createOnefellowConnector({
      bronId,
      client: createOnefellowClient({ liveEnabled: false }),
    });
    const sharedInput = {
      bronId,
      bronSlug: "onefellow" as const,
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

    await runConnector({ ...sharedInput, scrapeRunId: "run-of-replay-1" });
    await runConnector({ ...sharedInput, scrapeRunId: "run-of-replay-2" });

    expect(recorder.records).toHaveLength(6);
    expect(
      new Set(recorder.records.map((record) => record.bronReferentie)).size
    ).toBe(6);
  });
});
