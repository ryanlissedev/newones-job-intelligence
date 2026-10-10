import type {
  Connector,
  ObjectStore,
  ObservationRecorder,
  RunLifecycleStore,
} from "@ji/connectors";
import type { BronId, ScrapeRunId } from "@ji/domain";

import { executeBronRun } from "../bronnen/execute";
import type { ExecuteBronRunInput } from "../bronnen/execute";
import type { BronPersistence } from "../bronnen/register";
import { resolveSourceByNaam } from "../sources";

export type ReplaySource =
  | { kind: "fixture"; path: string }
  | { kind: "object-store"; runId: string };

export interface ReplaySummary {
  bronId: BronId;
  runId: ScrapeRunId;
  source: ReplaySource;
  dryRun: boolean;
  observed: number;
  created: number;
  updated: number;
  unchanged: number;
  rejected: number;
  durationMs: number;
}

/** The same store/port interfaces execute.ts already takes, plus the bron lookup it needs. */
export interface ReplayDeps {
  persistence: BronPersistence;
  objectStore: ObjectStore;
  observationRecorder: ObservationRecorder;
  runLifecycleStore: RunLifecycleStore;
  retryPolicy?: ExecuteBronRunInput["retryPolicy"];
  now?: ExecuteBronRunInput["now"];
  wait?: ExecuteBronRunInput["wait"];
  writeNow?: ExecuteBronRunInput["writeNow"];
  startedAt?: ExecuteBronRunInput["startedAt"];
}

export interface ReplayBronInput {
  bronId: BronId;
  source: ReplaySource;
  dryRun?: boolean;
  deps: ReplayDeps;
}

/** `record.naam` is the only source-identifying field on a bron; both seeded
 * Slice A bronnen ("TenderNed", "Inhuurdesk") lowercase directly to their slug. */
const bronSlugFromNaam = (naam: string): string => naam.trim().toLowerCase();

const buildFixtureConnector = (
  bronId: BronId,
  naam: string,
  fixturePath: string
): Connector => {
  const source = resolveSourceByNaam(naam);
  if (!source) {
    throw new Error(
      `No fixture-backed connector is registered for bron "${bronSlugFromNaam(naam)}"`
    );
  }
  return source.createConnector({
    bronId,
    listingFixturePath: fixturePath,
    live: false,
    runKind: "test",
  });
};

const buildConnector = (
  bronId: BronId,
  naam: string,
  source: ReplaySource
): Connector => {
  if (source.kind === "fixture") {
    return buildFixtureConnector(bronId, naam, source.path);
  }
  // ponytail: object-store replay needs a read port over stored observations
  // by scrapeRunId (rawPayloadRef + contentHash), which no port in
  // @ji/connectors exposes today -- ObservationRecorder is write-only from
  // this layer. Add that port, not a direct DB query from here, if this
  // becomes required. See docs/runbooks/replay-and-backfill.md.
  throw new Error(
    "Replay from a recorded run (object-store) is not implemented: no read port exists over stored observations by scrapeRunId."
  );
};

/** Re-runs a chosen bron from a recorded input through the same ingest path
 * `executeBronRun` uses for live polling. Replaying identical input twice
 * must not duplicate canonical rows -- the observation recorder's own
 * new/changed/unchanged classification is what proves that, not a second diff. */
export const replayBron = async (
  input: ReplayBronInput
): Promise<ReplaySummary> => {
  const { bronId, source, deps } = input;
  const dryRun = input.dryRun ?? false;

  const record = await deps.persistence.findById(bronId);
  if (!record) {
    throw new Error(`bron not found: ${bronId}`);
  }
  const bronSlug =
    resolveSourceByNaam(record.naam)?.slug ?? bronSlugFromNaam(record.naam);
  const connector = buildConnector(bronId, record.naam, source);
  const runId: ScrapeRunId = crypto.randomUUID();
  const startedMs = Date.now();

  const result = await executeBronRun(deps.persistence, {
    bronId,
    bronSlug,
    connector,
    now: deps.now,
    objectStore: deps.objectStore,
    observationRecorder: deps.observationRecorder,
    retryPolicy: deps.retryPolicy,
    runKind: "test",
    runLifecycleStore: deps.runLifecycleStore,
    scrapeRunId: runId,
    startedAt: deps.startedAt,
    wait: deps.wait,
    writeNow: deps.writeNow,
  });

  const { metrics } = result;
  const unchanged = Math.max(
    0,
    metrics.found - metrics.new - metrics.changed - metrics.rejected
  );

  return {
    bronId,
    created: metrics.new,
    dryRun,
    durationMs: Date.now() - startedMs,
    observed: metrics.found,
    rejected: metrics.rejected,
    runId,
    source,
    unchanged,
    updated: metrics.changed,
  };
};
