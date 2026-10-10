import { describe, expect, it } from "bun:test";

import {
  InMemoryObservationRecorder,
  InMemoryObjectStore,
  InMemoryRunLifecycleStore,
} from "@ji/connectors";

import type { BronPersistence, BronRegisterRecord } from "../bronnen/register";
import { replayBron } from "./replay";
import type { ReplayDeps } from "./replay";

const tendernedRecord = (): BronRegisterRecord => ({
  actief: false,
  bronId: "bron-replay-tenderned",
  categorie: "overheidsportaal",
  crawlDelayMs: 0,
  interval: "*/15 * * * *",
  lastRun: null,
  loginVereist: false,
  mappingRef: null,
  method: "json-api",
  naam: "TenderNed",
  rateLimitPerMinute: 6000,
  retentionDays: 90,
  secretRef: null,
  status: "ready",
  voorwaardenStatus: "toegestaan",
});

const persistenceFor = (record: BronRegisterRecord): BronPersistence => ({
  activate: () => Promise.reject(new Error("activation is not used")),
  create: (created) => Promise.resolve(created),
  findById: () => Promise.resolve(record),
  list: () => Promise.resolve([record]),
});

const buildDeps = (record: BronRegisterRecord) => {
  const observationRecorder = new InMemoryObservationRecorder();
  return {
    deps: {
      objectStore: new InMemoryObjectStore(),
      observationRecorder,
      persistence: persistenceFor(record),
      runLifecycleStore: new InMemoryRunLifecycleStore(),
    },
    observationRecorder,
  };
};

describe("replayBron", () => {
  it("replays the same fixture twice without duplicating canonical rows", async () => {
    const record = tendernedRecord();
    const { deps, observationRecorder } = buildDeps(record);
    const source = {
      kind: "fixture",
      path: "tenderned/listing-page-0.json",
    } as const;

    const first = await replayBron({ bronId: record.bronId, deps, source });
    expect(first.observed).toBe(1);
    expect(first.created).toBe(1);
    expect(first.updated).toBe(0);
    expect(first.unchanged).toBe(0);
    expect(first.rejected).toBe(0);
    expect(first.dryRun).toBe(false);

    const second = await replayBron({ bronId: record.bronId, deps, source });
    expect(second.observed).toBe(1);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(second.rejected).toBe(0);

    expect(observationRecorder.records).toHaveLength(1);
    expect(first.runId).not.toBe(second.runId);
  });

  it("rejects an unknown bronId before touching a connector", async () => {
    const { deps } = buildDeps(tendernedRecord());
    const missingBronDeps: ReplayDeps = {
      ...deps,
      persistence: {
        activate: () => Promise.reject(new Error("not used")),
        create: (created) => Promise.resolve(created),
        findById: () => Promise.resolve(null),
        list: () => Promise.resolve([]),
      },
    };

    await expect(
      replayBron({
        bronId: "missing-bron",
        deps: missingBronDeps,
        source: { kind: "fixture", path: "tenderned/listing-page-0.json" },
      })
    ).rejects.toThrow("bron not found");
  });

  it("reports object-store replay as not implemented rather than guessing", async () => {
    const { deps } = buildDeps(tendernedRecord());

    await expect(
      replayBron({
        bronId: "bron-replay-tenderned",
        deps,
        source: { kind: "object-store", runId: "run-1" },
      })
    ).rejects.toThrow(/not implemented/u);
  });
});
