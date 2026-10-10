import { describe, expect, it } from "bun:test";

import {
  CrawlDelayLimiter,
  createInhuurdeskClient,
  createInhuurdeskConnector,
  createTenderNedClient,
  createTenderNedConnector,
  InMemoryKnownHashStore,
  InMemoryObjectStore,
  InMemoryObservationRecorder,
  InMemoryRunLifecycleStore,
  loadConnectorFixture,
  requestedListingSize,
  runConnector,
  TENDER_NED_MAX_PAGE_SIZE,
} from "@ji/connectors";
import { hashTenderNedListingItem } from "@ji/connectors/tenderned";
import type { TenderNedListingPage } from "@ji/connectors/tenderned";

import { InMemoryCurateStore } from "../identity/store";
import { processRecordedObservations } from "./pipeline";

const retryPolicy = {
  initialDelayMs: 0,
  jitter: (delayMs: number) => delayMs,
  maxAttempts: 1,
  maxDelayMs: 0,
  multiplier: 1,
};

describe("U4/U5 fixture read path", () => {
  it("covers AE2: TenderNed fixture ingest twice yields one SourceRecord and one curated identity", async () => {
    const bronId = "bron-tenderned-fixture";
    const objectStore = new InMemoryObjectStore();
    const observationRecorder = new InMemoryObservationRecorder();
    const curateStore = new InMemoryCurateStore();
    const connector = createTenderNedConnector({
      bronId,
      client: createTenderNedClient({ liveEnabled: false }),
    });
    const sharedRunInput = {
      bronId,
      bronSlug: "tenderned" as const,
      checkpoint: null,
      connector,
      limiter: new CrawlDelayLimiter({ crawlDelayMs: 0 }),
      objectStore,
      observationRecorder,
      rawRetentionDays: 90,
      retryPolicy,
      runKind: "test" as const,
      runLifecycleStore: new InMemoryRunLifecycleStore(),
      startedAt: new Date("2026-08-28T10:15:00.000Z"),
    };

    const first = await runConnector({
      ...sharedRunInput,
      scrapeRunId: "run-tn-1",
    });
    const second = await runConnector({
      ...sharedRunInput,
      scrapeRunId: "run-tn-2",
    });

    await processRecordedObservations({
      bronId,
      bronSlug: "tenderned",
      curateStore,
      objectStore,
      observationRecorder,
    });

    expect(first.metrics).toMatchObject({
      changed: 0,
      error: 0,
      found: 1,
      new: 1,
      rejected: 0,
    });
    expect(second.metrics).toMatchObject({
      changed: 0,
      error: 0,
      found: 1,
      new: 0,
      rejected: 0,
    });
    expect(observationRecorder.records).toHaveLength(1);
    expect(curateStore.aanvragen).toHaveLength(1);
    expect(curateStore.aanvragen[0]?.bronReferentie).toBe("TN563214");
  });

  it("runs the Inhuurdesk fixture path with run metrics", async () => {
    const bronId = "bron-inhuurdesk-fixture";
    const objectStore = new InMemoryObjectStore();
    const observationRecorder = new InMemoryObservationRecorder();
    const curateStore = new InMemoryCurateStore();
    const connector = createInhuurdeskConnector({
      bronId,
      client: createInhuurdeskClient({ liveEnabled: false }),
    });

    const result = await runConnector({
      bronId,
      bronSlug: "inhuurdesk",
      checkpoint: null,
      connector,
      limiter: new CrawlDelayLimiter({ crawlDelayMs: 0 }),
      objectStore,
      observationRecorder,
      rawRetentionDays: 90,
      retryPolicy,
      runKind: "test",
      runLifecycleStore: new InMemoryRunLifecycleStore(),
      scrapeRunId: "run-ih-1",
      startedAt: new Date("2026-08-28T10:15:00.000Z"),
    });

    await processRecordedObservations({
      bronId,
      bronSlug: "inhuurdesk",
      curateStore,
      objectStore,
      observationRecorder,
    });

    expect(result.metrics).toMatchObject({
      changed: 0,
      error: 0,
      found: 4,
      new: 4,
      rejected: 0,
    });
    expect(observationRecorder.records).toHaveLength(4);
    expect(curateStore.aanvragen).toHaveLength(4);
    expect(
      curateStore.aanvragen.find(
        (aanvraag) =>
          aanvraag.bronReferentie === "3c9792fd-d0ef-4bcc-9500-c2ceaba566a4"
      )
    ).toMatchObject({
      bronSpecifiek: {
        uren_max: 36,
        uren_min: 36,
        uren_per_week: "36",
      },
      urenPerWeek: "36",
    });
  });
});

describe("TenderNed connector guardrails", () => {
  it("never requests a listing page size above 100", () => {
    expect(requestedListingSize(101)).toBe(TENDER_NED_MAX_PAGE_SIZE);
    expect(requestedListingSize(50)).toBe(50);
  });

  it("skips detail fetch when the listing hash is unchanged", async () => {
    const bronId = "bron-tenderned-skip";
    let detailFetches = 0;
    const client = createTenderNedClient({ liveEnabled: false });
    const wrappedClient = {
      fetchDetail: (publicatieId: string) => {
        detailFetches += 1;
        return client.fetchDetail(publicatieId);
      },
      fetchListing: client.fetchListing,
    };
    const knownHashes = new InMemoryKnownHashStore();
    const sharedRunInput = {
      bronId,
      bronSlug: "tenderned" as const,
      checkpoint: null,
      connector: createTenderNedConnector({
        bronId,
        client: wrappedClient,
        knownHashes,
      }),
      limiter: new CrawlDelayLimiter({ crawlDelayMs: 0 }),
      objectStore: new InMemoryObjectStore(),
      observationRecorder: new InMemoryObservationRecorder(),
      rawRetentionDays: 90,
      retryPolicy,
      runKind: "test" as const,
      runLifecycleStore: new InMemoryRunLifecycleStore(),
    };

    await runConnector({ ...sharedRunInput, scrapeRunId: "run-tn-skip-1" });

    const listingFixture = await loadConnectorFixture<TenderNedListingPage>(
      "tenderned/listing-page-0.json"
    );
    const [listingItem] = listingFixture.payload.content;
    if (!listingItem) {
      throw new Error("Expected TenderNed listing fixture item");
    }
    knownHashes.set(
      bronId,
      listingItem.kenmerk,
      await hashTenderNedListingItem(listingItem)
    );

    const skippedRun = await runConnector({
      ...sharedRunInput,
      scrapeRunId: "run-tn-skip-2",
    });

    expect(detailFetches).toBe(1);
    // RJC-397 x RJC-357: a skipped fetch is still an observed listing entry —
    // the source still lists it, so the missed-polls reconciliation must not
    // count it as missed once the short-circuit really fires.
    expect(skippedRun.observedBronReferenties).toContain(listingItem.kenmerk);
  });
});
