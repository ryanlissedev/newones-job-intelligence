import {
  enqueueEnrichmentOutbox,
  planCuratedEnrichmentPatch,
  runEnrichment,
} from "@ji/application/enrichment";
import type { IncompleteAanvraagCandidate } from "@ji/db";
import { PostgresEnrichmentStore } from "@ji/db";
import { schemaTask } from "@trigger.dev/sdk";

import type { PollBronRuntime } from "../poll-bron-run";
import { createPollBronRuntime, requireDatabaseUrl } from "../poll-bron-run";
import {
  createEnrichmentQueue,
  drainEnrichmentQueue,
  ENRICHMENT_JOB_MAX_ATTEMPTS,
  offerEnrichmentJob,
} from "../poller/enrichment-jobs";
import type { EnrichmentJob } from "../poller/enrichment-jobs";
import {
  enrichIncompleteDefaults,
  enrichIncompletePayload,
} from "./enrich-incomplete-schema";
import type { EnrichIncompletePayload } from "./enrich-incomplete-schema";

const decodeRawBody = (body: Uint8Array): string =>
  new TextDecoder("utf-8").decode(body);

export interface EnrichIncompleteResult {
  readonly applyStoredProposals: boolean;
  readonly curatedPersisted: number;
  readonly dryRun: boolean;
  /** CTP-626: candidates went through the durable aanvraag-enrichment queue. */
  readonly durable: boolean;
  readonly enriched: number;
  /** Durable path: re-read found no fillable gap left (manual CLEARED or filled meanwhile). */
  readonly nothingToFill: number;
  readonly outboxEnqueued: number;
  readonly processed: number;
  readonly proposals: number;
  readonly skipped: number;
  /** Durable path: the row changed since the candidate was selected. */
  readonly stale: number;
}

const emptyResult = (flags: {
  readonly applyStoredProposals: boolean;
  readonly dryRun: boolean;
  readonly durable: boolean;
}): EnrichIncompleteResult => ({
  applyStoredProposals: flags.applyStoredProposals,
  curatedPersisted: 0,
  dryRun: flags.dryRun,
  durable: flags.durable,
  enriched: 0,
  nothingToFill: 0,
  outboxEnqueued: 0,
  processed: 0,
  proposals: 0,
  skipped: 0,
  stale: 0,
});

/** Reads the raw body and runs the extractors for one candidate. Shared by the inline and durable paths. */
const proposeForCandidate = async (
  runtime: PollBronRuntime,
  candidate: IncompleteAanvraagCandidate,
  enableLlmResidual: boolean
) => {
  const storedRaw = await runtime.objectStore.get(candidate.rawPayloadRef);
  const rawHtml = storedRaw === null ? null : decodeRawBody(storedRaw.body);
  return await runEnrichment({
    aanvraagId: candidate.id,
    beschrijving: candidate.beschrijving,
    bronSpecifiek: candidate.bronSpecifiek,
    contracttype: candidate.contracttype,
    eindDatum: candidate.eindDatum,
    enableLlmResidual,
    locatieTekst: candidate.locatieTekst,
    opdrachtgeverNaam: candidate.opdrachtgeverNaam,
    publicatiedatum: candidate.publicatiedatum,
    rawHtml,
    sluitingsdatum: candidate.sluitingsdatum,
    startDatum: candidate.startDatum,
    tariefEenheid: candidate.tariefEenheid,
    tariefMax: candidate.tariefMax,
    tariefMin: candidate.tariefMin,
    titleFallbackParts: candidate.titleFallbackParts,
    urenPerWeek: candidate.urenPerWeek,
    werkvorm: candidate.werkvorm,
  });
};

/**
 * CTP-626 durable path. Every candidate becomes one queue job keyed on its
 * `updated_at`; the drain then enriches each job and commits proposals,
 * curated patch and outbox intent in one transaction through
 * `applyEnrichmentAtomically`. `stale` and `nothing_to_fill` are successful
 * job completions (the row moved on, or a clear won), counted as skipped.
 */
const runDurableEnrichment = async (
  runtime: PollBronRuntime,
  store: PostgresEnrichmentStore,
  options: {
    readonly batchSize: number;
    readonly databaseUrl: string;
    readonly enableLlmResidual: boolean;
  }
): Promise<EnrichIncompleteResult> => {
  const candidates = await store.listIncomplete(options.batchSize);
  const byId = new Map(
    candidates.map((candidate) => [candidate.id, candidate])
  );
  const totals = {
    curatedPersisted: 0,
    enriched: 0,
    nothingToFill: 0,
    outboxEnqueued: 0,
    proposals: 0,
    skipped: 0,
    stale: 0,
  };
  const lockExpirationSeconds = 120;
  const queue = await createEnrichmentQueue(options.databaseUrl, {
    lockExpiration: `${lockExpirationSeconds} seconds`,
  });
  try {
    for (const candidate of candidates) {
      // oxlint-disable-next-line no-await-in-loop -- offers are cheap single-row inserts; order keeps the log readable
      await offerEnrichmentJob(queue.queue, {
        aanvraagId: candidate.id,
        expectedUpdatedAt: candidate.updatedAtToken,
      });
    }
    const drained = await drainEnrichmentQueue({
      database: runtime.database,
      lockExpirationSeconds,
      maxAttempts: ENRICHMENT_JOB_MAX_ATTEMPTS,
      maxJobs: options.batchSize,
      processJob: async (job: EnrichmentJob) => {
        const candidate =
          byId.get(job.aanvraagId) ??
          (await store.listIncompleteById(job.aanvraagId));
        if (candidate === null) {
          // Left over from an earlier run and no longer incomplete: nothing to do.
          totals.nothingToFill += 1;
          totals.skipped += 1;
          return;
        }
        const result = await proposeForCandidate(
          runtime,
          candidate,
          options.enableLlmResidual
        );
        totals.proposals += result.proposals.length;
        if (result.proposals.length === 0) {
          totals.skipped += 1;
          return;
        }
        const applied = await store.applyEnrichmentAtomically({
          aanvraagId: job.aanvraagId,
          expectedUpdatedAt: job.expectedUpdatedAt,
          proposals: result.proposals,
        });
        if (applied.outcome === "applied") {
          totals.enriched += result.proposals.length;
          totals.curatedPersisted += applied.fields.length;
          totals.outboxEnqueued += 1;
          return;
        }
        totals.skipped += 1;
        if (applied.outcome === "stale") {
          totals.stale += 1;
        } else {
          totals.nothingToFill += 1;
        }
      },
      queue: queue.queue,
      signal: new AbortController().signal,
    });
    return {
      ...emptyResult({
        applyStoredProposals: false,
        dryRun: false,
        durable: true,
      }),
      ...totals,
      processed: drained.processed + drained.failed,
    };
  } finally {
    await queue.close();
  }
};

const runApplyStoredCurated = async (
  store: PostgresEnrichmentStore,
  options: {
    readonly applyStoredProposals: boolean;
    readonly batchSize: number;
    readonly dryRun: boolean;
  }
): Promise<EnrichIncompleteResult> => {
  const candidates = await store.listPendingCuratedApply(options.batchSize);
  // Sequential fold keeps curated applies rate-limited like live enrichment.
  // oxlint-disable-next-line unicorn/no-array-reduce -- intentional serial fold (see CTP-486)
  return candidates.reduce<Promise<EnrichIncompleteResult>>(
    async (accumulatorPromise, candidate) => {
      const accumulator = await accumulatorPromise;
      let curatedPersisted = 0;
      let outboxEnqueued = 0;
      if (!options.dryRun) {
        const persisted = await store.applyCuratedEnrichmentPatch(
          candidate.id,
          candidate.patch
        );
        curatedPersisted = persisted.length;
        const outbox = await enqueueEnrichmentOutbox(store, {
          aanvraagId: candidate.id,
          dryRun: options.dryRun,
          fields: candidate.patch.fields,
        });
        outboxEnqueued = outbox.enqueued ? 1 : 0;
      }
      return {
        ...accumulator,
        curatedPersisted: accumulator.curatedPersisted + curatedPersisted,
        enriched: accumulator.enriched + (options.dryRun ? 0 : 1),
        outboxEnqueued: accumulator.outboxEnqueued + outboxEnqueued,
        processed: accumulator.processed + 1,
        proposals: accumulator.proposals + candidate.patch.fields.length,
        skipped: accumulator.skipped,
      };
    },
    Promise.resolve(
      emptyResult({
        applyStoredProposals: options.applyStoredProposals,
        dryRun: options.dryRun,
        durable: false,
      })
    )
  );
};

export const runEnrichIncomplete = async (
  payload: EnrichIncompletePayload
): Promise<EnrichIncompleteResult> => {
  const dryRun = payload.dryRun ?? enrichIncompleteDefaults.dryRun;
  const batchSize = payload.batchSize ?? enrichIncompleteDefaults.batchSize;
  const enableLlmResidual =
    payload.enableLlmResidual ?? enrichIncompleteDefaults.enableLlmResidual;
  const applyStoredProposals =
    payload.applyStoredProposals ??
    enrichIncompleteDefaults.applyStoredProposals;
  const durable = payload.durable ?? process.env.ENRICHMENT_DURABLE === "1";

  const databaseUrl = requireDatabaseUrl();
  const runtime = createPollBronRuntime(databaseUrl);
  try {
    const store = new PostgresEnrichmentStore(runtime.database);
    if (applyStoredProposals) {
      return await runApplyStoredCurated(store, {
        applyStoredProposals,
        batchSize,
        dryRun,
      });
    }
    // The durable path writes; a dry run must not touch the queue at all.
    if (durable && !dryRun) {
      return await runDurableEnrichment(runtime, store, {
        batchSize,
        databaseUrl,
        enableLlmResidual,
      });
    }
    const candidates = await store.listIncomplete(batchSize);

    // Sequential reduce keeps enrichment rate-limited; parallel Promise.all would violate worker concurrency intent.
    // oxlint-disable-next-line unicorn/no-array-reduce -- intentional serial fold (see CTP-482)
    const summary = await candidates.reduce<Promise<EnrichIncompleteResult>>(
      async (accumulatorPromise, candidate) => {
        const accumulator = await accumulatorPromise;
        const result = await proposeForCandidate(
          runtime,
          candidate,
          enableLlmResidual
        );

        if (result.proposals.length === 0) {
          return {
            ...accumulator,
            processed: accumulator.processed + 1,
            skipped: accumulator.skipped + 1,
          };
        }

        let outboxEnqueued = 0;
        let curatedPersisted = 0;
        if (!dryRun) {
          // oxlint-disable-next-line unicorn/no-array-reduce -- persist proposals serially for the same candidate
          await result.proposals.reduce<Promise<void>>(
            (chain, proposal) =>
              chain.then(async () => {
                await store.upsertProposal(candidate.id, proposal);
              }),
            Promise.resolve()
          );
          const curatedPatch = planCuratedEnrichmentPatch(
            {
              beschrijving: candidate.beschrijving,
              bronSpecifiek: candidate.bronSpecifiek,
              contracttype: candidate.contracttype,
              eindDatum: candidate.eindDatum,
              locatieTekst: candidate.locatieTekst,
              opdrachtgeverNaam: candidate.opdrachtgeverNaam,
              publicatiedatum: candidate.publicatiedatum,
              sluitingsdatum: candidate.sluitingsdatum,
              startDatum: candidate.startDatum,
              tariefEenheid: candidate.tariefEenheid,
              tariefMax: candidate.tariefMax,
              tariefMin: candidate.tariefMin,
              tariefValuta: candidate.tariefValuta,
              titleFallbackParts: candidate.titleFallbackParts,
              urenPerWeek: candidate.urenPerWeek,
              werkvorm: candidate.werkvorm,
            },
            result.proposals
          );
          if (curatedPatch !== null) {
            const persisted = await store.applyCuratedEnrichmentPatch(
              candidate.id,
              curatedPatch
            );
            curatedPersisted = persisted.length;
          }
          const outboxFields =
            curatedPatch?.fields ??
            result.proposals.map((proposal) => proposal.field);
          const outbox = await enqueueEnrichmentOutbox(store, {
            aanvraagId: candidate.id,
            dryRun,
            fields: outboxFields,
          });
          outboxEnqueued = outbox.enqueued ? 1 : 0;
        }

        return {
          ...accumulator,
          curatedPersisted: accumulator.curatedPersisted + curatedPersisted,
          enriched:
            accumulator.enriched + (dryRun ? 0 : result.proposals.length),
          outboxEnqueued: accumulator.outboxEnqueued + outboxEnqueued,
          processed: accumulator.processed + 1,
          proposals: accumulator.proposals + result.proposals.length,
        };
      },
      Promise.resolve(
        emptyResult({ applyStoredProposals, dryRun, durable: false })
      )
    );

    return summary;
  } finally {
    await runtime.close();
  }
};

/** Dequeues incomplete curated aanvragen and applies deterministic enrichment. */
export const enrichIncompleteTask = schemaTask({
  id: "enrich-incomplete",
  queue: {
    concurrencyLimit: 1,
  },
  retry: {
    maxAttempts: 2,
  },
  run: (payload) => runEnrichIncomplete(payload),
  schema: enrichIncompletePayload,
});

export type { EnrichIncompletePayload } from "./enrich-incomplete-schema";
