/* oxlint-disable eslint/require-await, unicorn/prefer-response-static-json, no-await-in-loop, eslint/no-plusplus, eslint/prefer-named-capture-group, anti-slop/require-safety-comment-for-type-assertion -- source fetch doubles stay readable and preserve response-order assertions. */
import { describe, expect, it } from "bun:test";

import {
  CrawlDelayLimiter,
  InMemoryObjectStore,
  InMemoryObservationRecorder,
  InMemoryRunLifecycleStore,
  runConnector,
} from "@ji/connectors";

import { createOpdrachtoverheidClient } from "./client";
import type { OpdrachtoverheidClient } from "./client";
import { createOpdrachtoverheidConnector } from "./connector";
import { hashOpdrachtoverheidListingItem } from "./hash";
import type {
  OpdrachtoverheidFetchedPayload,
  OpdrachtoverheidTender,
} from "./types";
import {
  OPDRACHTOVERHEID_MAX_LISTING_BODY_BYTES,
  OPDRACHTOVERHEID_MAX_RECORDS,
} from "./types";

const retryPolicy = {
  initialDelayMs: 0,
  jitter: (delayMs: number) => delayMs,
  maxAttempts: 1,
  maxDelayMs: 0,
  multiplier: 1,
};

const buildTender = (id: string, title: string): OpdrachtoverheidTender => ({
  opdracht_overheid_url: `https://www.opdrachtoverheid.nl/inhuuropdracht/Org/${title}/${id}`,
  tender_buying_organization: "Gemeente Voorbeeld",
  tender_id: id,
  tender_name: title,
  tender_source: "voorbeeldsource",
  tender_url: `https://www.voorbeeldsource.nl/opdracht/${id}`,
  web_key: id,
});

/** Names the extra runtime fields the live API returns beyond
 * `OpdrachtoverheidTender`'s declared whitelist, so the DEC-008 test below
 * can construct a realistically-bloated record without an `unknown`
 * escape hatch. */
interface RawTenderWithBloat extends OpdrachtoverheidTender {
  Dynamics_id: string;
  similarity_score: number;
  vacancies_location: {
    avatar: string;
    company_address: string;
    description: string;
    latitude: string;
    longitude: string;
    summary: string;
  };
}

describe("Opdrachtoverheid connector", () => {
  it("ingests listing fixtures with found/new/changed/rejected/error metrics", async () => {
    const bronId = "bron-opdrachtoverheid-fixture";
    const result = await runConnector({
      bronId,
      bronSlug: "opdrachtoverheid",
      checkpoint: null,
      connector: createOpdrachtoverheidConnector({
        bronId,
        client: createOpdrachtoverheidClient({ liveEnabled: false }),
      }),
      limiter: new CrawlDelayLimiter({ crawlDelayMs: 0 }),
      objectStore: new InMemoryObjectStore(),
      observationRecorder: new InMemoryObservationRecorder(),
      rawRetentionDays: 90,
      retryPolicy,
      runKind: "test",
      runLifecycleStore: new InMemoryRunLifecycleStore(),
      scrapeRunId: "run-oo-1",
      startedAt: new Date("2026-08-31T10:15:00.000Z"),
    });

    expect(result.metrics).toMatchObject({
      changed: 0,
      error: 0,
      found: 5,
      new: 5,
      rejected: 0,
    });
  });

  it("replays fixture ingest without duplicate source records", async () => {
    const bronId = "bron-opdrachtoverheid-replay";
    const recorder = new InMemoryObservationRecorder();
    const objectStore = new InMemoryObjectStore();
    const connector = createOpdrachtoverheidConnector({
      bronId,
      client: createOpdrachtoverheidClient({ liveEnabled: false }),
    });
    const sharedInput = {
      bronId,
      bronSlug: "opdrachtoverheid" as const,
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

    await runConnector({ ...sharedInput, scrapeRunId: "run-oo-replay-1" });
    await runConnector({ ...sharedInput, scrapeRunId: "run-oo-replay-2" });

    expect(recorder.records).toHaveLength(5);
    expect(
      new Set(recorder.records.map((record) => record.bronReferentie)).size
    ).toBe(5);
  });

  it("takes one bounded snapshot without pagination omissions", async () => {
    const tenders = [
      buildTender("T-1", "One"),
      buildTender("T-2", "Two"),
      buildTender("T-3", "Three"),
    ];
    let requestCount = 0;
    let requestBody: { limit?: number; offset?: number } | undefined;
    const client = createOpdrachtoverheidClient({
      fetchImpl: Object.assign(
        async (_input: string | URL | Request, init?: RequestInit) => {
          requestCount += 1;
          requestBody = JSON.parse(String(init?.body)) as {
            limit?: number;
            offset?: number;
          };
          return new Response(JSON.stringify({ negometrix_tenders: tenders }));
        },
        { preconnect: () => {} }
      ),
      liveEnabled: true,
    });
    const listing = await client.fetchListing(7);

    expect(listing.items.map((tender) => tender.tender_id)).toEqual([
      "T-1",
      "T-2",
      "T-3",
    ]);
    expect(listing.hasMore).toBe(true);
    expect(requestCount).toBe(1);
    expect(requestBody).toEqual({
      limit: OPDRACHTOVERHEID_MAX_RECORDS,
      offset: 0,
    });
  });

  it("starts a fresh snapshot when resuming from a checkpoint", async () => {
    const pages: number[] = [];
    const client: OpdrachtoverheidClient = {
      fetchDetail: () => Promise.resolve({ jobPosting: null, tender: null }),
      fetchListing: (page) => {
        pages.push(page);
        return Promise.resolve({
          hasMore: false,
          items: [buildTender("T-checkpoint", "Checkpoint")],
        });
      },
      fetchSitemap: () => Promise.resolve([]),
    };

    const result = await createOpdrachtoverheidConnector({
      bronId: "bron-opdrachtoverheid-checkpoint",
      client,
    }).discover({ page: 9 });

    expect(result.items).toHaveLength(1);
    expect(pages).toEqual([0]);
  });

  it("deduplicates tender IDs and does not cache a prior poll", async () => {
    const snapshots = [
      [
        buildTender("T-A", "A"),
        buildTender("T-B", "B"),
        buildTender("T-A", "A repeated"),
      ],
      [
        buildTender("T-B", "B reordered"),
        buildTender("T-C", "C"),
        buildTender("T-B", "B repeated"),
      ],
    ];
    let requestCount = 0;
    const client = createOpdrachtoverheidClient({
      fetchImpl: Object.assign(
        async () =>
          new Response(
            JSON.stringify({
              negometrix_tenders: snapshots[requestCount++] ?? [],
            })
          ),
        { preconnect: () => {} }
      ),
      liveEnabled: true,
    });

    const first = await client.fetchListing(0);
    const second = await client.fetchListing(0);

    expect(first.items.map((tender) => tender.tender_id)).toEqual([
      "T-A",
      "T-B",
    ]);
    expect(second.items.map((tender) => tender.tender_id)).toEqual([
      "T-B",
      "T-C",
    ]);
    expect(requestCount).toBe(2);
  });

  it("fails closed for underfull live snapshots, keeps the default fixture complete and reports the capped live recording as truncated", async () => {
    const fullSnapshot = Array.from(
      { length: OPDRACHTOVERHEID_MAX_RECORDS },
      (_, index) => buildTender(`T-FULL-${index}`, `Full ${index}`)
    );
    const fullClient = createOpdrachtoverheidClient({
      fetchImpl: Object.assign(
        async () =>
          new Response(JSON.stringify({ negometrix_tenders: fullSnapshot })),
        { preconnect: () => {} }
      ),
      liveEnabled: true,
    });
    const fullResult = await createOpdrachtoverheidConnector({
      bronId: "bron-opdrachtoverheid-full",
      client: fullClient,
    }).discover(null);

    expect(fullResult.items).toHaveLength(OPDRACHTOVERHEID_MAX_RECORDS);
    expect(fullResult.hasMore).toBe(false);
    expect(fullResult.truncated).toBe(true);

    const underfullLiveClient = createOpdrachtoverheidClient({
      fetchImpl: Object.assign(
        async () =>
          new Response(
            JSON.stringify({
              negometrix_tenders: fullSnapshot.slice(
                0,
                OPDRACHTOVERHEID_MAX_RECORDS - 1
              ),
            })
          ),
        { preconnect: () => {} }
      ),
      liveEnabled: true,
    });
    const underfullResult = await createOpdrachtoverheidConnector({
      bronId: "bron-opdrachtoverheid-underfull",
      client: underfullLiveClient,
    }).discover(null);

    expect(underfullResult.items).toHaveLength(
      OPDRACHTOVERHEID_MAX_RECORDS - 1
    );
    expect(underfullResult.hasMore).toBe(false);
    expect(underfullResult.truncated).toBe(true);

    const fixtureListing = await createOpdrachtoverheidClient({
      liveEnabled: false,
    }).fetchListing(0);
    expect(fixtureListing.hasMore).toBe(false);

    // The 2026-09-16 recording is a full-cap snapshot (400 = the API's own
    // limit), so it reports the same truncation a live run would.
    const liveRecording = await createOpdrachtoverheidClient({
      listingFixturePath: "opdrachtoverheid/listing-live-2026-09-16.json",
      liveEnabled: false,
    }).fetchListing(0);
    expect(liveRecording.items).toHaveLength(OPDRACHTOVERHEID_MAX_RECORDS);
    expect(liveRecording.hasMore).toBe(true);

    const run = await runConnector({
      bronId: "bron-opdrachtoverheid-underfull-run",
      bronSlug: "opdrachtoverheid",
      checkpoint: null,
      connector: createOpdrachtoverheidConnector({
        bronId: "bron-opdrachtoverheid-underfull-run",
        client: underfullLiveClient,
      }),
      limiter: new CrawlDelayLimiter({ crawlDelayMs: 0 }),
      objectStore: new InMemoryObjectStore(),
      observationRecorder: new InMemoryObservationRecorder(),
      rawRetentionDays: 90,
      retryPolicy,
      runKind: "test",
      runLifecycleStore: new InMemoryRunLifecycleStore(),
      scrapeRunId: "run-oo-underfull",
    });
    expect(run.completeness).toEqual({
      complete: false,
      reason: "truncated",
    });
  });

  it("rejects a response larger than the bounded snapshot", async () => {
    const client = createOpdrachtoverheidClient({
      fetchImpl: Object.assign(
        async () =>
          new Response(
            JSON.stringify({
              negometrix_tenders: Array.from(
                { length: OPDRACHTOVERHEID_MAX_RECORDS + 1 },
                (_, index) => buildTender(`T-OVER-${index}`, `Over ${index}`)
              ),
            })
          ),
        { preconnect: () => {} }
      ),
      liveEnabled: true,
    });

    await expect(client.fetchListing(0)).rejects.toThrow(
      "maximum supported snapshot"
    );
  });

  it("rejects a listing body over the byte bound from its header", async () => {
    const client = createOpdrachtoverheidClient({
      fetchImpl: Object.assign(
        async () =>
          new Response("{}", {
            headers: {
              "content-length": String(
                OPDRACHTOVERHEID_MAX_LISTING_BODY_BYTES + 1
              ),
            },
          }),
        { preconnect: () => {} }
      ),
      liveEnabled: true,
    });

    await expect(client.fetchListing(0)).rejects.toThrow(
      "listing response exceeds"
    );
  });

  it("rejects a listing body over the byte bound while streaming", async () => {
    const client = createOpdrachtoverheidClient({
      fetchImpl: Object.assign(
        async () =>
          new Response("x".repeat(OPDRACHTOVERHEID_MAX_LISTING_BODY_BYTES + 1)),
        { preconnect: () => {} }
      ),
      liveEnabled: true,
    });

    await expect(client.fetchListing(0)).rejects.toThrow(
      "listing response exceeds"
    );
  });

  it("rejects malformed listing shapes and tender IDs", async () => {
    for (const payload of [
      {},
      { negometrix_tenders: [{}] },
      { negometrix_tenders: [{ tender_id: "  " }] },
    ]) {
      const client = createOpdrachtoverheidClient({
        fetchImpl: Object.assign(
          async () => new Response(JSON.stringify(payload)),
          { preconnect: () => {} }
        ),
        liveEnabled: true,
      });

      await expect(client.fetchListing(0)).rejects.toThrow(
        /invalid (items|tender_id)/u
      );
    }
  });

  it("rejects an item whose listing payload is missing tender_id", async () => {
    const bronId = "bron-opdrachtoverheid-reject";
    const client: OpdrachtoverheidClient = {
      fetchDetail: () => Promise.resolve({ jobPosting: null, tender: null }),
      fetchListing: () => Promise.resolve({ hasMore: false, items: [] }),
      fetchSitemap: () => Promise.resolve([]),
    };
    const connector = createOpdrachtoverheidConnector({ bronId, client });

    const result = await connector.fetch({
      bronReferentie: "missing",
      contentHash: "hash",
      listingPayload: {},
    });

    expect(result).toMatchObject({ status: "rejected" });
  });

  it("enriches with JobPosting JSON-LD when the client returns one", async () => {
    const bronId = "bron-opdrachtoverheid-enrich";
    const tender = buildTender("T-enrich", "Enrich");
    const client: OpdrachtoverheidClient = {
      fetchDetail: () =>
        Promise.resolve({
          jobPosting: { "@type": "JobPosting", title: "Enrich" },
          tender: null,
        }),
      fetchListing: () => Promise.resolve({ hasMore: false, items: [tender] }),
      fetchSitemap: () => Promise.resolve([]),
    };
    const connector = createOpdrachtoverheidConnector({ bronId, client });

    const discovered = await connector.discover(null);
    const [discoveredItem] = discovered.items;
    if (!discoveredItem) {
      throw new Error("expected a discovered item");
    }
    const fetched = await connector.fetch(discoveredItem);
    expect(fetched?.status).toBe("fetched");
    if (fetched?.status !== "fetched") {
      throw new Error("expected fetched result");
    }
    // SAFETY: connector serialises OpdrachtoverheidFetchedPayload as JSON.
    const payload = JSON.parse(
      new TextDecoder().decode(fetched.body)
    ) as OpdrachtoverheidFetchedPayload;
    expect(payload.jobPosting).toMatchObject({ title: "Enrich" });
  });

  it("projects the listing payload to the normaliser/dedup whitelist (DEC-008)", async () => {
    const bronId = "bron-opdrachtoverheid-whitelist";
    // Mirrors the live API's real ~61-key record: a plain object literal is
    // NOT excess-property checked against OpdrachtoverheidTender, so a raw
    // response can carry far more than the declared type — including the
    // bloat DEC-008 flags (nested location avatar/lat/long, similarity_score).
    // RawTenderWithBloat names those extra fields explicitly so the test
    // needs no `unknown`/type-assertion escape hatch to construct it.
    const rawTender: RawTenderWithBloat = {
      ...buildTender("T-whitelist", "Whitelist"),
      Dynamics_id: "should-not-survive",
      similarity_score: 0.87,
      vacancies_location: {
        avatar: "blob_should_not_survive.",
        company_address: "Keep me",
        description: "A long marketing blurb that should not survive.",
        latitude: "52.1",
        longitude: "5.1",
        summary: "Should not survive either.",
      },
    };
    const client: OpdrachtoverheidClient = {
      fetchDetail: () => Promise.resolve({ jobPosting: null, tender: null }),
      fetchListing: () =>
        Promise.resolve({ hasMore: false, items: [rawTender] }),
      fetchSitemap: () => Promise.resolve([]),
    };
    const connector = createOpdrachtoverheidConnector({ bronId, client });

    const discovered = await connector.discover(null);
    const [discoveredItem] = discovered.items;
    if (!discoveredItem) {
      throw new Error("expected a discovered item");
    }
    // SAFETY: this test constructed listingPayload from rawTender above, so
    // reading it back as the same bloated shape only re-confirms what
    // discover() did (or did not) project through.
    const projected = (
      discoveredItem.listingPayload as OpdrachtoverheidFetchedPayload
    ).tender as Partial<RawTenderWithBloat>;
    expect(projected.Dynamics_id).toBeUndefined();
    expect(projected.similarity_score).toBeUndefined();
    // SAFETY: same rationale as `projected` above.
    const location = projected.vacancies_location as
      | Partial<RawTenderWithBloat["vacancies_location"]>
      | undefined;
    expect(location?.avatar).toBeUndefined();
    expect(location?.description).toBeUndefined();
    expect(location?.latitude).toBeUndefined();
    expect(location?.longitude).toBeUndefined();
    expect(location?.summary).toBeUndefined();
    expect(location?.company_address).toBe("Keep me");

    const fetched = await connector.fetch(discoveredItem);
    if (fetched?.status !== "fetched") {
      throw new Error("expected fetched result");
    }
    const body = new TextDecoder().decode(fetched.body);
    expect(body).not.toContain("similarity_score");
    expect(body).not.toContain("should not survive");
    expect(body).not.toContain("Dynamics_id");
  });

  it("keeps the published education level, competences and hybrid flag through the projection (CTP-526)", async () => {
    const bronId = "bron-opdrachtoverheid-commercial";
    const rawTender: OpdrachtoverheidTender = {
      ...buildTender("T-commercial", "Commercial"),
      education_level_obj: { education_level_label: "MBO", id: 10 },
      tender_competences: "<h3>Competenties</h3><ul><li>Nauwkeurig</li></ul>",
      tender_hybrid_working: true,
    };
    const client: OpdrachtoverheidClient = {
      fetchDetail: () => Promise.resolve({ jobPosting: null, tender: null }),
      fetchListing: () =>
        Promise.resolve({ hasMore: false, items: [rawTender] }),
      fetchSitemap: () => Promise.resolve([]),
    };
    const connector = createOpdrachtoverheidConnector({ bronId, client });

    const discovered = await connector.discover(null);
    const [discoveredItem] = discovered.items;
    if (!discoveredItem) {
      throw new Error("expected a discovered item");
    }
    // SAFETY: discover() projects the listing row this test supplied; reading
    // it back as the declared tender shape re-confirms what survived.
    const projected = (
      discoveredItem.listingPayload as OpdrachtoverheidFetchedPayload
    ).tender;
    expect(projected.education_level_obj?.education_level_label).toBe("MBO");
    expect(projected.tender_competences).toContain("Nauwkeurig");
    expect(projected.tender_hybrid_working).toBe(true);

    const withoutHybrid = await hashOpdrachtoverheidListingItem({
      ...rawTender,
      tender_hybrid_working: false,
    });
    expect(await hashOpdrachtoverheidListingItem(rawTender)).not.toBe(
      withoutHybrid
    );
  });
});
