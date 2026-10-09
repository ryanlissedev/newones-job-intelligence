import { describe, expect, it } from "bun:test";

import {
  InMemoryObservationRecorder,
  InMemoryObjectStore,
  InMemoryRunLifecycleStore,
} from "@ji/connectors";
import type { Connector, ConnectorRunKind } from "@ji/connectors";
import type { AanvraagLifecycle, BronId, ScrapeRunId } from "@ji/domain";

import { executeBronRun } from "../bronnen/execute";
import type { BronPersistence } from "../bronnen/register";
import type { CurateStore, StoredAanvraag } from "../identity/curate";
import { InMemoryCurateStore } from "../identity/store";
import {
  AANVRAAG_STATUS_GEWIJZIGD_EVENT,
  createInMemoryLifecyclePorts,
  InMemoryMissedPollsStore,
  reconcileMissedPolls,
} from "./reconcile-missed-polls";
import type { LifecycleReconcilePorts } from "./reconcile-missed-polls";

const BRON: BronId = "bron-hero";
// ScrapeRunId is a branded string; specs mint readable ids.
const runId = (name: string): ScrapeRunId =>
  // SAFETY: ScrapeRunId is a nominal string brand; any string is a valid value here.
  name as ScrapeRunId;
const THRESHOLD = 3;
const OBSERVED_AT = new Date("2026-09-01T06:00:00.000Z");

const storedAanvraag = (
  bronReferentie: string,
  status: AanvraagLifecycle = "active"
): Omit<StoredAanvraag, "aanvraagId"> => ({
  beschrijving: `beschrijving ${bronReferentie}`,
  bronId: BRON,
  bronReferentie,
  bronSpecifiek: {},
  bronUrl: null,
  contactpersonen: [],
  contentHash: `hash-${bronReferentie}`,
  contracttype: null,
  dedupGroepId: null,
  eersteGezienOp: OBSERVED_AT,
  eindDatum: null,
  extractieMethode: "html_parser",
  laatstGezienOp: OBSERVED_AT,
  locatieLand: "NL",
  locatieTekst: null,
  opdrachtgeverNaam: null,
  parserVersion: "test",
  provenance: {
    beschrijving: { parserVersion: "test", sourcePath: "n/a" },
    bron_referentie: { parserVersion: "test", sourcePath: "n/a" },
    bron_specifiek: { parserVersion: "test", sourcePath: "n/a" },
    bron_url: { parserVersion: "test", sourcePath: "n/a" },
    locatie_land: { parserVersion: "test", sourcePath: "n/a" },
    locatie_tekst: { parserVersion: "test", sourcePath: "n/a" },
    opdrachtgever_naam: { parserVersion: "test", sourcePath: "n/a" },
    start_datum: { parserVersion: "test", sourcePath: "n/a" },
    tarief_eenheid: { parserVersion: "test", sourcePath: "n/a" },
    tarief_max: { parserVersion: "test", sourcePath: "n/a" },
    tarief_min: { parserVersion: "test", sourcePath: "n/a" },
    titel: { parserVersion: "test", sourcePath: "n/a" },
  },
  publicatiedatum: null,
  rawPayloadRef: `raw/hero/${bronReferentie}.html`,
  scrapeRunId: "run-0",
  sluitingsdatum: null,
  startDatum: null,
  status,
  tariefEenheid: null,
  tariefMax: null,
  tariefMin: null,
  tariefValuta: "EUR",
  titel: `titel ${bronReferentie}`,
  urenPerWeek: null,
  versie: 1,
  werkvorm: null,
});

interface World {
  curateStore: InMemoryCurateStore;
  missedPolls: InMemoryMissedPollsStore;
  ports: LifecycleReconcilePorts;
}

const world = async (
  records: { ref: string; status?: AanvraagLifecycle }[]
): Promise<World> => {
  const curateStore = new InMemoryCurateStore();
  const missedPolls = new InMemoryMissedPollsStore();
  for (const record of records) {
    // oxlint-disable-next-line no-await-in-loop -- fixture setup
    const created = await curateStore.insertAanvraag(
      storedAanvraag(record.ref, record.status)
    );
    // oxlint-disable-next-line no-await-in-loop -- fixture setup
    await curateStore.insertVersie({
      aanvraagId: created.aanvraagId,
      contentHash: created.contentHash,
      geldigTot: null,
      geldigVan: OBSERVED_AT,
      rawPayloadRef: created.rawPayloadRef,
      scrapeRunId: created.scrapeRunId,
      snapshot: {
        beschrijving: created.beschrijving,
        bron_referentie: created.bronReferentie,
        bron_specifiek: {},
        status: created.status,
        tarief_eenheid: "UNKNOWN",
        tarief_max: "UNKNOWN",
        tarief_min: "UNKNOWN",
        titel: created.titel,
      },
      versie: 1,
    });
    missedPolls.ensure(BRON, record.ref);
  }
  return {
    curateStore,
    missedPolls,
    ports: createInMemoryLifecyclePorts(curateStore, missedPolls, {
      missedPollsBeforeStale: THRESHOLD,
    }),
  };
};

const withFailingLookup = (base: CurateStore): CurateStore => ({
  closeOpenVersie: (aanvraagId, closedAt) =>
    base.closeOpenVersie(aanvraagId, closedAt),
  ensureDedupGroep: (input) => base.ensureDedupGroep(input),
  findAanvraagByIdentity: () =>
    Promise.reject(new Error("forced failure after counter reset")),
  findDedupGroepByKey: (dedupKey) => base.findDedupGroepByKey(dedupKey),
  insertAanvraag: (input) => base.insertAanvraag(input),
  insertOutboxEvent: (input) => base.insertOutboxEvent(input),
  insertVersie: (input) => base.insertVersie(input),
  linkAanvraagToDedupGroep: (aanvraagId, dedupGroepId) =>
    base.linkAanvraagToDedupGroep(aanvraagId, dedupGroepId),
  splitDedupGroep: (dedupGroepId) => base.splitDedupGroep(dedupGroepId),
  updateAanvraag: (aanvraagId, patch) => base.updateAanvraag(aanvraagId, patch),
  withTransaction: (fn) =>
    base.withTransaction((transactionStore) =>
      fn(withFailingLookup(transactionStore))
    ),
});

const listingRun = (
  ports: LifecycleReconcilePorts,
  runNumber: number,
  observed: string[],
  complete = true
) =>
  reconcileMissedPolls(ports, {
    bronId: BRON,
    completeness: complete
      ? { complete: true }
      : { complete: false, reason: "truncated" },
    observedAt: new Date(OBSERVED_AT.getTime() + runNumber * 3_600_000),
    observedBronReferenties: observed,
    scrapeRunId: runId(`run-${runNumber}`),
  });

const statusOf = (
  curateStore: InMemoryCurateStore,
  ref: string
): Promise<StoredAanvraag | null> =>
  curateStore.findAanvraagByIdentity(BRON, ref);

const requireAanvraag = async (
  curateStore: InMemoryCurateStore,
  ref: string
): Promise<StoredAanvraag> => {
  const row = await statusOf(curateStore, ref);
  if (!row) {
    throw new Error(`aanvraag ${ref} missing`);
  }
  return row;
};

describe("reconcileMissedPolls", () => {
  it("counts one miss when a record disappears from the next complete listing", async () => {
    const { missedPolls, ports, curateStore } = await world([
      { ref: "A" },
      { ref: "B" },
    ]);
    await listingRun(ports, 1, ["A", "B"]);
    const second = await listingRun(ports, 2, ["A"]);

    expect(second).toMatchObject({
      incremented: 1,
      reopened: [],
      reset: 1,
      skippedIncrementReason: null,
      staled: [],
    });
    expect(missedPolls.read(BRON, "B")?.missedPolls).toBe(1);
    expect(missedPolls.read(BRON, "A")).toMatchObject({
      lastSeenScrapeRunId: "run-2",
      missedPolls: 0,
    });
    const b = await statusOf(curateStore, "B");
    expect(b?.status).toBe("active");
    expect(curateStore.outboxEvents).toHaveLength(0);
  });

  it("goes stale after the threshold with an SCD2 version and an outbox event carrying the reason", async () => {
    const { ports, curateStore, missedPolls } = await world([
      { ref: "A" },
      { ref: "B" },
    ]);
    await listingRun(ports, 1, ["A"]);
    await listingRun(ports, 2, ["A"]);
    expect(curateStore.outboxEvents).toHaveLength(0);
    const third = await listingRun(ports, 3, ["A"]);

    const b = await requireAanvraag(curateStore, "B");
    expect(third.staled).toEqual([b.aanvraagId]);
    expect(b).toMatchObject({ status: "stale", versie: 2 });
    expect(missedPolls.read(BRON, "B")?.missedPolls).toBe(THRESHOLD);

    const versies = curateStore.versies.filter(
      (row) => row.aanvraagId === b.aanvraagId
    );
    expect(versies).toHaveLength(2);
    expect(versies[0]?.geldigTot).toEqual(new Date("2026-09-01T09:00:00.000Z"));
    expect(versies[1]).toMatchObject({
      contentHash: "hash-B",
      geldigTot: null,
      scrapeRunId: "run-3",
      snapshot: { status: "stale" },
      versie: 2,
    });
    expect(curateStore.outboxEvents).toEqual([
      {
        aggregateId: b.aanvraagId,
        aggregateType: "aanvraag",
        eventType: AANVRAAG_STATUS_GEWIJZIGD_EVENT,
        id: expect.any(String),
        payload: {
          missed_polls: THRESHOLD,
          reden: "listing_verdwenen",
          scrape_run_id: "run-3",
          status: "stale",
        },
      },
    ]);
  });

  it("saturates at threshold + 1 once stale and does not write a second transition", async () => {
    const { ports, curateStore, missedPolls } = await world([{ ref: "B" }]);
    for (let run = 1; run <= 5; run += 1) {
      // oxlint-disable-next-line no-await-in-loop -- sequential runs
      await listingRun(ports, run, []);
    }
    expect(missedPolls.read(BRON, "B")?.missedPolls).toBe(THRESHOLD + 1);
    expect(curateStore.outboxEvents).toHaveLength(1);
    expect(curateStore.versies).toHaveLength(2);
  });

  it("increments once when reconcile runs twice for the same scrapeRunId", async () => {
    const { ports, missedPolls } = await world([{ ref: "A" }, { ref: "B" }]);
    await listingRun(ports, 1, ["A"]);
    const replay = await listingRun(ports, 1, ["A"]);
    expect(replay).toMatchObject({ incremented: 0, reset: 1 });
    expect(missedPolls.read(BRON, "B")?.missedPolls).toBe(1);
  });

  it("retries the stale transition once when a previous run bumped the counter but never wrote it", async () => {
    const { ports, curateStore, missedPolls } = await world([{ ref: "B" }]);
    // Simulate a crash between incrementMissed and writeStatusTransition.
    const row = missedPolls.read(BRON, "B");
    if (!row) {
      throw new Error("fixture row missing");
    }
    row.missedPolls = THRESHOLD;

    const next = await listingRun(ports, 1, []);
    const b = await requireAanvraag(curateStore, "B");
    expect(next.staled).toEqual([b.aanvraagId]);
    expect(b.status).toBe("stale");
    expect(missedPolls.read(BRON, "B")?.missedPolls).toBe(THRESHOLD + 1);
  });

  it("reopens a stale record that reappears and resets its counter", async () => {
    const { ports, curateStore, missedPolls } = await world([{ ref: "B" }]);
    await listingRun(ports, 1, []);
    await listingRun(ports, 2, []);
    await listingRun(ports, 3, []);
    const back = await listingRun(ports, 4, ["B"]);

    const b = await requireAanvraag(curateStore, "B");
    expect(back).toMatchObject({ reopened: [b.aanvraagId], staled: [] });
    expect(b).toMatchObject({ status: "active", versie: 3 });
    expect(missedPolls.read(BRON, "B")).toMatchObject({
      lastSeenScrapeRunId: "run-4",
      missedPolls: 0,
    });
    expect(curateStore.outboxEvents.at(-1)?.payload).toEqual({
      missed_polls: 0,
      reden: "listing_teruggekeerd",
      scrape_run_id: "run-4",
      status: "active",
    });
  });

  it("rolls back the reset when reopening fails and recovers on the next unchanged listing", async () => {
    const { ports, curateStore, missedPolls } = await world([{ ref: "B" }]);
    await listingRun(ports, 1, []);
    await listingRun(ports, 2, []);
    await listingRun(ports, 3, []);
    const beforeFailure = await requireAanvraag(curateStore, "B");
    const versionsBeforeFailure = curateStore.versies.length;
    const eventsBeforeFailure = curateStore.outboxEvents.length;

    let injectFailure = true;
    const failingPorts: LifecycleReconcilePorts = {
      ...ports,
      withTransaction: (bronId, fn) =>
        ports.withTransaction(bronId, (transactionPorts) =>
          fn({
            ...transactionPorts,
            curateStore: injectFailure
              ? withFailingLookup(transactionPorts.curateStore)
              : transactionPorts.curateStore,
          })
        ),
    };
    await expect(listingRun(failingPorts, 4, ["B"])).rejects.toThrow(
      "forced failure after counter reset"
    );

    expect(await requireAanvraag(curateStore, "B")).toMatchObject({
      status: "stale",
      versie: beforeFailure.versie,
    });
    expect(missedPolls.read(BRON, "B")).toMatchObject({
      lastSeenScrapeRunId: null,
      missedPolls: THRESHOLD,
    });
    expect(curateStore.versies).toHaveLength(versionsBeforeFailure);
    expect(curateStore.outboxEvents).toHaveLength(eventsBeforeFailure);

    injectFailure = false;
    const recovered = await listingRun(failingPorts, 5, ["B"]);
    const reopened = await requireAanvraag(curateStore, "B");
    expect(recovered.reopened).toEqual([reopened.aanvraagId]);
    expect(reopened).toMatchObject({ status: "active", versie: 3 });
    expect(missedPolls.read(BRON, "B")).toMatchObject({
      lastSeenScrapeRunId: "run-5",
      missedPolls: 0,
    });

    const replay = await listingRun(failingPorts, 5, ["B"]);
    expect(replay.reopened).toEqual([]);
    expect(await requireAanvraag(curateStore, "B")).toMatchObject({
      status: "active",
      versie: 3,
    });
    expect(curateStore.outboxEvents).toHaveLength(eventsBeforeFailure + 1);
  });

  it("does not count misses on an incomplete run but still resets observed records", async () => {
    const { ports, curateStore, missedPolls } = await world([
      { ref: "A" },
      { ref: "B" },
    ]);
    await listingRun(ports, 1, []);
    expect(missedPolls.read(BRON, "A")?.missedPolls).toBe(1);

    const partial = await listingRun(ports, 2, ["A"], false);
    expect(partial).toEqual({
      incremented: 0,
      reopened: [],
      reset: 1,
      skippedIncrementReason: "truncated",
      staled: [],
    });
    expect(missedPolls.read(BRON, "A")?.missedPolls).toBe(0);
    expect(missedPolls.read(BRON, "B")?.missedPolls).toBe(1);
    expect(curateStore.outboxEvents).toHaveLength(0);
  });

  it("leaves a date-closed record closed whether it disappears or reappears", async () => {
    const { ports, curateStore, missedPolls } = await world([
      { ref: "C", status: "closed" },
    ]);
    for (let run = 1; run <= 3; run += 1) {
      // oxlint-disable-next-line no-await-in-loop -- sequential runs
      await listingRun(ports, run, []);
    }
    expect(missedPolls.read(BRON, "C")?.missedPolls).toBe(THRESHOLD);
    const gone = await statusOf(curateStore, "C");
    expect(gone?.status).toBe("closed");

    const back = await listingRun(ports, 4, ["C"]);
    expect(back.reopened).toEqual([]);
    const seenAgain = await statusOf(curateStore, "C");
    expect(seenAgain?.status).toBe("closed");
    expect(curateStore.outboxEvents).toHaveLength(0);
    expect(curateStore.versies).toHaveLength(1);
  });

  it("first-time records observed this run start at zero and are never missed", async () => {
    const { ports, missedPolls } = await world([]);
    const first = await listingRun(ports, 1, ["N"]);
    expect(first).toMatchObject({ incremented: 0, reset: 1 });
    expect(missedPolls.read(BRON, "N")?.missedPolls).toBe(0);
  });
});

const persistenceFor = (): BronPersistence => {
  const record = {
    actief: true,
    bronId: BRON,
    categorie: "msp_broker",
    crawlDelayMs: 0,
    interval: "*/15 * * * *",
    lastRun: null,
    loginVereist: false,
    mappingRef: null,
    method: "html" as const,
    naam: "Hero",
    rateLimitPerMinute: 600,
    retentionDays: 30,
    secretRef: null,
    status: "ready" as const,
    voorwaardenStatus: "toegestaan" as const,
  };
  return {
    activate: () => Promise.reject(new Error("activation is not used")),
    create: (created) => Promise.resolve(created),
    findById: () => Promise.resolve(record),
    list: () => Promise.resolve([record]),
  };
};

const hexDigest = (seed: string): string =>
  [...seed]
    .map((character) => character.codePointAt(0)?.toString(16) ?? "0")
    .join("")
    .padEnd(64, "0")
    .slice(0, 64);

const listingConnector = (refs: string[]): Connector => ({
  bronId: BRON,
  discover: () =>
    Promise.resolve({
      checkpoint: {},
      hasMore: false,
      items: refs.map((ref) => ({ bronReferentie: ref, contentHash: "" })),
    }),
  fetch: (item) =>
    Promise.resolve({
      body: new TextEncoder().encode(item.bronReferentie),
      bronReferentie: item.bronReferentie,
      contentHash: hexDigest(item.bronReferentie),
      contentType: "html" as const,
      status: "fetched" as const,
    }),
});

describe("executeBronRun with lifecycle ports", () => {
  const runFixture = (
    ports: LifecycleReconcilePorts,
    refs: string[],
    runNumber: number,
    runKind: ConnectorRunKind = "poll"
  ) =>
    executeBronRun(persistenceFor(), {
      bronId: BRON,
      bronSlug: "hero",
      connector: listingConnector(refs),
      lifecycle: ports,
      objectStore: new InMemoryObjectStore(),
      observationRecorder: new InMemoryObservationRecorder(),
      runKind,
      runLifecycleStore: new InMemoryRunLifecycleStore(),
      scrapeRunId: runId(`fixture-run-${runNumber}`),
      startedAt: OBSERVED_AT,
      wait: () => Promise.resolve(),
      writeNow: () => OBSERVED_AT,
    });

  it("closes a record that disappears across consecutive fixture runs and reports it on the run result", async () => {
    const { ports, curateStore, missedPolls } = await world([
      { ref: "A" },
      { ref: "B" },
    ]);
    const first = await runFixture(ports, ["A", "B"], 1);
    expect(first.completeness).toEqual({ complete: true });
    expect(first.lifecycle).toMatchObject({ incremented: 0, reset: 2 });

    const second = await runFixture(ports, ["A"], 2);
    expect(second.lifecycle).toMatchObject({ incremented: 1, staled: [] });
    expect(missedPolls.read(BRON, "B")?.missedPolls).toBe(1);

    await runFixture(ports, ["A"], 3);
    const fourth = await runFixture(ports, ["A"], 4);
    const b = await requireAanvraag(curateStore, "B");
    expect(fourth.lifecycle?.staled).toEqual([b.aanvraagId]);
    expect(b.status).toBe("stale");
    expect(curateStore.outboxEvents.at(-1)?.payload).toMatchObject({
      reden: "listing_verdwenen",
      status: "stale",
    });
  });

  it("treats a zero-item listing as incomplete and counts nothing", async () => {
    const { ports, missedPolls, curateStore } = await world([
      { ref: "A" },
      { ref: "B" },
    ]);
    const result = await runFixture(ports, [], 1);
    expect(result.completeness).toEqual({ complete: true });
    expect(result.lifecycle).toEqual({
      incremented: 0,
      reopened: [],
      reset: 0,
      skippedIncrementReason: "empty",
      staled: [],
    });
    expect(missedPolls.read(BRON, "A")?.missedPolls).toBe(0);
    expect(missedPolls.read(BRON, "B")?.missedPolls).toBe(0);
    expect(curateStore.outboxEvents).toHaveLength(0);
  });

  /**
   * Scrape-architecture PR7: closure keys on discovery, not on fetch. The
   * budget "elapses" after `persisted` detail pages were recorded, between
   * items, as it does while a real run waits out its crawl delay.
   */
  const budgetCutRun = (
    ports: LifecycleReconcilePorts,
    pages: string[][],
    runNumber: number,
    persisted: number
  ) => {
    const controller = new AbortController();
    const recorder = new InMemoryObservationRecorder();
    const record = recorder.record.bind(recorder);
    let count = 0;
    recorder.record = async (input) => {
      const result = await record(input);
      count += 1;
      if (count >= persisted) {
        controller.abort();
      }
      return result;
    };
    const connector: Connector = {
      ...listingConnector([]),
      discover: (checkpoint) => {
        const page = Number(
          // SAFETY: this fake connector only ever returns `{ page: number }` checkpoints.
          (checkpoint as { page?: number } | null)?.page ?? 0
        );
        return Promise.resolve({
          checkpoint: { page: page + 1 },
          hasMore: page + 1 < pages.length,
          items: (pages[page] ?? []).map((ref) => ({
            bronReferentie: ref,
            contentHash: "",
          })),
        });
      },
    };
    return executeBronRun(persistenceFor(), {
      bronId: BRON,
      bronSlug: "hero",
      connector,
      lifecycle: ports,
      objectStore: new InMemoryObjectStore(),
      observationRecorder: recorder,
      runLifecycleStore: new InMemoryRunLifecycleStore(),
      scrapeRunId: runId(`budget-cut-run-${runNumber}`),
      signal: controller.signal,
      startedAt: OBSERVED_AT,
      wait: () => Promise.resolve(),
      writeNow: () => OBSERVED_AT,
    });
  };

  it("counts a miss when the budget cuts the fetch of a fully discovered listing (RJC-397 / PR7)", async () => {
    const { ports, missedPolls } = await world([
      { ref: "A" },
      { ref: "B" },
      { ref: "GONE" },
    ]);
    // The listing shows A and B; GONE disappeared. Only A is fetched.
    const result = await budgetCutRun(ports, [["A", "B"]], 1, 1);
    expect(result.completeness).toEqual({ complete: false, reason: "aborted" });
    expect(result.discoveryCompleteness).toEqual({ complete: true });
    expect(result.lifecycle).toMatchObject({
      incremented: 1,
      reset: 2,
      skippedIncrementReason: null,
    });
    expect(missedPolls.read(BRON, "GONE")?.missedPolls).toBe(1);
    // B was listed but never fetched: still seen, never counted as missed.
    expect(missedPolls.read(BRON, "B")?.missedPolls).toBe(0);
  });

  it("stales a vanished record across budget-cut runs exactly as across complete runs", async () => {
    const { ports, curateStore } = await world([{ ref: "A" }, { ref: "GONE" }]);
    let last: Awaited<ReturnType<typeof budgetCutRun>> | undefined;
    for (let runNumber = 1; runNumber <= THRESHOLD; runNumber += 1) {
      // oxlint-disable-next-line no-await-in-loop -- consecutive polls
      last = await budgetCutRun(ports, [["A", "B", "C"]], runNumber, 1);
    }
    const gone = await requireAanvraag(curateStore, "GONE");
    expect(last?.lifecycle?.staled).toEqual([gone.aanvraagId]);
    expect(gone.status).toBe("stale");
    const kept = await requireAanvraag(curateStore, "A");
    expect(kept.status).toBe("active");
  });

  it("never counts misses when the cut lands before the last page was discovered", async () => {
    const { ports, missedPolls } = await world([
      { ref: "A" },
      { ref: "ON-PAGE-2" },
    ]);
    const result = await budgetCutRun(ports, [["A", "B"], ["ON-PAGE-2"]], 1, 1);
    expect(result.discoveryCompleteness).toEqual({
      complete: false,
      reason: "aborted",
    });
    expect(result.lifecycle).toMatchObject({
      incremented: 0,
      skippedIncrementReason: "aborted",
    });
    expect(missedPolls.read(BRON, "ON-PAGE-2")?.missedPolls).toBe(0);
  });

  it("never counts misses on a test-import run", async () => {
    const { ports, missedPolls } = await world([{ ref: "A" }, { ref: "B" }]);
    const result = await runFixture(ports, ["A"], 1, "test");
    expect(result.lifecycle).toBeNull();
    expect(missedPolls.read(BRON, "B")?.missedPolls).toBe(0);
  });
});
