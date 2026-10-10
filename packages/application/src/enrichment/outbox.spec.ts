import { describe, expect, it } from "bun:test";

import {
  ENRICHMENT_OUTBOX_EVENT_TYPE,
  enqueueEnrichmentOutbox,
  enqueueEnrichmentOutboxStub,
} from "./outbox";

describe("enrichment outbox", () => {
  it("skips enqueue on dry-run and empty fields", async () => {
    let calls = 0;
    const port = {
      insertOutboxEvent: () => {
        calls += 1;
        return Promise.resolve({ id: "evt-1" });
      },
    };

    await expect(
      enqueueEnrichmentOutbox(port, {
        aanvraagId: "a1",
        dryRun: true,
        fields: ["locatie"],
      })
    ).resolves.toEqual({
      enqueued: false,
      eventId: null,
      eventType: ENRICHMENT_OUTBOX_EVENT_TYPE,
    });
    await expect(
      enqueueEnrichmentOutbox(port, {
        aanvraagId: "a1",
        dryRun: false,
        fields: [],
      })
    ).resolves.toMatchObject({ enqueued: false });
    expect(calls).toBe(0);
  });

  it("inserts a thin aanvraag.enriched event when live", async () => {
    const payloads: unknown[] = [];
    const port = {
      insertOutboxEvent: (input: {
        readonly aggregateId: string;
        readonly eventType: string;
        readonly payload: unknown;
      }) => {
        payloads.push(input);
        return Promise.resolve({ id: "evt-42" });
      },
    };

    await expect(
      enqueueEnrichmentOutbox(port, {
        aanvraagId: "a1",
        dryRun: false,
        fields: ["locatie", "tarief"],
      })
    ).resolves.toEqual({
      enqueued: true,
      eventId: "evt-42",
      eventType: ENRICHMENT_OUTBOX_EVENT_TYPE,
    });
    expect(payloads).toEqual([
      {
        aggregateId: "a1",
        aggregateType: "aanvraag",
        eventType: "aanvraag.enriched",
        payload: { field_count: 2, fields: ["locatie", "tarief"] },
      },
    ]);
  });

  it("keeps the Slice 1 stub behaviour for dry-run gating", () => {
    expect(
      enqueueEnrichmentOutboxStub({
        aanvraagId: "a1",
        dryRun: true,
        fieldCount: 2,
      }).enqueued
    ).toBe(false);
    expect(
      enqueueEnrichmentOutboxStub({
        aanvraagId: "a1",
        dryRun: false,
        fieldCount: 2,
      }).enqueued
    ).toBe(true);
  });
});
