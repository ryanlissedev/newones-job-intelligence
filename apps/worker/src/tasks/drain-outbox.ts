import {
  drainPostgresOutbox,
  PostgresSearchDocumentLoader,
  PostgresSearchVersionStore,
} from "@ji/db";
import { ManticoreSearchEngine } from "@ji/search";
import { schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";

import { isEffectWorkerEnabled } from "../effect/flag";
import { readSearchProjectorMode } from "../poll-bron-env";
import {
  createPollBronRuntime,
  requireDatabaseUrl,
  requireManticoreUrl,
} from "../poll-bron-run";

const drainOutboxPayload = z.object({
  /** Rows claimed per drain (RJC-389); `limit` is the legacy name. */
  batchSize: z.number().int().positive().max(5000).optional(),
  leaseSeconds: z.number().int().positive().max(3600).optional(),
  limit: z.number().int().positive().max(5000).optional(),
  maxAttempts: z.number().int().positive().max(100).optional(),
});

type DrainOutboxPayload = z.infer<typeof drainOutboxPayload>;

export const ONBOX_DRAIN_DEFERRAL_REASON =
  "SEARCH_PROJECTOR=onbox delegates outbox draining to the on-box projector; the Trigger.dev drain-outbox task did not drain";

/**
 * Exported for a guard-level test that proves onbox mode returns before any
 * database or Manticore requirement is evaluated.
 */
export const runDrainOutbox = async (payload: DrainOutboxPayload) => {
  if (readSearchProjectorMode() === "onbox") {
    return {
      deferred: true as const,
      reason: ONBOX_DRAIN_DEFERRAL_REASON,
      searchProjector: "onbox" as const,
    };
  }

  const runtime = createPollBronRuntime(requireDatabaseUrl());
  try {
    const versionStore = new PostgresSearchVersionStore(runtime.database);
    const engine = ManticoreSearchEngine.fromUrl(
      requireManticoreUrl(),
      versionStore
    );
    const result = await drainPostgresOutbox({
      batchSize: payload.batchSize ?? payload.limit,
      database: runtime.database,
      engine,
      leaseSeconds: payload.leaseSeconds,
      loader: new PostgresSearchDocumentLoader(runtime.database),
      maxAttempts: payload.maxAttempts,
      versionStore,
    });
    // Task output must be JSON-serializable: drop the bigint-bearing
    // version object and return the scalar mirror.
    return {
      claimed: result.claimed,
      deadLettered: result.deadLettered,
      deferred: false as const,
      drained: result.drained,
      failed: result.failed,
      indexVersion: result.indexVersion,
      lag: result.lag,
      lostLease: result.lostLease,
      processedIds: result.processedIds,
      released: result.released,
      searchProjector: "worker" as const,
      superseded: result.superseded,
      unchanged: result.unchanged,
    };
  } finally {
    await runtime.close();
  }
};

/** Drains unprocessed curated outbox rows into Manticore (search projector). */
export const drainOutboxTask = schemaTask({
  id: "drain-outbox",
  queue: {
    concurrencyLimit: 1,
  },
  retry: {
    maxAttempts: 2,
  },
  // CTP-479 canary: JI_EFFECT_WORKER=1 → Effect task-body boundary; default native.
  // Dynamic import avoids a static cycle with effect/task-bodies → this module.
  run: async (payload) => {
    if (!isEffectWorkerEnabled()) {
      return runDrainOutbox(payload);
    }
    const { runDrainOutboxEffect } = await import("../effect/task-bodies");
    return runDrainOutboxEffect(payload);
  },
  schema: drainOutboxPayload,
});
