import type {
  MarkSeenInput,
  MissedPollsStore,
} from "@ji/application/lifecycle";
import type {
  AanvraagRecord,
  AanvraagStore,
  AlertRecord,
  AlertStore,
  BronHealthRecord,
  BronHealthStore,
  QuerySnapshotRecord,
  QuerySnapshotStore,
  RawPayloadRecord,
  RawPayloadStore,
  SavedSearchRecord,
  SavedSearchStore,
  ScrapeRunReader,
  ScrapeRunView,
} from "@ji/application/registry";
import type { KnownHashStore } from "@ji/connectors";
import type { BronId } from "@ji/domain";
import type { SearchVersionCheckpoint, SearchVersionStore } from "@ji/search";
import type { Effect } from "effect";

import type { DbStoreFault } from "./effect";
import { fromStorePromise, runDbStorePromise } from "./effect";
import { isEffectDbEnabled } from "./effect/flag";

/**
 * Opt-in wrapper options for wrap*StoreEffect factories (CTP-473 Slice 8).
 * Native stores remain the default construction path; wrapping is per call site.
 */
export interface WrapStoreEffectOptions {
  signal?: AbortSignal;
}

export const wrapQuerySnapshotStoreEffect = (
  store: QuerySnapshotStore,
  options: WrapStoreEffectOptions = {}
): QuerySnapshotStore => ({
  create: (record) =>
    runDbStorePromise(
      fromStorePromise(() => store.create(record)),
      options
    ),
  getById: (id, scopeId) =>
    runDbStorePromise(
      fromStorePromise(() => store.getById(id, scopeId)),
      options
    ),
  list: (input) =>
    runDbStorePromise(
      fromStorePromise(() => store.list(input)),
      options
    ),
});

export const wrapAanvraagStoreEffect = (
  store: AanvraagStore,
  options: WrapStoreEffectOptions = {}
): AanvraagStore => ({
  getById: (id) =>
    runDbStorePromise(
      fromStorePromise(() => store.getById(id)),
      options
    ),
  getByIds: (ids) =>
    runDbStorePromise(
      fromStorePromise(() => store.getByIds(ids)),
      options
    ),
  listVersies: (aanvraagId) =>
    runDbStorePromise(
      fromStorePromise(() => store.listVersies(aanvraagId)),
      options
    ),
});

export const wrapRawPayloadStoreEffect = (
  store: RawPayloadStore,
  options: WrapStoreEffectOptions = {}
): RawPayloadStore => ({
  getByRef: (ref) =>
    runDbStorePromise(
      fromStorePromise(() => store.getByRef(ref)),
      options
    ),
});

export const wrapScrapeRunReaderEffect = (
  reader: ScrapeRunReader,
  options: WrapStoreEffectOptions = {}
): ScrapeRunReader => ({
  getById: (id) =>
    runDbStorePromise(
      fromStorePromise(() => reader.getById(id)),
      options
    ),
  list: (query) =>
    runDbStorePromise(
      fromStorePromise(() => reader.list(query)),
      options
    ),
});

export const wrapBronHealthStoreEffect = (
  store: BronHealthStore,
  options: WrapStoreEffectOptions = {}
): BronHealthStore => {
  const wrapped: BronHealthStore = {
    getByBronId: (bronId) =>
      runDbStorePromise(
        fromStorePromise(() => store.getByBronId(bronId)),
        options
      ),
    list: () =>
      runDbStorePromise(
        fromStorePromise(() => store.list()),
        options
      ),
    upsert: (record) =>
      runDbStorePromise(
        fromStorePromise(() => store.upsert(record)),
        options
      ),
  };
  if (store.upsertForRun) {
    wrapped.upsertForRun = (input) =>
      runDbStorePromise(
        fromStorePromise(
          () => store.upsertForRun?.(input) ?? Promise.resolve(null)
        ),
        options
      );
  }
  return wrapped;
};

export const wrapAlertStoreEffect = (
  store: AlertStore,
  options: WrapStoreEffectOptions = {}
): AlertStore => ({
  ack: (alertId, actorId) =>
    runDbStorePromise(
      fromStorePromise(() => store.ack(alertId, actorId)),
      options
    ),
  create: (record) =>
    runDbStorePromise(
      fromStorePromise(() => store.create(record)),
      options
    ),
  findOpenByDedupeKey: (dedupeKey) =>
    runDbStorePromise(
      fromStorePromise(() => store.findOpenByDedupeKey(dedupeKey)),
      options
    ),
  getById: (alertId) =>
    runDbStorePromise(
      fromStorePromise(() => store.getById(alertId)),
      options
    ),
  listOpen: () =>
    runDbStorePromise(
      fromStorePromise(() => store.listOpen()),
      options
    ),
});

export const wrapSavedSearchStoreEffect = (
  store: SavedSearchStore,
  options: WrapStoreEffectOptions = {}
): SavedSearchStore => ({
  createWithAudit: (record, actorType) =>
    runDbStorePromise(
      fromStorePromise(() => store.createWithAudit(record, actorType)),
      options
    ),
  getById: (id, userId, scopeId) =>
    runDbStorePromise(
      fromStorePromise(() => store.getById(id, userId, scopeId)),
      options
    ),
  list: (userId, scopeId) =>
    runDbStorePromise(
      fromStorePromise(() => store.list(userId, scopeId)),
      options
    ),
  removeWithAudit: (id, userId, scopeId, actorType) =>
    runDbStorePromise(
      fromStorePromise(() =>
        store.removeWithAudit(id, userId, scopeId, actorType)
      ),
      options
    ),
  updateWithAudit: (id, userId, scopeId, patch, actorType) =>
    runDbStorePromise(
      fromStorePromise(() =>
        store.updateWithAudit(id, userId, scopeId, patch, actorType)
      ),
      options
    ),
});

export const wrapMissedPollsStoreEffect = (
  store: MissedPollsStore,
  options: WrapStoreEffectOptions = {}
): MissedPollsStore => ({
  incrementMissed: (input) =>
    runDbStorePromise(
      fromStorePromise(() => store.incrementMissed(input)),
      options
    ),
  markSeen: (input) =>
    runDbStorePromise(
      fromStorePromise(() => store.markSeen(input)),
      options
    ),
});

export const wrapKnownHashStoreEffect = (
  store: KnownHashStore,
  options: WrapStoreEffectOptions = {}
): KnownHashStore => ({
  get: (bronId, bronReferentie) =>
    runDbStorePromise(
      fromStorePromise(() => store.get(bronId, bronReferentie)),
      options
    ),
});

export const wrapSearchVersionStoreEffect = (
  store: SearchVersionStore,
  options: WrapStoreEffectOptions = {}
): SearchVersionStore => ({
  advance: (appliedSequence) =>
    runDbStorePromise(
      fromStorePromise(() => store.advance(appliedSequence)),
      options
    ),
  read: () =>
    runDbStorePromise(
      fromStorePromise(() => store.read()),
      options
    ),
  startNewGeneration: (schemaHash) =>
    runDbStorePromise(
      fromStorePromise(() => store.startNewGeneration(schemaHash)),
      options
    ),
});

// Thin Effect-returning helpers for representative methods per store — for
// callers already composing Effect programs (Slice 8 opt-in surface).

export const querySnapshotGetByIdEffect = (
  store: QuerySnapshotStore,
  id: string,
  scopeId: string
): Effect.Effect<QuerySnapshotRecord | null, DbStoreFault> =>
  fromStorePromise(() => store.getById(id, scopeId));

export const aanvraagGetByIdEffect = (
  store: AanvraagStore,
  id: string
): Effect.Effect<AanvraagRecord | null, DbStoreFault> =>
  fromStorePromise(() => store.getById(id));

export const rawPayloadGetByRefEffect = (
  store: RawPayloadStore,
  ref: string
): Effect.Effect<RawPayloadRecord | null, DbStoreFault> =>
  fromStorePromise(() => store.getByRef(ref));

export const scrapeRunGetByIdEffect = (
  reader: ScrapeRunReader,
  id: string
): Effect.Effect<ScrapeRunView | null, DbStoreFault> =>
  fromStorePromise(() => reader.getById(id));

export const bronHealthGetByBronIdEffect = (
  store: BronHealthStore,
  bronId: string
): Effect.Effect<BronHealthRecord | null, DbStoreFault> =>
  fromStorePromise(() => store.getByBronId(bronId));

export const alertGetByIdEffect = (
  store: AlertStore,
  alertId: string
): Effect.Effect<AlertRecord | null, DbStoreFault> =>
  fromStorePromise(() => store.getById(alertId));

export const savedSearchGetByIdEffect = (
  store: SavedSearchStore,
  id: string,
  userId: string,
  scopeId: string
): Effect.Effect<SavedSearchRecord | null, DbStoreFault> =>
  fromStorePromise(() => store.getById(id, userId, scopeId));

export const missedPollsMarkSeenEffect = (
  store: MissedPollsStore,
  input: MarkSeenInput
): Effect.Effect<{ reappeared: string[]; reset: number }, DbStoreFault> =>
  fromStorePromise(() => store.markSeen(input));

export const knownHashGetEffect = (
  store: KnownHashStore,
  bronId: BronId,
  bronReferentie: string
): Effect.Effect<string | null | undefined, DbStoreFault> =>
  fromStorePromise(() => store.get(bronId, bronReferentie));

export const searchVersionReadEffect = (
  store: SearchVersionStore
): Effect.Effect<SearchVersionCheckpoint, DbStoreFault> =>
  fromStorePromise(() => store.read());

/**
 * Production canary hook (CTP-479): when JI_EFFECT_DB=1, wrap the Slice-8
 * store surfaces through Effect Promise boundaries. When OFF (default), returns
 * the input stores unchanged (native path / rollback).
 */
export interface DbEffectCanaryStores {
  aanvragen?: AanvraagStore;
  alerts?: AlertStore;
  bronHealth?: BronHealthStore;
  rawPayloads?: RawPayloadStore;
  savedSearches?: SavedSearchStore;
  scrapeRunReader?: ScrapeRunReader;
  snapshots?: QuerySnapshotStore;
}

export const applyDbStoreEffectCanary = (
  stores: DbEffectCanaryStores
): DbEffectCanaryStores => {
  if (!isEffectDbEnabled()) {
    return stores;
  }
  const next: DbEffectCanaryStores = { ...stores };
  if (stores.aanvragen !== undefined) {
    next.aanvragen = wrapAanvraagStoreEffect(stores.aanvragen);
  }
  if (stores.alerts !== undefined) {
    next.alerts = wrapAlertStoreEffect(stores.alerts);
  }
  if (stores.bronHealth !== undefined) {
    next.bronHealth = wrapBronHealthStoreEffect(stores.bronHealth);
  }
  if (stores.rawPayloads !== undefined) {
    next.rawPayloads = wrapRawPayloadStoreEffect(stores.rawPayloads);
  }
  if (stores.savedSearches !== undefined) {
    next.savedSearches = wrapSavedSearchStoreEffect(stores.savedSearches);
  }
  if (stores.scrapeRunReader !== undefined) {
    next.scrapeRunReader = wrapScrapeRunReaderEffect(stores.scrapeRunReader);
  }
  if (stores.snapshots !== undefined) {
    next.snapshots = wrapQuerySnapshotStoreEffect(stores.snapshots);
  }
  return next;
};
