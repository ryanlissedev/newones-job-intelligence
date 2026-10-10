import { describe, expect, it } from "bun:test";

import type {
  BackfillFailureEvidence,
  BackfillProvenanceRecord,
  BackfillRunEvidence,
} from "@ji/application/backfill";
import { drizzle } from "drizzle-orm/pg-proxy";

import {
  PostgresBackfillProvenanceStore,
  PostgresBackfillRunStore,
} from "./backfill-stores";
import type { BackfillDatabase } from "./backfill-stores";
import * as schema from "./schema";

const metrics = {
  duplicates: 0,
  errors: 1,
  extra: 0,
  found: 0,
  imported: 0,
  matched: 0,
  missing: 0,
  platforms: {},
  rejected: 0,
  selected: 0,
  skipped: 0,
};

interface PersistedRunUpdate {
  readonly aantalGevonden: number;
  readonly checkpoint: { readonly backfill: BackfillRunEvidence };
  readonly failureClass: string;
  readonly failureCode: string;
  readonly failureMessage: string;
  readonly failurePhase: string;
  readonly fouten: number;
  readonly geindigd: Date;
  readonly nieuw: number;
  readonly rejected: number;
  readonly status: string;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- isolated test seam for a fluent Drizzle adapter
const asBackfillDatabase = (value: unknown): BackfillDatabase =>
  // SAFETY: callers provide the exact database chain used by the test.
  value as BackfillDatabase;

const createRunStore = () => {
  let persisted: PersistedRunUpdate | undefined;
  const database = {
    update: () => ({
      set: (values: PersistedRunUpdate) => {
        persisted = structuredClone(values);
        return {
          where: () => ({
            returning: () => Promise.resolve([{ id: "run-1" }]),
          }),
        };
      },
    }),
  };
  return {
    persisted: () => persisted,
    store: new PostgresBackfillRunStore(asBackfillDatabase(database)),
  };
};

describe("Postgres backfill failure evidence", () => {
  it("persists versioned source and target digests in a successful checkpoint", async () => {
    const sourceDigest = "a".repeat(64);
    const evidence: BackfillRunEvidence = {
      execution: { mode: "production", scope: "full" },
      metrics: { ...metrics, errors: 0 },
      scopeManifest: {
        contractVersion: "motian-v1-scope-manifest/v1",
        digestAlgorithm: "sha256",
        itemEncoding: "json-array-line/v1",
        order: "source-id-ascending",
        orderedDigest: sourceDigest,
        platformCounts: { werkzoeken: 1 },
        selected: 1,
        snapshot: {
          completedAt: "2026-09-02T10:05:00.000Z",
          startedAt: "2026-09-02T10:00:00.000Z",
        },
      },
      targetReconciliation: {
        contractVersion: "motian-v1-target-reconciliation/v1",
        digestAlgorithm: "sha256",
        distinctV1Ids: 1,
        itemEncoding: "json-array-line/v1",
        matchesScope: true,
        order: "source-id-ascending",
        orderedDigest: sourceDigest,
        platformCounts: { werkzoeken: 1 },
        records: 1,
        snapshot: {
          completedAt: "2026-09-02T10:06:00.000Z",
          startedAt: "2026-09-02T10:05:30.000Z",
        },
      },
    };
    const { persisted, store } = createRunStore();

    await store.completeRun("run-1", evidence);

    expect(persisted()).toMatchObject({
      checkpoint: { backfill: evidence },
      status: "succeeded",
    });
  });

  it("persists the safe typed failure in the checkpoint and terminal state", async () => {
    const failure: BackfillFailureEvidence = {
      code: "RAW_READBACK_FAILED",
      phase: "raw-write",
    };
    const evidence: BackfillRunEvidence = {
      execution: { mode: "production", scope: "full" },
      failure,
      metrics,
    };
    const { persisted, store } = createRunStore();

    await store.failRun("run-1", failure, evidence);

    expect(persisted()).toMatchObject({
      checkpoint: { backfill: evidence },
      failureClass: "internal",
      failureCode: "UNEXPECTED_FAILURE",
      failureMessage: "Connector run failed",
      failurePhase: "unknown",
      status: "failed",
    });
    expect(JSON.stringify(persisted())).not.toContain("postgresql://");
  });

  it("refuses a terminal failure that disagrees with checkpoint evidence", async () => {
    const { store } = createRunStore();
    const failure: BackfillFailureEvidence = {
      code: "SOURCE_READ_FAILED",
      phase: "source-read",
    };

    await expect(
      store.failRun("run-1", failure, {
        execution: { mode: "production", scope: "full" },
        failure: { code: "PROVENANCE_MISMATCH", phase: "provenance" },
        metrics,
      })
    ).rejects.toThrow(
      "Backfill failure evidence does not match terminal state"
    );
  });
});

/* oxlint-disable node/callback-return, promise/prefer-await-to-callbacks -- Drizzle transaction test doubles intentionally mirror its callback API. */
describe("Postgres backfill launch fencing", () => {
  const createLaunchDatabase = (running: boolean) => {
    const events: string[] = [];
    const transaction = {
      execute: () => {
        events.push("lock");
        return Promise.resolve([]);
      },
      insert: () => ({
        values: () => ({
          returning: () => {
            events.push("insert");
            return Promise.resolve([{ id: "new-run" }]);
          },
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => {
              events.push("running-check");
              return Promise.resolve(running ? [{ id: "running-run" }] : []);
            },
          }),
        }),
      }),
    };
    const database = {
      transaction: <Result>(
        callback: (value: typeof transaction) => Promise<Result>
      ): Promise<Result> => callback(transaction),
    };
    return { database: asBackfillDatabase(database), events };
  };

  it("serializes launch and refuses a second running backfill", async () => {
    const { database, events } = createLaunchDatabase(true);
    const store = new PostgresBackfillRunStore(database);

    await expect(store.startRun("bron-1")).rejects.toThrow(
      "A Motian v1 backfill is already running"
    );

    expect(events).toEqual(["lock", "running-check"]);
  });

  it("starts after the serialized running-row check is clear", async () => {
    const { database, events } = createLaunchDatabase(false);
    const store = new PostgresBackfillRunStore(database);

    await expect(store.startRun("bron-1")).resolves.toMatchObject({
      scrapeRunId: expect.any(String),
    });

    expect(events).toEqual(["lock", "running-check", "insert"]);
  });
});

describe("Postgres backfill target reconciliation snapshot", () => {
  it("streams ordered keyset pages from one repeatable-read read-only transaction", async () => {
    const pages = [
      [
        {
          aanvraagId: "aanvraag-1",
          bronId: "bron-1",
          bronReferentie: "ref-1",
          contentHash: "hash-1",
          rawPayloadRef: "raw/ref-1.json",
          v1Id: "v1-1",
        },
        {
          aanvraagId: "aanvraag-2",
          bronId: "bron-1",
          bronReferentie: "ref-2",
          contentHash: "hash-2",
          rawPayloadRef: "raw/ref-2.json",
          v1Id: "v1-2",
        },
      ],
      [
        {
          aanvraagId: "aanvraag-3",
          bronId: "bron-2",
          bronReferentie: "ref-3",
          contentHash: "hash-3",
          rawPayloadRef: "raw/ref-3.json",
          v1Id: "v1-3",
        },
      ],
    ];
    let page = 0;
    let clock = 0;
    let transactionConfig:
      | { accessMode: string; isolationLevel: string }
      | undefined;
    const transaction = {
      execute: () => {
        clock += 1;
        return Promise.resolve(
          clock === 1
            ? [{ snapshot_started_at: "2026-09-02T10:00:00.000Z" }]
            : [{ snapshot_completed_at: "2026-09-02T10:05:00.000Z" }]
        );
      },
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () => {
                const currentPage = pages[page] ?? [];
                page += 1;
                return Promise.resolve(currentPage);
              },
            }),
          }),
        }),
      }),
    };
    const database = {
      transaction: async <Result>(
        callback: (value: typeof transaction) => Promise<Result>,
        config: { accessMode: string; isolationLevel: string }
      ): Promise<Result> => {
        transactionConfig = config;
        return await callback(transaction);
      },
    };
    const store = new PostgresBackfillProvenanceStore(
      asBackfillDatabase(database)
    );
    const records: {
      bronId: string;
      bronReferentie: string;
      contentHash: string;
      rawPayloadRef: string;
      v1Id: string;
    }[] = [];

    const snapshot = await store.consumeReconciliationSnapshot(
      ["bron-1", "bron-2"],
      2,
      (batch) => {
        records.push(...batch);
        return Promise.resolve();
      }
    );

    expect(transactionConfig).toEqual({
      accessMode: "read only",
      isolationLevel: "repeatable read",
    });
    expect(records).toEqual([
      {
        bronId: "bron-1",
        bronReferentie: "ref-1",
        contentHash: "hash-1",
        rawPayloadRef: "raw/ref-1.json",
        v1Id: "v1-1",
      },
      {
        bronId: "bron-1",
        bronReferentie: "ref-2",
        contentHash: "hash-2",
        rawPayloadRef: "raw/ref-2.json",
        v1Id: "v1-2",
      },
      {
        bronId: "bron-2",
        bronReferentie: "ref-3",
        contentHash: "hash-3",
        rawPayloadRef: "raw/ref-3.json",
        v1Id: "v1-3",
      },
    ]);
    expect(snapshot).toEqual({
      completedAt: "2026-09-02T10:05:00.000Z",
      startedAt: "2026-09-02T10:00:00.000Z",
    });
  });

  it("rejects when the reconciliation snapshot commit is lost", async () => {
    let clock = 0;
    const transaction = {
      execute: () => {
        clock += 1;
        return Promise.resolve(
          clock === 1
            ? [{ snapshot_started_at: "2026-09-02T10:00:00.000Z" }]
            : [{ snapshot_completed_at: "2026-09-02T10:05:00.000Z" }]
        );
      },
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: () => Promise.resolve([]) }),
          }),
        }),
      }),
    };
    const database = {
      transaction: async <Result>(
        callback: (value: typeof transaction) => Promise<Result>
      ): Promise<Result> => {
        await callback(transaction);
        throw new Error("target snapshot commit lost");
      },
    };
    const store = new PostgresBackfillProvenanceStore(
      asBackfillDatabase(database)
    );

    await expect(
      store.consumeReconciliationSnapshot(["bron-1"], 1000, () =>
        Promise.resolve()
      )
    ).rejects.toThrow("target snapshot commit lost");
  });
});
/* oxlint-enable node/callback-return, promise/prefer-await-to-callbacks */

interface RecordedQuery {
  readonly params: unknown[];
  readonly sql: string;
}

/**
 * Runs the real Drizzle query builder against a scripted driver so the tests
 * exercise the SQL the store actually emits, rather than a hand-written fake
 * that could agree with a wrong query. Each queued response is the array-mode
 * row set Postgres would have returned for the next statement.
 */
const createScriptedDatabase = (responses: readonly unknown[][][]) => {
  const queue = [...responses];
  const queries: RecordedQuery[] = [];
  const database = asBackfillDatabase(
    drizzle(
      (sql, params) => {
        queries.push({ params, sql });
        const rows = queue.shift();
        if (rows === undefined) {
          throw new Error(`Unexpected query: ${sql}`);
        }
        return Promise.resolve({ rows });
      },
      { schema }
    )
  );
  return { database, queries };
};

const V1_ID = "motian-v1-job-1";
const OTHER_V1_ID = "motian-v1-job-2";
const AANVRAAG_ID = "0f2c0a0e-4e1b-4d7e-9c6a-2b7f2d5a9e11";

const provenanceRecord = (v1Id: string): BackfillProvenanceRecord => ({
  aanvraagId: AANVRAAG_ID,
  bronId: "6b1d4a72-0f3c-4d55-8a21-9c7e4f0b3d18",
  bronReferentie: "motian-external-1",
  contentHash: "sha256:0f2c0a0e4e1b4d7e9c6a2b7f2d5a9e11",
  rawPayloadRef: "motian/v1/job-1.json",
  v1Id,
});

const GUARDED_UPDATE =
  /update "curated"\."aanvraag" set .*"v1_id" = \$\d+ where \("curated"\."aanvraag"\."id" = \$\d+ and \("curated"\."aanvraag"\."v1_id" is null or "curated"\."aanvraag"\."v1_id" = \$\d+\)\) returning "id", "bron_id", "bron_referentie", "content_hash", "raw_payload_ref", "v1_id"/u;

describe("PostgresBackfillProvenanceStore.findByAanvraagId", () => {
  it("reads only a bound aanvraag row", async () => {
    const { database, queries } = createScriptedDatabase([
      [
        [
          AANVRAAG_ID,
          "6b1d4a72-0f3c-4d55-8a21-9c7e4f0b3d18",
          "motian-external-1",
          "sha256:0f2c0a0e4e1b4d7e9c6a2b7f2d5a9e11",
          "motian/v1/job-1.json",
          V1_ID,
        ],
      ],
      [],
    ]);
    const store = new PostgresBackfillProvenanceStore(database);

    expect(await store.findByAanvraagId(AANVRAAG_ID)).toEqual(
      provenanceRecord(V1_ID)
    );
    expect(await store.findByAanvraagId("missing")).toBeNull();

    expect(queries[0]?.sql).toMatch(
      /where \("curated"\."aanvraag"\."id" = \$1 and "curated"\."aanvraag"\."v1_id" is not null\) limit \$2/u
    );
  });
});

describe("PostgresBackfillProvenanceStore.registerV1Id", () => {
  it("binds a v1_id to an unbound aanvraag with a guarded update", async () => {
    const expected = provenanceRecord(V1_ID);
    const { database, queries } = createScriptedDatabase([
      [
        [
          expected.aanvraagId,
          expected.bronId,
          expected.bronReferentie,
          expected.contentHash,
          expected.rawPayloadRef,
          expected.v1Id,
        ],
      ],
    ]);
    const store = new PostgresBackfillProvenanceStore(database);

    await expect(store.registerV1Id(expected)).resolves.toEqual(expected);

    expect(queries).toHaveLength(1);
    const [update] = queries;
    expect(update?.sql).toMatch(GUARDED_UPDATE);
    expect(update?.params).toContain(AANVRAAG_ID);
    expect(update?.params.filter((param) => param === V1_ID)).toHaveLength(2);
  });

  it("refuses to re-point an aanvraag already bound to a different v1_id", async () => {
    const { database, queries } = createScriptedDatabase([[], [[OTHER_V1_ID]]]);
    const store = new PostgresBackfillProvenanceStore(database);

    await expect(store.registerV1Id(provenanceRecord(V1_ID))).rejects.toThrow(
      new RegExp(
        `Refusing to register v1_id ${V1_ID} on aanvraag ${AANVRAAG_ID}: expected exactly 1 row updated, got 0 \\(aanvraag is already bound to v1_id ${OTHER_V1_ID}; overwriting would break provenance\\)`,
        "u"
      )
    );

    expect(queries).toHaveLength(2);
    expect(queries[0]?.sql).toMatch(GUARDED_UPDATE);
    expect(queries[1]?.sql).toMatch(
      /select "v1_id" from "curated"\."aanvraag" where "curated"\."aanvraag"\."id" = \$1 limit \$2/u
    );
  });

  it("fails closed with a cause when the aanvraag row does not exist", async () => {
    const { database } = createScriptedDatabase([[], []]);
    const store = new PostgresBackfillProvenanceStore(database);

    await expect(store.registerV1Id(provenanceRecord(V1_ID))).rejects.toThrow(
      /expected exactly 1 row updated, got 0 \(aanvraag row does not exist\)/u
    );
  });

  it("fails closed and diagnoses an update that returns multiple rows", async () => {
    const expected = provenanceRecord(V1_ID);
    const returnedRow = [
      expected.aanvraagId,
      expected.bronId,
      expected.bronReferentie,
      expected.contentHash,
      expected.rawPayloadRef,
      expected.v1Id,
    ];
    const { database, queries } = createScriptedDatabase([
      [returnedRow, returnedRow],
      [[V1_ID]],
    ]);
    const store = new PostgresBackfillProvenanceStore(database);

    await expect(store.registerV1Id(expected)).rejects.toThrow(
      /expected exactly 1 row updated, got 2 \(row matched but the guarded update did not apply\)/u
    );

    expect(queries).toHaveLength(2);
    expect(queries[0]?.sql).toMatch(GUARDED_UPDATE);
    expect(queries[1]?.sql).toMatch(
      /select "v1_id" from "curated"\."aanvraag" where "curated"\."aanvraag"\."id" = \$1 limit \$2/u
    );
  });
});
