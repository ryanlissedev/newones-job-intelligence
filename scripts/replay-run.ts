import path from "node:path";

import type {
  BronPersistence,
  BronRegisterRecord,
} from "@ji/application/bronnen";
import { replayBron } from "@ji/application/replay";
import {
  isSupportedBronSlug,
  SOURCES,
  SUPPORTED_BRON_SLUGS,
} from "@ji/application/sources";
import type { SourceDefinition } from "@ji/application/sources";
import {
  FilesystemObjectStore,
  InMemoryObjectStore,
  InMemoryObservationRecorder,
  InMemoryRunLifecycleStore,
} from "@ji/connectors";
import type {
  ObjectStore,
  ObservationRecorder,
  RunLifecycleStore,
} from "@ji/connectors";

type KnownBron = Pick<SourceDefinition, "bronId" | "naam">;

const resolveKnownBron = (bronSlug: string): KnownBron | undefined =>
  isSupportedBronSlug(bronSlug) ? SOURCES[bronSlug] : undefined;

const usage = (): never => {
  console.error(
    `Usage: bun run replay:run -- --bron <${SUPPORTED_BRON_SLUGS.join("|")}> (--fixture <path> | --run <runId>) [--dry-run] [--json] [--repeat <n>]`
  );
  process.exit(1);
};

interface ReplayArgs {
  bronSlug: string;
  fixturePath?: string;
  runId?: string;
  dryRun: boolean;
  json: boolean;
  repeat: number;
}

/** Parses `--repeat <n>` into a positive integer, or returns undefined for an
 * invalid value (not a positive integer) so the caller can reject it. */
export const parseRepeatCount = (
  value: string | undefined
): number | undefined => {
  if (value === undefined) {
    return 1;
  }
  if (!/^[1-9]\d*$/u.test(value)) {
    return;
  }
  return Number(value);
};

export const parseArgs = (args: string[]): ReplayArgs => {
  let bronSlug: string | undefined;
  let fixturePath: string | undefined;
  let runId: string | undefined;
  let dryRun = false;
  let json = false;
  let repeatArg: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--bron") {
      bronSlug = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--fixture") {
      fixturePath = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--run") {
      runId = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--repeat") {
      repeatArg = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    return usage();
  }

  if (!bronSlug || !resolveKnownBron(bronSlug)) {
    return usage();
  }
  const sourceCount = [fixturePath, runId].filter(Boolean).length;
  if (sourceCount !== 1) {
    return usage();
  }
  const repeat = parseRepeatCount(repeatArg);
  if (repeat === undefined) {
    return usage();
  }

  return { bronSlug, dryRun, fixturePath, json, repeat, runId };
};

const FIXTURE_PREFIX = "fixtures/connectors/";
const normalizeFixturePath = (value: string): string =>
  value.startsWith(FIXTURE_PREFIX) ? value.slice(FIXTURE_PREFIX.length) : value;

const buildSyntheticRecord = (bron: KnownBron): BronRegisterRecord => ({
  actief: false,
  bronId: bron.bronId,
  categorie: "overheidsportaal",
  crawlDelayMs: 0,
  interval: "*/15 * * * *",
  lastRun: null,
  loginVereist: false,
  mappingRef: null,
  method: "json-api",
  naam: bron.naam,
  rateLimitPerMinute: 6000,
  retentionDays: 90,
  secretRef: null,
  status: "ready",
  voorwaardenStatus: "toegestaan",
});

const buildInMemoryPersistence = (
  record: BronRegisterRecord
): BronPersistence => ({
  activate: () => Promise.reject(new Error("replay does not activate bronnen")),
  create: (created) => Promise.resolve(created),
  findById: () => Promise.resolve(record),
  list: () => Promise.resolve([record]),
});

interface ReplayRuntime {
  persistence: BronPersistence;
  objectStore: ObjectStore;
  observationRecorder: ObservationRecorder;
  runLifecycleStore: RunLifecycleStore;
  close: () => Promise<void>;
}

const buildRuntime = async (
  bron: KnownBron,
  dryRun: boolean
): Promise<ReplayRuntime> => {
  const databaseUrl = dryRun ? undefined : process.env.DATABASE_URL?.trim();
  if (databaseUrl) {
    const { createBronRuntimeClient } = await import("@ji/db");
    const client = createBronRuntimeClient(databaseUrl);
    const rawRoot =
      process.env.RAW_OBJECT_STORE_PATH?.trim() ||
      path.join(process.cwd(), ".data", "raw-objects");
    return {
      close: client.close,
      objectStore: new FilesystemObjectStore(rawRoot),
      observationRecorder: client.observationRecorder,
      persistence: client.bronPersistence,
      runLifecycleStore: client.runLifecycleStore,
    };
  }
  return {
    close: () => Promise.resolve(),
    objectStore: new InMemoryObjectStore(),
    observationRecorder: new InMemoryObservationRecorder(),
    persistence: buildInMemoryPersistence(buildSyntheticRecord(bron)),
    runLifecycleStore: new InMemoryRunLifecycleStore(),
  };
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const bron = resolveKnownBron(args.bronSlug);
  if (!bron) {
    return usage();
  }

  // All --repeat passes share one runtime (persistence/objectStore/
  // observationRecorder/runLifecycleStore), closed once at the end, so a
  // second pass sees the first pass's state -- that's what proves replaying
  // the same input again does not duplicate canonical rows.
  const runtime = await buildRuntime(bron, args.dryRun);
  try {
    // SAFETY: parseArgs requires exactly one of --fixture / --run, so
    // fixturePath is defined whenever runId is not.
    const source = args.runId
      ? ({ kind: "object-store", runId: args.runId } as const)
      : ({
          kind: "fixture",
          path: normalizeFixturePath(args.fixturePath as string),
        } as const);

    const summaries = [];
    for (let pass = 0; pass < args.repeat; pass += 1) {
      // oxlint-disable-next-line no-await-in-loop -- passes must run sequentially against the shared runtime
      const summary = await replayBron({
        bronId: bron.bronId,
        deps: {
          objectStore: runtime.objectStore,
          observationRecorder: runtime.observationRecorder,
          persistence: runtime.persistence,
          runLifecycleStore: runtime.runLifecycleStore,
        },
        dryRun: args.dryRun,
        source,
      });
      summaries.push(summary);
      if (!args.json) {
        console.log(
          `replayed ${args.bronSlug} (pass ${pass + 1}/${args.repeat}): observed=${summary.observed} created=${summary.created} updated=${summary.updated} unchanged=${summary.unchanged} rejected=${summary.rejected}`
        );
      }
    }

    if (args.json) {
      console.log(JSON.stringify(summaries, null, 2));
    }

    // A duplication signal: any pass after the first that still creates
    // canonical rows means replaying the same input is not idempotent.
    const duplicated = summaries
      .slice(1)
      .some((summary) => summary.created > 0);
    if (duplicated) {
      console.error(
        "replay: a pass after the first reported created > 0 -- replay is not idempotent for this input"
      );
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await runtime.close();
  }
};

if (import.meta.main) {
  await main();
}
