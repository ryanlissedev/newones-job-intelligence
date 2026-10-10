import { describe, expect, it } from "bun:test";

import { MOTIAN_DERIVED_FIELD_NAMES } from "./motian-v1-derived-field-repair";
import type { MotianDerivedFieldRepairManifestEntry } from "./motian-v1-derived-field-repair";
import {
  BENIGN_BULK_REJECTION_REASONS,
  MOTIAN_BULK_CANDIDATE_NULL_COLUMNS,
  MOTIAN_V1_DERIVED_FIELD_BULK_STATE_VERSION,
  parseBulkArguments,
  runBulkRepair,
  stateTemporaryPath,
  writeStateFile,
} from "./repair-motian-v1-derived-fields-bulk";
import type {
  BulkApplyOutcome,
  BulkCliArguments,
  BulkRepairDependencies,
  BulkRepairState,
  BulkReportOutcome,
  StateFileIo,
} from "./repair-motian-v1-derived-fields-bulk";

const STATE_PATH = "/secure/path/bulk-state.json";

const aanvraagId = (index: number): string =>
  `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

const candidate = (index: number): MotianDerivedFieldRepairManifestEntry => ({
  aanvraagId: aanvraagId(index),
  bronId: "00000000-0000-4000-8000-000000000030",
  bronReferentie: `reference-${index}`,
  contentHash: String(index).padStart(64, "0"),
  rawPayloadRef: `raw/source/2026/09/${String(index).padStart(64, "0")}.json`,
  v1Id: `motian-${index}`,
});

const corpus = (size: number): MotianDerivedFieldRepairManifestEntry[] =>
  Array.from({ length: size }, (_value, offset) => candidate(offset + 1));

const applyOutcome = (
  selected: number,
  overrides: Partial<BulkApplyOutcome> = {}
): BulkApplyOutcome => ({
  applied: selected,
  candidates: Array.from({ length: selected }, (_value, offset) => ({
    auditId: `audit-${offset}`,
    status: "applied",
  })),
  rejected: {},
  selected,
  ...overrides,
});

const reportOutcome = (
  selected: number,
  overrides: Partial<BulkReportOutcome> = {}
): BulkReportOutcome => ({
  projectionEventsRequired: selected,
  rejected: {},
  selected,
  ...overrides,
});

interface Harness {
  readonly applyCalls: { readonly manifestSha256: string }[];
  readonly cursors: string[];
  readonly dependencies: BulkRepairDependencies;
  readonly reportCalls: { readonly manifestSha256: string }[];
  readonly writes: BulkRepairState[];
}

const createHarness = (input: {
  readonly candidates: readonly MotianDerivedFieldRepairManifestEntry[];
  readonly onApply?: (batchIndex: number, selected: number) => BulkApplyOutcome;
  readonly storedState?: BulkRepairState | null;
}): Harness => {
  const cursors: string[] = [];
  const writes: BulkRepairState[] = [];
  const applyCalls: { manifestSha256: string }[] = [];
  const reportCalls: { manifestSha256: string }[] = [];

  const dependencies: BulkRepairDependencies = {
    now: () => "2026-09-11T00:00:00.000Z",
    readState: () => Promise.resolve(input.storedState ?? null),
    runApply: ({ manifest, manifestSha256 }) => {
      const batchIndex = applyCalls.length;
      applyCalls.push({ manifestSha256 });
      return Promise.resolve(
        input.onApply?.(batchIndex, manifest.candidates.length) ??
          applyOutcome(manifest.candidates.length)
      );
    },
    runReport: ({ manifest, manifestSha256 }) => {
      reportCalls.push({ manifestSha256 });
      return Promise.resolve(reportOutcome(manifest.candidates.length));
    },
    selectCandidates: ({ batch, cursor }) => {
      cursors.push(cursor);
      const start = input.candidates.findIndex(
        (entry) => entry.aanvraagId > cursor
      );
      if (start === -1) {
        return Promise.resolve([]);
      }
      return Promise.resolve(input.candidates.slice(start, start + batch));
    },
    writeState: (_statePath, state) => {
      writes.push(state);
      return Promise.resolve();
    },
  };

  return { applyCalls, cursors, dependencies, reportCalls, writes };
};

const cliArguments = (
  overrides: Partial<BulkCliArguments> = {}
): BulkCliArguments => ({
  apply: false,
  batch: 2,
  maxBatches: 10,
  statePath: STATE_PATH,
  ...overrides,
});

describe("parseBulkArguments", () => {
  it("rejects --apply without --ingest-quiesced before any database work", () => {
    expect(() =>
      parseBulkArguments([
        "--apply",
        "--max-batches",
        "3",
        "--state",
        STATE_PATH,
      ])
    ).toThrow("--apply requires --ingest-quiesced");
  });

  it("rejects --ingest-quiesced in report mode", () => {
    expect(() =>
      parseBulkArguments([
        "--ingest-quiesced",
        "--max-batches",
        "3",
        "--state",
        STATE_PATH,
      ])
    ).toThrow("--apply requires --ingest-quiesced");
  });

  it("requires --max-batches and --state", () => {
    expect(() => parseBulkArguments(["--state", STATE_PATH])).toThrow(
      "--max-batches is required"
    );
    expect(() => parseBulkArguments(["--max-batches", "1"])).toThrow(
      "--state is required"
    );
  });

  it("defaults the batch size to the bounded manifest maximum", () => {
    expect(
      parseBulkArguments(["--max-batches", "3", "--state", STATE_PATH])
    ).toEqual({
      apply: false,
      batch: 100,
      cursor: undefined,
      maxBatches: 3,
      statePath: STATE_PATH,
    });
  });

  it("bounds --batch to the manifest maximum and validates --cursor", () => {
    expect(() =>
      parseBulkArguments([
        "--batch",
        "101",
        "--max-batches",
        "1",
        "--state",
        STATE_PATH,
      ])
    ).toThrow("--batch must be an integer from 1 through 100");
    expect(() =>
      parseBulkArguments([
        "--cursor",
        "not-a-uuid",
        "--max-batches",
        "1",
        "--state",
        STATE_PATH,
      ])
    ).toThrow("--cursor must be an aanvraag uuid");
  });

  it("accepts a full apply invocation", () => {
    expect(
      parseBulkArguments([
        "--apply",
        "--ingest-quiesced",
        "--batch",
        "50",
        "--max-batches",
        "12",
        "--cursor",
        aanvraagId(7),
        "--state",
        STATE_PATH,
      ])
    ).toEqual({
      apply: true,
      batch: 50,
      cursor: aanvraagId(7),
      maxBatches: 12,
      statePath: STATE_PATH,
    });
  });
});

const bulkToolSource = () =>
  Bun.file(`${import.meta.dir}/repair-motian-v1-derived-fields-bulk.ts`).text();

describe("candidate selection predicate", () => {
  it("covers exactly the derived fields the bounded tool repairs", () => {
    expect(MOTIAN_BULK_CANDIDATE_NULL_COLUMNS).toEqual([
      "contracttype",
      "opdrachtgever_naam",
      "opleidingsniveau",
      "provincie",
      "publicatiedatum",
      "skills",
      "sluitingsdatum",
      "start_datum",
      "tarief_eenheid",
      "tarief_max",
      "tarief_min",
      "uren_per_week",
    ]);
    expect(MOTIAN_BULK_CANDIDATE_NULL_COLUMNS).toHaveLength(
      MOTIAN_DERIVED_FIELD_NAMES.length
    );
  });

  it("tests every one of those columns for null and nothing else", async () => {
    const text = await bulkToolSource();
    for (const column of MOTIAN_BULK_CANDIDATE_NULL_COLUMNS) {
      if (column === "skills") {
        expect(text).toContain("bron_specifiek->'skills'");
        continue;
      }
      if (column === "opleidingsniveau" || column === "provincie") {
        expect(text).toContain(`bron_specifiek->>'${column}'`);
        continue;
      }
      expect(text).toContain(`${column} IS NULL`);
    }
    expect(text.match(/ IS NULL/gu)).toHaveLength(
      MOTIAN_BULK_CANDIDATE_NULL_COLUMNS.length
    );
  });

  it("selects on uren_per_week now that commercial Motian repair writes it", async () => {
    expect(await bulkToolSource()).toContain("uren_per_week IS NULL");
  });

  it("keeps the v1_id and content addressed raw pointer clauses", async () => {
    const text = await bulkToolSource();
    expect(text).toContain("v1_id IS NOT NULL");
    expect(text).toContain("raw_payload_ref LIKE 'raw/%' || content_hash");
  });
});

describe("runBulkRepair", () => {
  it("pages through candidates by cursor in batch order", async () => {
    const harness = createHarness({ candidates: corpus(5) });

    const summary = await runBulkRepair({
      arguments_: cliArguments(),
      dependencies: harness.dependencies,
    });

    expect(harness.cursors).toEqual([
      "00000000-0000-0000-0000-000000000000",
      aanvraagId(2),
      aanvraagId(4),
    ]);
    expect(summary.stopReason).toBe("corpus_exhausted");
    expect(summary.state.cursor).toBe(aanvraagId(5));
    expect(summary.state.batches.map((batch) => batch.selected)).toEqual([
      2, 2, 1,
    ]);
    expect(summary.state.batches.map((batch) => batch.index)).toEqual([
      0, 1, 2,
    ]);
    expect(summary.state.totals).toEqual({
      batches: 3,
      rejected: 0,
      selected: 5,
      wouldPatch: 5,
    });
    expect(harness.writes).toHaveLength(3);
  });

  it("stops at --max-batches with the corpus unfinished", async () => {
    const harness = createHarness({ candidates: corpus(20) });

    const summary = await runBulkRepair({
      arguments_: cliArguments({ maxBatches: 2 }),
      dependencies: harness.dependencies,
    });

    expect(summary.stopReason).toBe("max_batches");
    expect(summary.state.batches).toHaveLength(2);
    expect(summary.state.cursor).toBe(aanvraagId(4));
    expect(harness.reportCalls).toHaveLength(2);
  });

  it("resumes from the state file cursor when --cursor is absent", async () => {
    const stored: BulkRepairState = {
      batches: [],
      cursor: aanvraagId(4),
      totals: { batches: 0, rejected: 0, selected: 0, wouldPatch: 0 },
      version: MOTIAN_V1_DERIVED_FIELD_BULK_STATE_VERSION,
    };
    const harness = createHarness({
      candidates: corpus(6),
      storedState: stored,
    });

    const summary = await runBulkRepair({
      arguments_: cliArguments({ maxBatches: 1 }),
      dependencies: harness.dependencies,
    });

    expect(harness.cursors).toEqual([aanvraagId(4)]);
    expect(summary.state.cursor).toBe(aanvraagId(6));
  });

  it("prefers an explicit --cursor but keeps the recorded batch history", async () => {
    const stored: BulkRepairState = {
      batches: [
        {
          auditIds: ["audit-earlier"],
          finishedAt: "2026-09-10T00:00:01.000Z",
          index: 0,
          manifestSha256: "a".repeat(64),
          patched: 2,
          rejected: 0,
          rejectedReasons: {},
          selected: 2,
          startedAt: "2026-09-10T00:00:00.000Z",
        },
      ],
      cursor: aanvraagId(4),
      totals: { batches: 1, patched: 2, rejected: 0, selected: 2 },
      version: MOTIAN_V1_DERIVED_FIELD_BULK_STATE_VERSION,
    };
    const harness = createHarness({
      candidates: corpus(6),
      storedState: stored,
    });

    const summary = await runBulkRepair({
      arguments_: cliArguments({
        apply: true,
        cursor: aanvraagId(1),
        maxBatches: 1,
      }),
      dependencies: harness.dependencies,
    });

    expect(harness.cursors).toEqual([aanvraagId(1)]);
    expect(summary.state.batches).toHaveLength(2);
    expect(summary.state.batches[0]?.auditIds).toEqual(["audit-earlier"]);
    expect(summary.state.batches[1]?.index).toBe(1);
    expect(summary.state.totals.patched).toBe(4);
  });

  it("stops on the first apply batch with a blocking rejection reason", async () => {
    const harness = createHarness({
      candidates: corpus(10),
      onApply: (batchIndex, selected) =>
        batchIndex === 1
          ? applyOutcome(selected, {
              applied: 1,
              candidates: [{ auditId: "audit-ok", status: "applied" }],
              rejected: { current_row_mismatch: 1 },
            })
          : applyOutcome(selected),
    });

    const summary = await runBulkRepair({
      arguments_: cliArguments({ apply: true }),
      dependencies: harness.dependencies,
    });

    expect(summary.stopReason).toBe("rejected");
    expect(summary.blockingReasons).toEqual(["current_row_mismatch"]);
    expect(harness.applyCalls).toHaveLength(2);
    expect(summary.state.batches).toHaveLength(2);
    expect(summary.state.cursor).toBe(aanvraagId(4));
    const lastBatch = summary.state.batches.at(-1);
    expect(lastBatch?.rejected).toBe(1);
    expect(lastBatch?.rejectedReasons).toEqual({ current_row_mismatch: 1 });
    expect(lastBatch?.patched).toBe(1);
    expect(lastBatch?.auditIds).toEqual(["audit-ok"]);
    expect(harness.writes.at(-1)).toEqual(summary.state);
    expect(summary.state.totals).toEqual({
      batches: 2,
      patched: 3,
      rejected: 1,
      selected: 4,
    });
  });

  it("continues an apply run past batches rejected only as raw_schema_not_motian", async () => {
    const harness = createHarness({
      candidates: corpus(6),
      onApply: (batchIndex, selected) =>
        batchIndex === 1
          ? applyOutcome(selected, {
              applied: 0,
              candidates: [],
              rejected: { raw_schema_not_motian: selected },
            })
          : applyOutcome(selected),
    });

    const summary = await runBulkRepair({
      arguments_: cliArguments({ apply: true }),
      dependencies: harness.dependencies,
    });

    expect(summary.stopReason).toBe("corpus_exhausted");
    expect(summary.blockingReasons).toEqual([]);
    expect(harness.applyCalls).toHaveLength(3);
    expect(summary.state.batches).toHaveLength(3);
    expect(summary.state.cursor).toBe(aanvraagId(6));
    expect(summary.state.batches[1]?.rejectedReasons).toEqual({
      raw_schema_not_motian: 2,
    });
    expect(summary.state.batches[1]?.patched).toBe(0);
    expect(summary.state.totals).toEqual({
      batches: 3,
      patched: 4,
      rejected: 2,
      selected: 6,
    });
  });

  it("stops when a blocking reason accompanies a benign one", async () => {
    const harness = createHarness({
      candidates: corpus(6),
      onApply: (_batchIndex, selected) =>
        applyOutcome(selected, {
          applied: 0,
          candidates: [],
          rejected: { raw_schema_not_motian: 1, transaction_failed: 1 },
        }),
    });

    const summary = await runBulkRepair({
      arguments_: cliArguments({ apply: true }),
      dependencies: harness.dependencies,
    });

    expect(summary.stopReason).toBe("rejected");
    expect(summary.blockingReasons).toEqual(["transaction_failed"]);
    expect(harness.applyCalls).toHaveLength(1);
    expect(summary.state.batches).toHaveLength(1);
    expect(summary.state.batches[0]?.rejectedReasons).toEqual({
      raw_schema_not_motian: 1,
      transaction_failed: 1,
    });
  });

  it("treats raw_schema_not_motian as the only benign reason", () => {
    expect([...BENIGN_BULK_REJECTION_REASONS]).toEqual([
      "raw_schema_not_motian",
    ]);
  });

  it("does not stop report mode on expected rejections", async () => {
    const harness = createHarness({ candidates: corpus(4) });
    const dependencies: BulkRepairDependencies = {
      ...harness.dependencies,
      runReport: ({ manifest }) =>
        Promise.resolve(
          reportOutcome(manifest.candidates.length, {
            projectionEventsRequired: 0,
            rejected: { raw_schema_not_motian: manifest.candidates.length },
          })
        ),
    };

    const summary = await runBulkRepair({
      arguments_: cliArguments(),
      dependencies,
    });

    expect(summary.stopReason).toBe("corpus_exhausted");
    expect(summary.state.batches).toHaveLength(2);
    expect(summary.state.totals.rejected).toBe(4);
  });

  it("never calls apply in report mode", async () => {
    const harness = createHarness({ candidates: corpus(4) });

    await runBulkRepair({
      arguments_: cliArguments(),
      dependencies: harness.dependencies,
    });

    expect(harness.applyCalls).toHaveLength(0);
    expect(harness.reportCalls).toHaveLength(2);
  });

  it("records a stable manifest digest per batch and no candidate identifiers", async () => {
    const first = createHarness({ candidates: corpus(2) });
    const second = createHarness({ candidates: corpus(2) });

    const firstSummary = await runBulkRepair({
      arguments_: cliArguments({ maxBatches: 1 }),
      dependencies: first.dependencies,
    });
    const secondSummary = await runBulkRepair({
      arguments_: cliArguments({ maxBatches: 1 }),
      dependencies: second.dependencies,
    });

    const digest = firstSummary.state.batches[0]?.manifestSha256;
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(secondSummary.state.batches[0]?.manifestSha256).toBe(digest);
    expect(first.reportCalls[0]?.manifestSha256).toBe(digest);

    const serialized = JSON.stringify(firstSummary.state);
    expect(serialized).not.toContain("reference-");
    expect(serialized).not.toContain("raw/source");
    expect(serialized).not.toContain("motian-1");
  });
});

describe("writeStateFile", () => {
  it("writes a temporary file and then renames it over the state path", async () => {
    const calls: string[] = [];
    const io: StateFileIo = {
      rename: (from, to) => {
        calls.push(`rename ${from} -> ${to}`);
        return Promise.resolve();
      },
      write: (path) => {
        calls.push(`write ${path}`);
        return Promise.resolve();
      },
    };
    const state: BulkRepairState = {
      batches: [],
      cursor: aanvraagId(1),
      totals: { batches: 0, rejected: 0, selected: 0 },
      version: MOTIAN_V1_DERIVED_FIELD_BULK_STATE_VERSION,
    };

    await writeStateFile(STATE_PATH, state, io);

    expect(calls).toEqual([
      `write ${stateTemporaryPath(STATE_PATH)}`,
      `rename ${stateTemporaryPath(STATE_PATH)} -> ${STATE_PATH}`,
    ]);
  });

  it("serializes the state as indented json with a trailing newline", async () => {
    const bodies: string[] = [];
    const io: StateFileIo = {
      rename: () => Promise.resolve(),
      write: (_path, body) => {
        bodies.push(body);
        return Promise.resolve();
      },
    };
    const state: BulkRepairState = {
      batches: [],
      cursor: aanvraagId(1),
      totals: { batches: 0, rejected: 0, selected: 0 },
      version: MOTIAN_V1_DERIVED_FIELD_BULK_STATE_VERSION,
    };

    await writeStateFile(STATE_PATH, state, io);

    expect(bodies[0]).toBe(`${JSON.stringify(state, null, 2)}\n`);
  });
});
