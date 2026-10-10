import { describe, expect, it } from "bun:test";

import { InMemorySearchEngine } from "./in-memory-engine";
import { projectionHash } from "./manticore/engine";
import {
  coalesceOutboxEvents,
  drainOutboxEvents,
  planOutboxBatch,
} from "./projector";
import type {
  OutboxEventRecord,
  SearchDocument,
  SearchDocumentLoader,
  SearchEngine,
} from "./types";

const document: SearchDocument = {
  beschrijving: "Senior Azure platform engineer",
  bronId: "bron-1",
  contracttype: "detachering",
  eindklantNaam: null,
  id: "aanvraag-1",
  laatstGezienOp: new Date("2026-08-01T00:00:00.000Z"),
  locatieLand: "NL",
  opdrachtgeverNaam: null,
  provincie: null,
  publicatiedatum: null,
  skills: [],
  status: "active",
  tariefEenheid: null,
  tariefMax: 120,
  tariefMin: 80,
  titel: "Platform engineer Azure",
  urenPerWeekMax: null,
  urenPerWeekMin: null,
  werkvorm: null,
};

class StaticLoader implements SearchDocumentLoader {
  private readonly loaded: SearchDocument | null;

  constructor(loaded: SearchDocument | null) {
    this.loaded = loaded;
  }

  loadByAggregateId(_aggregateId: string): Promise<SearchDocument | null> {
    return Promise.resolve(this.loaded ? structuredClone(this.loaded) : null);
  }
}

describe("outbox projector", () => {
  it("indexes a new aanvraag after outbox event and search finds the id", async () => {
    const engine = new InMemorySearchEngine();
    const events: OutboxEventRecord[] = [
      {
        aggregateId: document.id,
        aggregateType: "aanvraag",
        eventType: "aanvraag.nieuw",
        id: "outbox-1",
        payload: {
          bron_id: document.bronId,
          bron_referentie: "ref-1",
        },
        sequenceNumber: 1n,
      },
    ];

    const version = await drainOutboxEvents({
      engine,
      events,
      loader: new StaticLoader(document),
    });

    const result = await engine.search({
      ast: {
        kind: "term",
        value: "Azure",
      },
      filters: {},
      limit: 10,
      offset: 0,
    });

    expect(result.total).toBe(1);
    expect(result.hits[0]?.id).toBe("aanvraag-1");
    expect(version).toEqual({
      appliedSequence: 1n,
      failures: [],
      generation: 1,
      unapplied: [],
    });
    const applied = await engine.getAppliedVersion();
    expect(applied.appliedSequence).toBe(1n);
  });

  it("marks closed events with status attribute without deleting the document", async () => {
    const engine = new InMemorySearchEngine();
    await engine.applyBatch({
      appliedSequence: 1n,
      mutations: [{ document, kind: "upsert", sequenceNumber: 1n }],
    });

    const version = await drainOutboxEvents({
      engine,
      events: [
        {
          aggregateId: document.id,
          aggregateType: "aanvraag",
          eventType: "aanvraag.gesloten",
          id: "outbox-2",
          payload: { status: "closed" },
          sequenceNumber: 2n,
        },
      ],
      loader: new StaticLoader(document),
    });

    // RJC-383: the close moved the document into the archive partition. The
    // default (active) scope no longer lists it but still counts it, and
    // scope "all" finds it under its new status.
    const active = await engine.search({
      ast: null,
      filters: { status: ["closed"] },
      limit: 10,
      offset: 0,
    });
    expect(active.total).toBe(0);
    expect(active.archiveTotal).toBe(1);
    const all = await engine.search({
      ast: null,
      filters: { status: ["closed"] },
      limit: 10,
      offset: 0,
      scope: "all",
    });
    expect(all.total).toBe(1);
    expect(all.archiveTotal).toBeUndefined();
    expect(version.appliedSequence).toBe(2n);
  });

  it("resolves the partition from the LAST event's status, never a cached one: active→stale→active in one batch ends ACTIVE (RJC-383)", async () => {
    // RJC-397 reopens a stale record (listing_teruggekeerd) and curate then
    // rewrites `active` without an outbox row; the projector must follow the
    // event payload / loaded row at projection time. Coalescing keeps the
    // highest-sequence event, so the flip lands in the active table even
    // though the loaded row still says stale and the middle event archived.
    const now = new Date("2026-09-01T00:00:00.000Z");
    const staleRow: SearchDocument = { ...document, status: "stale" };
    const event = (
      id: string,
      sequenceNumber: bigint,
      status: "active" | "stale"
    ): OutboxEventRecord => ({
      aggregateId: document.id,
      aggregateType: "aanvraag",
      eventType: "aanvraag.gewijzigd",
      id,
      payload: { status },
      sequenceNumber,
    });
    const plan = await planOutboxBatch({
      // Out of order on purpose: coalescing sorts by sequence.
      events: [
        event("e-stale", 2n, "stale"),
        event("e-reopen", 3n, "active"),
        event("e-first", 1n, "active"),
      ],
      knownHashes: new Map([[document.id, projectionHash(staleRow, now)]]),
      loadDocuments: () =>
        Promise.resolve(new Map([[document.id, structuredClone(staleRow)]])),
      now,
    });
    expect(plan.mutations).toEqual([
      {
        document: { ...document, status: "active" },
        kind: "upsert",
        partition: "active",
        previousPartition: "archive",
        projectionHash: projectionHash({ ...document, status: "active" }, now),
        sequenceNumber: 3n,
      },
    ]);
    expect(plan.hashes.get(document.id)?.startsWith("active:")).toBe(true);

    // And end to end through the in-memory engine: one batch, ends active.
    const engine = new InMemorySearchEngine(undefined, () => now);
    await engine.applyBatch({
      appliedSequence: 0n,
      mutations: [{ document: staleRow, kind: "upsert", sequenceNumber: 0n }],
    });
    await drainOutboxEvents({
      engine,
      events: [
        event("e-first", 1n, "active"),
        event("e-stale", 2n, "stale"),
        event("e-reopen", 3n, "active"),
      ],
      loader: new StaticLoader(staleRow),
    });
    const active = await engine.search({
      ast: null,
      filters: {},
      limit: 10,
      offset: 0,
    });
    expect(active.hits.map((hit) => hit.id)).toEqual([document.id]);
    expect(active.archiveTotal).toBe(0);
  });

  it("plans a close as a MOVE: partition archive, previousPartition active, hash prefix changed (RJC-383)", async () => {
    const now = new Date("2026-09-01T00:00:00.000Z");
    const activeHash = projectionHash(document, now);
    expect(activeHash.startsWith("active:")).toBe(true);
    const closeEvent: OutboxEventRecord = {
      aggregateId: document.id,
      aggregateType: "aanvraag",
      eventType: "aanvraag.gesloten",
      id: "outbox-move",
      payload: { status: "closed" },
      sequenceNumber: 5n,
    };

    const plan = await planOutboxBatch({
      events: [closeEvent],
      knownHashes: new Map([[document.id, activeHash]]),
      loadDocuments: () =>
        Promise.resolve(new Map([[document.id, structuredClone(document)]])),
      now,
    });

    expect(plan.unchangedAggregateIds).toEqual([]);
    expect(plan.mutations).toEqual([
      {
        document: { ...document, status: "closed" },
        kind: "upsert",
        partition: "archive",
        previousPartition: "active",
        projectionHash: projectionHash({ ...document, status: "closed" }, now),
        sequenceNumber: 5n,
      },
    ]);
    expect(plan.hashes.get(document.id)?.startsWith("archive:")).toBe(true);

    // A delete of a document with a known partition targets that table only;
    // without a known hash the partition is left unknown (engine clears both).
    const deleteEvent: OutboxEventRecord = {
      ...closeEvent,
      eventType: "aanvraag.verwijderd",
      id: "outbox-delete",
      sequenceNumber: 6n,
    };
    const known = await planOutboxBatch({
      events: [deleteEvent],
      knownHashes: new Map([[document.id, plan.hashes.get(document.id) ?? ""]]),
      loadDocuments: () => Promise.resolve(new Map()),
      now,
    });
    expect(known.mutations).toEqual([
      {
        id: document.id,
        kind: "delete",
        partition: "archive",
        sequenceNumber: 6n,
      },
    ]);
    const unknown = await planOutboxBatch({
      events: [deleteEvent],
      loadDocuments: () => Promise.resolve(new Map()),
      now,
    });
    expect(unknown.mutations).toEqual([
      {
        id: document.id,
        kind: "delete",
        partition: undefined,
        sequenceNumber: 6n,
      },
    ]);
  });

  it("consumes skipped events: the applied sequence still advances", async () => {
    const engine = new InMemorySearchEngine();

    const version = await drainOutboxEvents({
      engine,
      events: [
        {
          aggregateId: "not-an-aanvraag",
          aggregateType: "bron",
          eventType: "bron.geactiveerd",
          id: "outbox-3",
          payload: {},
          sequenceNumber: 7n,
        },
      ],
      loader: new StaticLoader(null),
    });

    expect(version.appliedSequence).toBe(7n);
  });

  it("coalesces upsert, upsert, delete for one aggregate into a single delete with zero loads", async () => {
    const event = (
      sequenceNumber: bigint,
      eventType: string
    ): OutboxEventRecord => ({
      aggregateId: document.id,
      aggregateType: "aanvraag",
      eventType,
      id: `outbox-${sequenceNumber}`,
      payload: {},
      sequenceNumber,
    });
    // Out of order on purpose: coalescing must sort by sequence first.
    const events = [
      event(12n, "aanvraag.verwijderd"),
      event(10n, "aanvraag.nieuw"),
      event(11n, "aanvraag.gewijzigd"),
    ];

    const coalesced = coalesceOutboxEvents(events);
    expect(coalesced.aggregates).toHaveLength(1);
    expect(coalesced.aggregates[0]?.eventIds).toEqual([
      "outbox-10",
      "outbox-11",
      "outbox-12",
    ]);
    expect(coalesced.maxSequence).toBe(12n);

    let loads = 0;
    const plan = await planOutboxBatch({
      events,
      loadDocuments: () => {
        loads += 1;
        return Promise.resolve(new Map());
      },
    });
    expect(loads).toBe(0);
    expect(plan.mutations).toEqual([
      { id: document.id, kind: "delete", sequenceNumber: 12n },
    ]);
    expect(plan.appliedSequence).toBe(12n);
  });

  it("collapses several upserts into one load and one write; an upsert after a delete re-creates", async () => {
    const other: SearchDocument = { ...document, id: "aanvraag-2" };
    const events: OutboxEventRecord[] = [
      {
        aggregateId: document.id,
        aggregateType: "aanvraag",
        eventType: "aanvraag.nieuw",
        id: "e1",
        payload: {},
        sequenceNumber: 1n,
      },
      {
        aggregateId: other.id,
        aggregateType: "aanvraag",
        eventType: "aanvraag.verwijderd",
        id: "e2",
        payload: {},
        sequenceNumber: 2n,
      },
      {
        aggregateId: document.id,
        aggregateType: "aanvraag",
        eventType: "aanvraag.gewijzigd",
        id: "e3",
        payload: {},
        sequenceNumber: 3n,
      },
      {
        aggregateId: other.id,
        aggregateType: "aanvraag",
        eventType: "aanvraag.nieuw",
        id: "e4",
        payload: {},
        sequenceNumber: 4n,
      },
      {
        aggregateId: "bron-1",
        aggregateType: "bron",
        eventType: "bron.geactiveerd",
        id: "e5",
        payload: {},
        sequenceNumber: 5n,
      },
    ];
    const requested: string[][] = [];
    const plan = await planOutboxBatch({
      events,
      loadDocuments: (ids) => {
        requested.push([...ids]);
        return Promise.resolve(
          new Map([
            [document.id, document],
            [other.id, other],
          ])
        );
      },
    });
    expect(requested).toEqual([[document.id, other.id]]);
    expect(plan.mutations.map((mutation) => mutation.kind)).toEqual([
      "upsert",
      "upsert",
    ]);
    expect(plan.mutations.map((mutation) => mutation.sequenceNumber)).toEqual([
      3n,
      4n,
    ]);
    expect(plan.noopEventIds).toEqual(["e5"]);
    expect(plan.appliedSequence).toBe(5n);
  });

  it("skips the engine write when the projection hash is unchanged", async () => {
    const engine = new InMemorySearchEngine();
    let applied = 0;
    const counting: SearchEngine = {
      applyBatch: (batch) => {
        applied += batch.mutations.length;
        return engine.applyBatch(batch);
      },
      deleteDocument: (id) => engine.deleteDocument(id),
      getAppliedVersion: () => engine.getAppliedVersion(),
      search: (params) => engine.search(params),
      upsertDocument: (item) => engine.upsertDocument(item),
    };
    const firstEvent: OutboxEventRecord = {
      aggregateId: document.id,
      aggregateType: "aanvraag",
      eventType: "aanvraag.nieuw",
      id: "h1",
      payload: {},
      sequenceNumber: 1n,
    };
    const events = [firstEvent];
    const secondEvent: OutboxEventRecord = {
      ...firstEvent,
      id: "h2",
      sequenceNumber: 2n,
    };
    const loader = new StaticLoader(document);

    const first = await planOutboxBatch({
      events,
      loadDocuments: () => Promise.resolve(new Map([[document.id, document]])),
    });
    expect(first.hashes.get(document.id)).toBe(projectionHash(document));
    await drainOutboxEvents({ engine: counting, events, loader });
    expect(applied).toBe(1);

    // Same document again, hash known: reported unchanged, engine receives nothing.
    const knownHashes = new Map([[document.id, projectionHash(document)]]);
    const second = await planOutboxBatch({
      events: [secondEvent],
      knownHashes,
      loadDocuments: () => Promise.resolve(new Map([[document.id, document]])),
    });
    expect(second.unchangedAggregateIds).toEqual([document.id]);
    expect(second.mutations).toEqual([]);
    expect(second.noopEventIds).toEqual(["h2"]);
    await drainOutboxEvents({
      engine: counting,
      events: [secondEvent],
      knownHashes,
      loader,
    });
    expect(applied).toBe(1);

    // A search-relevant change produces a different hash; a change outside
    // the projection (none exist on SearchDocument today) would not.
    expect(projectionHash({ ...document, titel: "Other" })).not.toBe(
      projectionHash(document)
    );
    expect(projectionHash({ ...document, status: "closed" })).not.toBe(
      projectionHash(document)
    );
    expect(projectionHash({ ...document, skills: ["Java"] })).not.toBe(
      projectionHash(document)
    );
    expect(projectionHash(structuredClone(document))).toBe(
      projectionHash(document)
    );
  });

  it("preserves the known-location projection hash field order", () => {
    const knownLocation: SearchDocument = {
      ...document,
      id: "known-location",
      locatie: "Amsterdam",
      locatieLand: "NL",
      sluitingsdatum: new Date("2026-09-05T12:00:00.000Z"),
      titel: "Known location",
    };

    // This is the canonical hash from before unknown locations began omitting
    // locatie_land. Keep the literal so moving the known field's insertion
    // point silently cannot rewrite every existing known-location row.
    expect(
      projectionHash(knownLocation, new Date("2026-09-01T00:00:00.000Z"))
    ).toBe("active:na4kuputrx.1adwm0pg3u1");
  });

  it("consumes a late mutation (delete or upsert) as a no-op when an equal or newer sequence was already applied", async () => {
    const lateDelete: OutboxEventRecord = {
      aggregateId: document.id,
      aggregateType: "aanvraag",
      eventType: "aanvraag.verwijderd",
      id: "late-delete",
      payload: {},
      sequenceNumber: 5n,
    };
    const stale = await planOutboxBatch({
      events: [lateDelete],
      knownSequences: new Map([[document.id, 6n]]),
      loadDocuments: () => Promise.resolve(new Map()),
    });
    expect(stale.mutations).toEqual([]);
    expect(stale.supersededAggregateIds).toEqual([document.id]);
    expect(stale.noopEventIds).toEqual(["late-delete"]);

    // A late upsert is superseded too, and is not even loaded.
    let loads = 0;
    const staleUpsert = await planOutboxBatch({
      events: [
        { ...lateDelete, eventType: "aanvraag.gewijzigd", id: "late-upsert" },
      ],
      knownSequences: new Map([[document.id, 5n]]),
      loadDocuments: () => {
        loads += 1;
        return Promise.resolve(new Map([[document.id, document]]));
      },
    });
    expect(loads).toBe(0);
    expect(staleUpsert.mutations).toEqual([]);
    expect(staleUpsert.supersededAggregateIds).toEqual([document.id]);

    // Same delete with no newer state applied: a real delete.
    const current = await planOutboxBatch({
      events: [lateDelete],
      knownSequences: new Map([[document.id, 4n]]),
      loadDocuments: () => Promise.resolve(new Map()),
    });
    expect(current.mutations).toEqual([
      { id: document.id, kind: "delete", sequenceNumber: 5n },
    ]);
  });

  it("re-applying the same events twice does not change the outcome", async () => {
    const engine = new InMemorySearchEngine();
    const events: OutboxEventRecord[] = [
      {
        aggregateId: document.id,
        aggregateType: "aanvraag",
        eventType: "aanvraag.nieuw",
        id: "outbox-1",
        payload: {},
        sequenceNumber: 3n,
      },
    ];
    const loader = new StaticLoader(document);

    const first = await drainOutboxEvents({ engine, events, loader });
    const second = await drainOutboxEvents({ engine, events, loader });

    expect(second).toEqual(first);
    const result = await engine.search({
      ast: null,
      filters: {},
      limit: 10,
      offset: 0,
    });
    expect(result.total).toBe(1);
  });
});
