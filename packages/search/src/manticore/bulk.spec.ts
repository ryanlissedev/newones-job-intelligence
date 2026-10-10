import { describe, expect, it } from "bun:test";

import { z } from "zod";

import type { SearchDocument, SearchIndexMutation } from "../types";
import { InMemorySearchVersionStore } from "../version";
import type { ManticoreHttpClient } from "./client";
import { ManticoreSearchEngine } from "./engine";
import { hashDocumentId } from "./id-hash";
import type {
  ManticoreBulkPayload,
  ManticoreRequestBody,
  ManticoreSearchPayload,
} from "./json";

const document = (id: string): SearchDocument => ({
  beschrijving: "Azure platform engineer",
  bronId: "bron-1",
  contracttype: "detachering",
  eindklantNaam: null,
  id,
  laatstGezienOp: new Date("2026-08-01T00:00:00.000Z"),
  locatieLand: "NL",
  opdrachtgeverNaam: null,
  provincie: null,
  publicatiedatum: null,
  skills: [],
  status: "active",
  tariefEenheid: null,
  tariefMax: 100,
  tariefMin: 80,
  titel: "Engineer",
  urenPerWeekMax: null,
  urenPerWeekMin: null,
  werkvorm: null,
});

const bulkLineSchema = z.union([
  z.object({ replace: z.object({ id: z.number() }) }),
  z.object({ delete: z.object({ id: z.number() }) }),
]);
const idByHash = new Map<number, string>();
const lineId = (line: string): string => {
  const parsed: unknown = JSON.parse(line);
  const body = bulkLineSchema.parse(parsed);
  const id = "replace" in body ? body.replace.id : body.delete.id;
  return idByHash.get(id) ?? String(id);
};
for (const id of ["a", "b", "c", "d"]) {
  idByHash.set(hashDocumentId(id), id);
}

/**
 * Replays the 6.3.8 /bulk contract recorded live for RJC-389: success is
 * one aggregated item; an error names the 1-based failing line, nothing in
 * that request lands, and the response is HTTP 500 with the same JSON body.
 * `failAt` decides per request which 1-based line fails (null = success),
 * given the document ids on that request's lines.
 */
class ScriptedBulkClient implements ManticoreHttpClient {
  readonly calls: string[][] = [];
  readonly requests: string[] = [];
  private readonly failAt: (ids: string[], call: number) => number | null;

  constructor(failAt: (ids: string[], call: number) => number | null) {
    this.failAt = failAt;
  }

  bulk(lines: readonly string[]): Promise<ManticoreBulkPayload> {
    this.calls.push([...lines]);
    const ids = lines.map((line) => lineId(line));
    const failingLine = this.failAt(ids, this.calls.length);
    if (failingLine !== null) {
      return Promise.resolve({
        current_line: failingLine,
        error: "unknown column: 'boom'",
        errors: true,
        items: [],
        skipped_lines: failingLine,
      });
    }
    return Promise.resolve({
      current_line: lines.length + 1,
      error: "",
      errors: false,
      items: [{ bulk: { created: lines.length, status: 201 } }],
      skipped_lines: 0,
    });
  }

  request(
    path: string,
    _body: ManticoreRequestBody
  ): Promise<ManticoreSearchPayload> {
    this.requests.push(path);
    return Promise.resolve({ hits: { hits: [], total: 0 } });
  }
}

/** Fails line `line` only on requests carrying more than one line (isolation succeeds). */
const poisonInBatchOnly =
  (poison: string) =>
  (ids: string[]): number | null => {
    const at = ids.indexOf(poison);
    return ids.length > 1 && at !== -1 ? at + 1 : null;
  };

/** Fails whenever `poison` is on the request, alone or not. */
const poisonAlways =
  (...poison: string[]) =>
  (ids: string[]): number | null => {
    const at = ids.findIndex((id) => poison.includes(id));
    return at === -1 ? null : at + 1;
  };

const never = (): null => null;

// Steady-state mutations (RJC-383): partition known and unchanged, so each
// one is a single line — the RJC-389 contract below is unchanged for them.
const mutations: SearchIndexMutation[] = [
  {
    document: document("a"),
    kind: "upsert",
    partition: "active",
    previousPartition: "active",
    projectionHash: "planner-captured-hash",
    sequenceNumber: 10n,
  },
  {
    document: document("b"),
    kind: "upsert",
    partition: "active",
    previousPartition: "active",
    sequenceNumber: 11n,
  },
  { id: "c", kind: "delete", partition: "active", sequenceNumber: 12n },
];

describe("ManticoreSearchEngine.applyBatch over /bulk (RJC-389)", () => {
  it("sends one NDJSON request with replace and delete lines and advances to the batch sequence", async () => {
    const client = new ScriptedBulkClient(never);
    const store = new InMemorySearchVersionStore();
    const engine = new ManticoreSearchEngine(client, store);

    const result = await engine.applyBatch({
      appliedSequence: 13n,
      mutations,
    });

    expect(client.calls).toHaveLength(1);
    const lines = client.calls[0]?.map((line) => JSON.parse(line)) ?? [];
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({
      replace: { id: hashDocumentId("a"), index: "aanvragen_active" },
    });
    expect(lines[0].replace.doc).toMatchObject({
      document_id: "a",
      index_version: 13,
      projection_hash: "planner-captured-hash",
    });
    expect(lines[2]).toEqual({
      delete: { id: hashDocumentId("c"), index: "aanvragen_active" },
    });
    expect(result).toEqual({
      appliedSequence: 13n,
      failures: [],
      generation: 1,
      unapplied: [],
    });
    const checkpoint = await store.read();
    expect(checkpoint.appliedSequence).toBe(13n);
  });

  it("dual-writes the base table only when hybrid synchronization is enabled", async () => {
    const client = new ScriptedBulkClient(never);
    const engine = new ManticoreSearchEngine(
      client,
      new InMemorySearchVersionStore(),
      "aanvragen",
      () => new Date("2026-09-01T00:00:00.000Z"),
      { hybridEnabled: true }
    );

    await engine.applyBatch({
      appliedSequence: 14n,
      mutations: [
        {
          document: document("a"),
          kind: "upsert",
          partition: "active",
          previousPartition: "archive",
          sequenceNumber: 13n,
        },
        {
          id: "c",
          kind: "delete",
          partition: "archive",
          sequenceNumber: 14n,
        },
      ],
    });

    const lines = client.calls[0]?.map((line) => JSON.parse(line)) ?? [];
    expect(
      lines.map((line) => line.replace?.index ?? line.delete?.index)
    ).toEqual([
      "aanvragen_active",
      "aanvragen",
      "aanvragen_archive",
      "aanvragen_archive",
      "aanvragen",
    ]);
  });

  it("isolates a persistent poison line: blames it alone, applies the rest, watermark = their max", async () => {
    const client = new ScriptedBulkClient(poisonAlways("b"));
    const store = new InMemorySearchVersionStore();
    await store.advance(9n);
    const engine = new ManticoreSearchEngine(client, store);

    const result = await engine.applyBatch({
      appliedSequence: 13n,
      mutations,
    });

    // [a,b,c] fails at b → [b] alone fails → [a,c] applies.
    expect(client.calls.map((call) => call.map(lineId))).toEqual([
      ["a", "b", "c"],
      ["b"],
      ["a", "c"],
    ]);
    expect(result.failures).toEqual([
      { error: "unknown column: 'boom'", id: "b" },
    ]);
    expect(result.unapplied).toEqual([]);
    expect(result.appliedSequence).toBe(12n);
    const checkpoint = await store.read();
    expect(checkpoint.appliedSequence).toBe(12n);
  });

  it("does not blame a line that succeeds alone: a transient batch-wide error applies everything", async () => {
    const client = new ScriptedBulkClient(poisonInBatchOnly("b"));
    const store = new InMemorySearchVersionStore();
    const engine = new ManticoreSearchEngine(client, store);

    const result = await engine.applyBatch({
      appliedSequence: 13n,
      mutations,
    });

    expect(client.calls.map((call) => call.map(lineId))).toEqual([
      ["a", "b", "c"],
      ["b"],
      ["a", "c"],
    ]);
    expect(result).toEqual({
      appliedSequence: 13n,
      failures: [],
      generation: 1,
      unapplied: [],
    });
  });

  it("caps isolation per chunk: a second poison line releases the remainder unblamed", async () => {
    const client = new ScriptedBulkClient(poisonAlways("b", "c"));
    const store = new InMemorySearchVersionStore();
    await store.advance(9n);
    const engine = new ManticoreSearchEngine(client, store);

    const result = await engine.applyBatch({
      appliedSequence: 13n,
      mutations,
    });

    // [a,b,c] fails at b → [b] fails → [a,c] fails at c → cap reached.
    expect(client.calls).toHaveLength(3);
    expect(result.failures).toEqual([
      { error: "unknown column: 'boom'", id: "b" },
    ]);
    expect(result.unapplied).toEqual(["a", "c"]);
    // Nothing landed, so the watermark did not move.
    expect(result.appliedSequence).toBe(9n);
  });

  it("throws when Manticore fails without naming a line, leaving rows to the lease", async () => {
    const client = new ScriptedBulkClient(() => 0);
    const engine = new ManticoreSearchEngine(
      client,
      new InMemorySearchVersionStore()
    );
    await expect(
      engine.applyBatch({ appliedSequence: 13n, mutations })
    ).rejects.toThrow("without naming a line");
  });

  it("splits a body over the byte cap into independent requests and advances to the highest applied chunk", async () => {
    // Oversized beschrijving forces one line per chunk; chunk 2 (b) is a
    // persistent poison, so it is blamed and the later chunks still apply.
    const big = "x".repeat(6 * 1024 * 1024);
    const wide: SearchIndexMutation[] = [
      {
        document: { ...document("a"), beschrijving: big },
        kind: "upsert",
        partition: "active",
        previousPartition: "active",
        sequenceNumber: 10n,
      },
      {
        document: { ...document("b"), beschrijving: big },
        kind: "upsert",
        partition: "active",
        previousPartition: "active",
        sequenceNumber: 11n,
      },
      {
        document: { ...document("c"), beschrijving: big },
        kind: "upsert",
        partition: "active",
        previousPartition: "active",
        sequenceNumber: 12n,
      },
      { id: "d", kind: "delete", partition: "active", sequenceNumber: 13n },
    ];
    const client = new ScriptedBulkClient(poisonAlways("b"));
    const store = new InMemorySearchVersionStore();
    const engine = new ManticoreSearchEngine(client, store);

    const result = await engine.applyBatch({
      appliedSequence: 14n,
      mutations: wide,
    });

    // a | b (fails) | b alone (fails) | c + d (the delete line is small
    // enough to share c's chunk)
    expect(client.calls.map((call) => call.map(lineId))).toEqual([
      ["a"],
      ["b"],
      ["b"],
      ["c", "d"],
    ]);
    expect(result.failures).toEqual([
      { error: "unknown column: 'boom'", id: "b" },
    ]);
    expect(result.unapplied).toEqual([]);
    expect(result.appliedSequence).toBe(13n);
    const checkpoint = await store.read();
    expect(checkpoint.appliedSequence).toBe(13n);
  });

  it("moves a document across partitions with replace-then-delete in ONE request (RJC-383)", async () => {
    const client = new ScriptedBulkClient(never);
    const engine = new ManticoreSearchEngine(
      client,
      new InMemorySearchVersionStore()
    );

    await engine.applyBatch({
      appliedSequence: 20n,
      mutations: [
        {
          document: { ...document("a"), status: "closed" },
          kind: "upsert",
          partition: "archive",
          previousPartition: "active",
          sequenceNumber: 20n,
        },
      ],
    });

    expect(client.calls).toHaveLength(1);
    const lines = client.calls[0]?.map((line) => JSON.parse(line)) ?? [];
    // Replace FIRST: 6.3.8 commits per same-table run, so a failing replace
    // stops the request before the delete and the document stays findable.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      replace: { id: hashDocumentId("a"), index: "aanvragen_archive" },
    });
    expect(lines[1]).toEqual({
      delete: { id: hashDocumentId("a"), index: "aanvragen_active" },
    });
  });

  it("clears the other table when the previous partition is unknown, and deletes from both tables when a delete's partition is unknown", async () => {
    const client = new ScriptedBulkClient(never);
    const engine = new ManticoreSearchEngine(
      client,
      new InMemorySearchVersionStore()
    );

    await engine.applyBatch({
      appliedSequence: 21n,
      mutations: [
        { document: document("a"), kind: "upsert", sequenceNumber: 20n },
        { id: "b", kind: "delete", sequenceNumber: 21n },
      ],
    });

    const lines = client.calls[0]?.map((line) => JSON.parse(line)) ?? [];
    expect(lines).toEqual([
      expect.objectContaining({
        replace: expect.objectContaining({ index: "aanvragen_active" }),
      }),
      { delete: { id: hashDocumentId("a"), index: "aanvragen_archive" } },
      { delete: { id: hashDocumentId("b"), index: "aanvragen_active" } },
      { delete: { id: hashDocumentId("b"), index: "aanvragen_archive" } },
    ]);
  });

  it("isolates a failing MOVE as one unit: its delete never runs without its replace", async () => {
    // Line 2 of a 3-line request is the move's delete; the failure is
    // attributed to the whole mutation "b", which is re-sent alone (both
    // lines) and blamed as one id. Nothing of "b" is ever sent on its own.
    const client = new ScriptedBulkClient(poisonAlways("b"));
    const store = new InMemorySearchVersionStore();
    await store.advance(9n);
    const engine = new ManticoreSearchEngine(client, store);

    const result = await engine.applyBatch({
      appliedSequence: 13n,
      mutations: [
        {
          document: document("a"),
          kind: "upsert",
          partition: "active",
          previousPartition: "active",
          sequenceNumber: 10n,
        },
        {
          document: { ...document("b"), status: "closed" },
          kind: "upsert",
          partition: "archive",
          previousPartition: "active",
          sequenceNumber: 11n,
        },
        { id: "c", kind: "delete", partition: "active", sequenceNumber: 12n },
      ],
    });

    expect(client.calls.map((call) => call.map(lineId))).toEqual([
      ["a", "b", "b", "c"],
      ["b", "b"],
      ["a", "c"],
    ]);
    expect(result.failures).toEqual([
      { error: "unknown column: 'boom'", id: "b" },
    ]);
    expect(result.unapplied).toEqual([]);
    expect(result.appliedSequence).toBe(12n);
  });
});
