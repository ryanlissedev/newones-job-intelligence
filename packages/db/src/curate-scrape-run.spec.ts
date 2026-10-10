import { describe, expect, it } from "bun:test";

import {
  classifyRecoveryCandidate,
  isTransientPostgresError,
} from "./curate-scrape-run";

const pointer = (input: {
  contentHash: string;
  observedAt?: string;
  rawPayloadRef?: string;
  scrapeRunId: string;
  startedAt: string;
}) => ({
  contentHash: input.contentHash,
  observedAt: input.observedAt ?? input.startedAt,
  phase: "observation" as const,
  rawPayloadRef: input.rawPayloadRef ?? `raw/${input.contentHash}.json`,
  scrapeRunId: input.scrapeRunId,
  startedAt: new Date(input.startedAt),
});

describe("classifyRecoveryCandidate", () => {
  const current = pointer({
    contentHash: "hash-b",
    scrapeRunId: "00000000-0000-4000-8000-000000000002",
    startedAt: "2026-09-02T00:00:00.000Z",
  });

  it("keeps fresh same-content observations on the normal processing path", () => {
    expect(
      classifyRecoveryCandidate({
        candidate: pointer({
          contentHash: "hash-b",
          scrapeRunId: "00000000-0000-4000-8000-000000000003",
          startedAt: "2026-09-03T00:00:00.000Z",
        }),
        current,
        legacyPending: false,
      })
    ).toBe("process");
  });

  it("processes a same-run observation after lifecycle reconciliation", () => {
    expect(
      classifyRecoveryCandidate({
        candidate: pointer({
          contentHash: "hash-c",
          observedAt: "2026-09-02T00:01:00.000Z",
          scrapeRunId: "00000000-0000-4000-8000-000000000002",
          startedAt: "2026-09-02T00:00:00.000Z",
        }),
        current: {
          ...current,
          observedAt: "2026-09-02T00:02:00.000Z",
          phase: "lifecycle",
        },
        legacyPending: false,
      })
    ).toBe("process");
  });

  it("does not let an older observation rewind a newer observation in the same run", () => {
    expect(
      classifyRecoveryCandidate({
        candidate: pointer({
          contentHash: "hash-a",
          observedAt: "2026-09-02T00:01:00.000Z",
          scrapeRunId: "00000000-0000-4000-8000-000000000002",
          startedAt: "2026-09-02T00:00:00.000Z",
        }),
        current: {
          ...current,
          observedAt: "2026-09-02T00:02:00.000Z",
        },
        legacyPending: false,
      })
    ).toBe("superseded");
  });

  it("uses source time rather than a later lifecycle validity floor", () => {
    expect(
      classifyRecoveryCandidate({
        candidate: pointer({
          contentHash: "hash-c",
          observedAt: "2026-09-02T00:01:30.000Z",
          scrapeRunId: "00000000-0000-4000-8000-000000000002",
          startedAt: "2026-09-02T00:00:00.000Z",
        }),
        current: {
          ...current,
          observedAt: "2026-09-02T00:01:00.000Z",
        },
        legacyPending: false,
      })
    ).toBe("process");
  });

  it("marks an exact legacy pointer as already committed without raw readback", () => {
    expect(
      classifyRecoveryCandidate({
        candidate: current,
        current,
        legacyPending: true,
      })
    ).toBe("already_committed");
  });

  it("does not treat an exact lifecycle version as a committed legacy observation", () => {
    expect(
      classifyRecoveryCandidate({
        candidate: current,
        current: { ...current, phase: "lifecycle" },
        legacyPending: true,
      })
    ).toBe("process");
  });

  it("blocks recovery when the durable version phase is ambiguous", () => {
    expect(
      classifyRecoveryCandidate({
        candidate: current,
        current: { ...current, phase: "ambiguous" },
        legacyPending: false,
      })
    ).toBe("blocked_ordering");
  });

  it("reprocesses an exact forward-path tuple while its marker is recoverable", () => {
    expect(
      classifyRecoveryCandidate({
        candidate: current,
        current,
        legacyPending: false,
      })
    ).toBe("process");
  });

  it("marks legacy same-content work unchanged without lifecycle rewrite", () => {
    expect(
      classifyRecoveryCandidate({
        candidate: pointer({
          contentHash: "hash-b",
          scrapeRunId: "00000000-0000-4000-8000-000000000001",
          startedAt: "2026-09-01T00:00:00.000Z",
        }),
        current,
        legacyPending: true,
      })
    ).toBe("unchanged");
  });

  it("supersedes an older A observation when B is already current", () => {
    expect(
      classifyRecoveryCandidate({
        candidate: pointer({
          contentHash: "hash-a",
          scrapeRunId: "00000000-0000-4000-8000-000000000001",
          startedAt: "2026-09-01T00:00:00.000Z",
        }),
        current,
        legacyPending: true,
      })
    ).toBe("superseded");
  });

  it("processes a later A after B so A to B to A is not collapsed", () => {
    expect(
      classifyRecoveryCandidate({
        candidate: pointer({
          contentHash: "hash-a",
          scrapeRunId: "00000000-0000-4000-8000-000000000003",
          startedAt: "2026-09-03T00:00:00.000Z",
        }),
        current,
        legacyPending: true,
      })
    ).toBe("process");
  });

  it("processes the oldest observation when no curated identity exists", () => {
    expect(
      classifyRecoveryCandidate({
        candidate: pointer({
          contentHash: "hash-a",
          scrapeRunId: "00000000-0000-4000-8000-000000000001",
          startedAt: "2026-09-01T00:00:00.000Z",
        }),
        current: null,
        legacyPending: true,
      })
    ).toBe("process");
  });
});

/** Shaped like a postgres.js error: the SQLSTATE rides on `code`. */
const postgresError = (code: string, message = `SQLSTATE ${code}`): Error =>
  Object.assign(new Error(message), { code });

describe("isTransientPostgresError (CTP-499)", () => {
  it.each([
    ["08006", "connection failure"],
    ["08003", "connection does not exist"],
    ["40001", "serialization failure"],
    ["40P01", "deadlock detected"],
    ["53200", "out of memory"],
    ["57P01", "admin shutdown"],
    ["57P02", "crash shutdown"],
    ["57P03", "cannot connect now"],
    ["CONNECTION_CLOSED", "postgres.js client-side drop"],
    ["CONNECT_TIMEOUT", "postgres.js connect timeout"],
    ["ECONNRESET", "socket reset"],
  ])("treats %s (%s) as transient", (code) => {
    expect(isTransientPostgresError({ error: postgresError(code) })).toBe(true);
  });

  it("does not treat 54000 as transient: that is the CTP-499 oversized key", () => {
    const error = postgresError(
      "54000",
      "index row size 3368 exceeds btree version 4 maximum 2704"
    );

    expect(isTransientPostgresError({ error })).toBe(false);
  });

  it.each([
    ["22001", "string data right truncation"],
    ["23505", "unique violation"],
    ["23502", "not null violation"],
    ["42P01", "undefined table"],
  ])("parks %s (%s) as a property of the row", (code) => {
    expect(isTransientPostgresError({ error: postgresError(code) })).toBe(
      false
    );
  });

  it("finds the code on a wrapped Drizzle error rather than the outermost one", () => {
    // The production shape: the outermost error carries no code at all.
    const error = new Error("Failed query: insert into dedup_groep", {
      cause: postgresError("40P01", "deadlock detected"),
    });

    expect(Object.hasOwn(error, "code")).toBe(false);
    expect(isTransientPostgresError({ error })).toBe(true);
  });

  it("finds the code three links down", () => {
    const error = new Error("outer", {
      cause: new Error("middle", { cause: postgresError("57P01") }),
    });

    expect(isTransientPostgresError({ error })).toBe(true);
  });

  it("stops at the chain depth cap rather than walking forever", () => {
    // Five links deep, so the transient code sits past MAX_CAUSE_DEPTH.
    const error = new Error("l1", {
      cause: new Error("l2", {
        cause: new Error("l3", {
          cause: new Error("l4", { cause: postgresError("40001") }),
        }),
      }),
    });

    expect(isTransientPostgresError({ error })).toBe(false);
  });

  it("does not loop on a self-referencing cause", () => {
    const error = new Error("outer");
    error.cause = error;

    expect(isTransientPostgresError({ error })).toBe(false);
  });

  it.each([
    ["a plain error with no code", new Error("boom")],
    ["a non-Error throw", "plain string"],
    ["null", null],
    ["undefined", undefined],
  ])("parks %s", (_label, error) => {
    expect(isTransientPostgresError({ error })).toBe(false);
  });

  it("ignores a non-string code", () => {
    const error = Object.assign(new Error("boom"), { code: 40 });

    expect(isTransientPostgresError({ error })).toBe(false);
  });
});
