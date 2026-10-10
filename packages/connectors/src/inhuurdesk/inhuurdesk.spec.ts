import { describe, expect, it } from "bun:test";

import {
  CrawlDelayLimiter,
  createInhuurdeskConnector,
  InMemoryObjectStore,
  InMemoryObservationRecorder,
  InMemoryRunLifecycleStore,
  runConnector,
} from "@ji/connectors";

import { createInhuurdeskClient, inhuurdeskBronReferentie } from "./client";
import type { InhuurdeskClient } from "./client";
import {
  projectInhuurdeskAssignment,
  projectInhuurdeskContacts,
} from "./connector";
import { hashInhuurdeskListingItem } from "./hash";
import type { InhuurdeskAssignment, InhuurdeskFetchedPayload } from "./types";

const retryPolicy = {
  initialDelayMs: 0,
  jitter: (delayMs: number) => delayMs,
  maxAttempts: 1,
  maxDelayMs: 0,
  multiplier: 1,
};

describe("Inhuurdesk contact projection (CTP-610)", () => {
  it("folds the nested recruiter object plus flat fallbacks and requester", () => {
    expect(
      projectInhuurdeskContacts({
        id: "a1",
        recruiter: {
          email: "nested@example.invalid",
          firstName: "P.",
          functionTitle: "Recruiter",
          lastName: "Persoon",
        },
        recruiterPhoneNumber: "+31000000000",
        requesterEmail: "aanvrager@example.invalid",
        title: "t",
      })
    ).toEqual([
      {
        email: "nested@example.invalid",
        naam: "P. Persoon",
        rol: "Recruiter",
        telefoon: "+31000000000",
      },
      { email: "aanvrager@example.invalid", rol: "aanvrager" },
    ]);
  });

  it("uses the flat recruiter slots when recruiter is not an object", () => {
    expect(
      projectInhuurdeskContacts({
        id: "a2",
        recruiter: null,
        recruiterEmail: "flat@example.invalid",
        title: "t",
      })
    ).toEqual([
      {
        email: "flat@example.invalid",
        naam: null,
        rol: null,
        telefoon: null,
      },
    ]);
  });

  it("returns null when every contact slot is empty (the fixture state)", () => {
    expect(
      projectInhuurdeskContacts({
        id: "a3",
        recruiter: null,
        recruiterEmail: null,
        recruiterPhoneNumber: null,
        requesterEmail: "",
        title: "t",
      })
    ).toBeNull();
  });
});

describe("Inhuurdesk connector", () => {
  it("uses the platform UUID as bronReferentie", () => {
    expect(
      inhuurdeskBronReferentie({
        id: "7b9e123f-db3e-417b-b88f-d7f280add881",
        referenceCode: "SRQ178204",
        title: "Programmasecretaris",
      })
    ).toBe("7b9e123f-db3e-417b-b88f-d7f280add881");
  });

  it("ingests the real listing fixture (captured 2026-09-03) with found/new/changed/rejected/error metrics", async () => {
    const bronId = "bron-inhuurdesk-fixture";
    const result = await runConnector({
      bronId,
      bronSlug: "inhuurdesk",
      checkpoint: null,
      connector: createInhuurdeskConnector({
        bronId,
        client: createInhuurdeskClient({ liveEnabled: false }),
      }),
      limiter: new CrawlDelayLimiter({ crawlDelayMs: 0 }),
      objectStore: new InMemoryObjectStore(),
      observationRecorder: new InMemoryObservationRecorder(),
      rawRetentionDays: 90,
      retryPolicy,
      runKind: "test",
      runLifecycleStore: new InMemoryRunLifecycleStore(),
      scrapeRunId: "run-ih-1",
      startedAt: new Date("2026-09-03T19:15:00.000Z"),
    });

    expect(result.metrics).toMatchObject({
      changed: 0,
      error: 0,
      found: 4,
      new: 4,
      rejected: 0,
    });
  });

  it("projects the real fixture record into a whitelisted payload only (DEC-008)", async () => {
    const bronId = "bron-inhuurdesk-projection";
    const connector = createInhuurdeskConnector({
      bronId,
      client: createInhuurdeskClient({ liveEnabled: false }),
    });
    const discovered = await connector.discover(null);
    const target = discovered.items.find(
      (item) => item.bronReferentie === "3c9792fd-d0ef-4bcc-9500-c2ceaba566a4"
    );
    expect(target).toBeDefined();
    if (!target) {
      throw new Error("fixture record 3c9792fd… not discovered");
    }
    const fetched = await connector.fetch(target);
    expect(fetched?.status).toBe("fetched");
    if (fetched?.status !== "fetched") {
      throw new Error("expected fetched payload");
    }
    // SAFETY: the connector serialises InhuurdeskFetchedPayload as JSON.
    const payload = JSON.parse(
      new TextDecoder().decode(fetched.body)
    ) as InhuurdeskFetchedPayload;
    expect(payload.assignment).toEqual({
      clientName: "Alliander",
      clientNameSlug: "alliander",
      closingDateClient: "2026-09-08T08:00:00",
      closingDateInvoice: "2026-09-08T08:00:00",
      content: payload.assignment.content,
      endDate: "2026-12-14T00:00:00",
      hasMaxRate: false,
      hourlyRateMax: 0,
      hourlyRateMin: 0,
      hoursPerWeekMax: 36,
      hoursPerWeekMin: 36,
      id: "3c9792fd-d0ef-4bcc-9500-c2ceaba566a4",
      location: "Arnhem Bellevue",
      publishedDate: "2026-09-03T11:46:00",
      referenceCode: "SRQ149582",
      segmentName: "Techniek Binnen",
      startDate: "2026-09-14T00:00:00",
      title: "Planner C",
      titleSlug: "planner-c",
    });
    expect(payload.assignment.content).toContain("<p>");
    // Raw-only fields never leave the connector.
    expect(payload.assignment).not.toHaveProperty("clientId");
    expect(payload.assignment).not.toHaveProperty("portalId");
    expect(payload.assignment).not.toHaveProperty("recruiterEmail");
    expect(payload.assignment).not.toHaveProperty("brokerUrl");
  });

  it("rejects a listing row missing the stable id", async () => {
    const bronId = "bron-inhuurdesk-missing-id";
    const client: InhuurdeskClient = {
      fetchListing: () =>
        Promise.resolve({
          // Live row without a usable id: fetch() must reject, not ingest.
          data: [{ id: "", referenceCode: "SRQ1", title: "Geen id" }],
          total: 1,
        }),
    };
    const connector = createInhuurdeskConnector({ bronId, client });
    const discovered = await connector.discover(null);
    const [item] = discovered.items;
    expect(item).toBeDefined();
    if (!item) {
      throw new Error("expected one discovered item");
    }
    const fetched = await connector.fetch(item);
    expect(fetched?.status).toBe("rejected");
  });

  it("replays fixture ingest without duplicate source records", async () => {
    const bronId = "bron-inhuurdesk-replay";
    const recorder = new InMemoryObservationRecorder();
    const objectStore = new InMemoryObjectStore();
    const connector = createInhuurdeskConnector({
      bronId,
      client: createInhuurdeskClient({ liveEnabled: false }),
    });
    const sharedInput = {
      bronId,
      bronSlug: "inhuurdesk" as const,
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

    await runConnector({ ...sharedInput, scrapeRunId: "run-ih-replay-1" });
    await runConnector({ ...sharedInput, scrapeRunId: "run-ih-replay-2" });

    expect(recorder.records).toHaveLength(4);
    expect(
      new Set(recorder.records.map((record) => record.bronReferentie)).size
    ).toBe(4);
  });

  it("advances through 1-indexed listing pages until total is exhausted", async () => {
    const bronId = "bron-inhuurdesk-pages";
    const assignments = [
      {
        id: "ih-1",
        title: "One",
      },
      {
        id: "ih-2",
        title: "Two",
      },
      {
        id: "ih-3",
        title: "Three",
      },
      {
        id: "ih-4",
        title: "Four",
      },
    ] satisfies InhuurdeskAssignment[];
    const client: InhuurdeskClient = {
      fetchListing: (page) => {
        if (page === 1) {
          return Promise.resolve({
            data: assignments.slice(0, 2),
            total: 4,
          });
        }
        if (page === 2) {
          return Promise.resolve({
            data: assignments.slice(2, 4),
            total: 4,
          });
        }
        return Promise.resolve({ data: [], total: 4 });
      },
    };
    const connector = createInhuurdeskConnector({ bronId, client });
    const first = await connector.discover(null);
    expect(first.hasMore).toBe(true);
    expect(first.items).toHaveLength(2);

    const second = await connector.discover(first.checkpoint);
    expect(second.hasMore).toBe(false);
    expect(second.items).toHaveLength(2);
  });
});

describe("Inhuurdesk listing hash coverage (RJC-357 / RJC-401)", () => {
  const baseAssignment: InhuurdeskAssignment = {
    id: "7b9e123f-db3e-417b-b88f-d7f280add881",
    title: "Senior Developer",
  };

  it("covers every InhuurdeskAssignment field the normaliser can read", async () => {
    const variants: Partial<InhuurdeskAssignment>[] = [
      { clientName: "Gemeente Amsterdam" },
      { clientNameSlug: "gemeente-amsterdam" },
      { closingDateClient: "2026-09-09T12:00:00" },
      { closingDateInvoice: "2026-09-09T12:00:00" },
      {
        contactpersonen: [
          { email: "recruiter@example.invalid", naam: "R. Cruiter" },
        ],
      },
      { content: "<p>Andere omschrijving</p>" },
      { endDate: "2027-01-01T00:00:00" },
      { hasMaxRate: true },
      { hourlyRateMax: 110 },
      { hourlyRateMin: 90 },
      { hoursPerWeekMax: 36 },
      { hoursPerWeekMin: 32 },
      { id: "3c9792fd-d0ef-4bcc-9500-c2ceaba566a4" },
      { location: "Utrecht" },
      { publishedDate: "2026-09-03T14:43:00" },
      { referenceCode: "SRQ178204" },
      { segmentName: "DAS" },
      { startDate: "2026-10-01T00:00:00" },
      { title: "Andere titel" },
      { titleSlug: "andere-titel" },
    ];
    // Every whitelisted key must have a variant above (RJC-401 sync guard).
    const projectedKeys = Object.keys(
      projectInhuurdeskAssignment(baseAssignment)
    ).toSorted();
    expect(
      variants.flatMap((variant) => Object.keys(variant)).toSorted()
    ).toEqual(projectedKeys);
    const base = await hashInhuurdeskListingItem(baseAssignment);
    for (const variant of variants) {
      // oxlint-disable-next-line no-await-in-loop -- sequential hash comparisons keep the failure message per-field
      const changed = await hashInhuurdeskListingItem({
        ...baseAssignment,
        ...variant,
      });
      expect(changed).not.toBe(base);
    }
  });
});
