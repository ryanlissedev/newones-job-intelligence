import { afterEach, describe, expect, it } from "bun:test";

import { InMemoryObjectStore } from "@ji/connectors";
import type { ObjectStore } from "@ji/connectors";
import { UNKNOWN } from "@ji/domain";

import { curateObservation } from "../identity/curate";
import { InMemoryCurateStore } from "../identity/store";
import type { JsonValue } from "../normalise";
import { MOTIAN_V1_BRON_BINDINGS } from "./motian-v1-bindings";
import {
  NEON_V1_BACKFILL_CONTRACT_VERSION,
  NEON_V1_FORBIDDEN_TABLES,
  InMemoryBackfillProvenanceStore,
  InMemoryBackfillRunStore,
  RAW_WRITE_RETRY_DELAYS_MS,
  UnreachableNeonV1Source,
  backfillFailureEvidenceSchema,
  createFixtureNeonV1Source,
  getBackfillFailureDiagnostic,
  loadNeonV1Fixture,
  mapV1JobToDraft,
  runNeonV1Backfill,
  setRawWriteRetrySleepForTests,
} from "./neon-v1";
import type { BackfillProvenanceStore, NeonV1JobRow } from "./neon-v1";

const sampleJob = () => ({
  company: "Broker BV",
  contract_type: "detachering",
  description: "Azure platform engineer for a Dutch ministry.",
  external_id: "ext-000001",
  external_url: "https://example.com/jobs/ext-000001",
  id: "00000000-0000-4000-8000-000000000001",
  location: "Utrecht",
  platform: "nationalevacaturebank",
  rate_max: 120,
  rate_min: 90,
  title: "Platform engineer Azure",
});

const bindings = MOTIAN_V1_BRON_BINDINGS.filter((binding) =>
  ["nationalevacaturebank", "werkzoeken"].includes(binding.platform)
);

const reconciliationMetrics = (input: {
  readonly matched: number;
  readonly missing?: number;
  readonly selected: number;
}) => ({
  duplicates: 0,
  extra: 0,
  matched: input.matched,
  missing: input.missing ?? 0,
  selected: input.selected,
});

const fixedSnapshotProvenanceStore = (): InMemoryBackfillProvenanceStore => {
  const provenanceStore = new InMemoryBackfillProvenanceStore();
  const consumeSnapshot =
    provenanceStore.consumeReconciliationSnapshot.bind(provenanceStore);
  provenanceStore.consumeReconciliationSnapshot = async (
    bronIds,
    batchSize,
    consume
  ) => {
    await consumeSnapshot(bronIds, batchSize, consume);
    return {
      completedAt: "2026-09-03T10:05:00.000Z",
      startedAt: "2026-09-03T10:00:00.000Z",
    };
  };
  return provenanceStore;
};

const fixtureJob = (idSuffix: string, externalId: string): NeonV1JobRow => ({
  ...sampleJob(),
  external_id: externalId,
  id: `00000000-0000-4000-8000-${idSuffix.padStart(12, "0")}`,
});

describe("Neon v1 backfill mapping", () => {
  it("maps platform and external_id to canonical identity fields", () => {
    const draft = mapV1JobToDraft(sampleJob());
    expect(draft.bronReferentie.value).toBe("ext-000001");
    expect(draft.titel.value).toBe("Platform engineer Azure");
    expect(draft.bronSpecifiek.value).toMatchObject({
      platform: "nationalevacaturebank",
    });
  });

  it("maps Starapple Motian rows to their canonical bron URL", () => {
    const draft = mapV1JobToDraft({
      ...sampleJob(),
      external_id: "platform_engineer-rotterdam",
      external_url: "https://www.starapple.nl/jobs/platform_engineer-rotterdam",
      platform: "starapple",
    });

    expect(draft.bronUrl.value).toBe(
      "https://www.starapple.nl/vacatures/platform-engineer-rotterdam/"
    );
    expect(draft.bronUrl.provenance.sourcePath).toBe("motian_bron_url");
  });

  it("preserves exact source facts and distinguishes omitted values", () => {
    const facts = {
      ...sampleJob(),
      allows_subcontracting: false,
      application_deadline: null,
      company: "Broker BV",
      competences: [{ name: "TypeScript", years: 3 }],
      end_client: "Ministry",
      end_date: null,
      extension_possible: true,
      external_url: "https://example.com/jobs/ext-000001",
      hours_per_week: 0,
      min_hours_per_week: 0,
      positions_available: 0,
      posted_at: "2026-08-31T08:00:00.000Z",
      province: "Utrecht",
      requirements: { education: ["HBO"], security: null },
      start_date: null,
      wishes: ["Azure"],
      work_arrangement: "remote",
      work_experience_years: 0,
    };
    const draft = mapV1JobToDraft(facts);

    expect(draft.bronSpecifiek.value).toMatchObject({
      allows_subcontracting: false,
      application_deadline: null,
      company: "Broker BV",
      competences: [{ name: "TypeScript", years: 3 }],
      end_client: "Ministry",
      end_date: null,
      extension_possible: true,
      external_url: "https://example.com/jobs/ext-000001",
      hours_per_week: 0,
      min_hours_per_week: 0,
      positions_available: 0,
      posted_at: "2026-08-31T08:00:00.000Z",
      province: "Utrecht",
      requirements: { education: ["HBO"], security: null },
      start_date: null,
      wishes: ["Azure"],
      work_arrangement: "remote",
      work_experience_years: 0,
    });

    const { competences: _omitted, ...withoutCompetences } = facts;
    const omitted = mapV1JobToDraft(withoutCompetences).bronSpecifiek.value;
    expect(omitted).not.toHaveProperty("competences");
    expect(omitted).toMatchObject({ wishes: ["Azure"] });
  });

  it("uses only posted_at as first seen and keeps scraped_at separate", () => {
    const postedAt = "2026-08-31T08:00:00.000Z";
    const scrapedAt = "2026-09-03T09:00:00.000Z";
    const postedDraft = mapV1JobToDraft({
      ...sampleJob(),
      posted_at: postedAt,
      scraped_at: scrapedAt,
    });
    const missingPostedAtDraft = mapV1JobToDraft({
      ...sampleJob(),
      posted_at: null,
      scraped_at: scrapedAt,
    });

    expect(postedDraft.bronSpecifiek.value).toMatchObject({
      v1_first_seen_at: postedAt,
      v1_posted_at: postedAt,
      v1_scraped_at: scrapedAt,
    });
    expect(missingPostedAtDraft.bronSpecifiek.value).toMatchObject({
      v1_first_seen_at: null,
      v1_posted_at: null,
      v1_scraped_at: scrapedAt,
    });
  });

  it("maps source start and application deadline into existing curated fields", () => {
    const draft = mapV1JobToDraft({
      ...sampleJob(),
      application_deadline: "2026-09-10T12:00:00.000Z",
      start_date: "2026-10-01T00:00:00.000Z",
    });

    expect(draft.startDatum.value).toBe("2026-10-01");
    expect(draft.startDatum.provenance.sourcePath).toBe("start_date");
    expect(draft.sluitingsdatum?.toISOString()).toBe(
      "2026-09-10T12:00:00.000Z"
    );
  });

  it("preserves exact top-level source facts and weekly min/max semantics", () => {
    const draft = mapV1JobToDraft({
      ...sampleJob(),
      sourceRow: {
        durationMonths: 99,
        duration_months: 6,
        endDate: "2099-01-01T00:00:00.000Z",
        end_date: "2027-03-31T00:00:00.000Z",
        hoursPerWeek: 99,
        hours_per_week: 40,
        minHoursPerWeek: 99,
        min_hours_per_week: 32,
        raw_payload: {
          durationMonths: 99,
          endDate: "2099-01-01T00:00:00.000Z",
          hoursPerWeek: 99,
          minHoursPerWeek: 99,
          workArrangement: "remote",
        },
        workArrangement: "remote",
        work_arrangement: "hybride",
      },
    });

    expect(draft.bronSpecifiek.value).toMatchObject({
      duration_months: "6",
      eind_datum: "2027-03-31T00:00:00.000Z",
      min_uren_per_week: "32",
      uren_per_week: "32–40",
      werkvorm: "hybride",
    });
    expect(draft.tarief).toMatchObject({
      eenheid: UNKNOWN,
      max: "120",
      min: "90",
      valuta: "EUR",
    });
  });

  it("ignores malformed exact fields", () => {
    const draft = mapV1JobToDraft({
      ...sampleJob(),
      sourceRow: {
        duration_months: "6",
        end_date: 2027,
        hours_per_week: "40",
        min_hours_per_week: -32,
        work_arrangement: { value: "hybride" },
      },
    });

    expect(draft.bronSpecifiek.value).toMatchObject({
      duration_months: null,
      eind_datum: null,
      min_uren_per_week: null,
      uren_per_week: null,
      werkvorm: null,
    });
    expect(draft.tarief.eenheid).toBe(UNKNOWN);
  });

  it("keeps a native scalar weekly-hours value when the minimum is absent", () => {
    const draft = mapV1JobToDraft({
      ...sampleJob(),
      sourceRow: {
        hours_per_week: 36,
      },
    });

    expect(draft.bronSpecifiek.value).toMatchObject({
      duration_months: null,
      eind_datum: null,
      min_uren_per_week: null,
      uren_per_week: "36",
      werkvorm: null,
    });
  });

  it("formats a minimum-only weekly-hours value as a lower bound", () => {
    const draft = mapV1JobToDraft({
      ...sampleJob(),
      sourceRow: {
        min_hours_per_week: 32,
      },
    });

    expect(draft.bronSpecifiek.value).toMatchObject({
      min_uren_per_week: "32",
      uren_per_week: "≥32",
    });
  });

  it("leaves an inverted weekly-hours range unknown", () => {
    const draft = mapV1JobToDraft({
      ...sampleJob(),
      sourceRow: {
        hours_per_week: 24,
        min_hours_per_week: 32,
      },
    });

    expect(draft.bronSpecifiek.value).toMatchObject({
      min_uren_per_week: "32",
      uren_per_week: null,
    });
  });

  it("maps Motian hours from typed columns when sourceRow omits them", () => {
    const draft = mapV1JobToDraft({
      ...sampleJob(),
      hours_per_week: 24,
      min_hours_per_week: 24,
      sourceRow: {},
    });
    expect(draft.bronSpecifiek.value).toMatchObject({
      uren_per_week: "24",
    });
  });

  it("lifts allowlisted nested raw_payload rates for vast monthly salaris", () => {
    const draft = mapV1JobToDraft({
      ...sampleJob(),
      contract_type: "vast",
      rate_max: null,
      rate_min: null,
      sourceRow: {
        raw_payload: {
          rateMax: 6500,
          rateMin: 3150,
        },
      },
    });
    expect(draft.tarief).toMatchObject({
      eenheid: "maand",
      max: "6500",
      min: "3150",
      valuta: "EUR",
    });
  });

  it("projects Motian education_level into bron_specifiek opleidingsniveau", () => {
    const draft = mapV1JobToDraft({
      ...sampleJob(),
      education_level: "MBO",
      sourceRow: {},
    });
    expect(draft.bronSpecifiek.value).toMatchObject({
      opleidingsniveau: "MBO",
    });
  });

  it("does not invent werkvorm when Motian work_arrangement is absent", () => {
    const draft = mapV1JobToDraft({
      ...sampleJob(),
      sourceRow: {},
      work_arrangement: null,
    });
    // SAFETY: test reads allowlisted Motian bron_specifiek keys from a fixture draft.
    expect(
      (draft.bronSpecifiek.value as { werkvorm: string | null }).werkvorm
    ).toBeNull();
  });

  it("persists historical source facts through curation", async () => {
    const store = new InMemoryCurateStore();
    const draft = mapV1JobToDraft({
      ...sampleJob(),
      sourceRow: {
        end_date: "2027-03-31T00:00:00.000Z",
        hours_per_week: 40,
        min_hours_per_week: 32,
        work_arrangement: "hybride",
      },
    });

    const result = await curateObservation(store, {
      bronId: "00000000-0000-4000-8000-000000000030",
      draft,
      observedAt: new Date("2026-09-10T12:00:00.000Z"),
      rawPayloadRef: "raw/motian/test.json",
      scrapeRunId: "run-motian-test",
    });

    expect(result.status).toBe("curated");
    const [record] = store.aanvragen;
    if (!record) {
      throw new Error("Expected curated aanvraag record");
    }
    expect(record).toMatchObject({
      eindDatum: "2027-03-31T00:00:00.000Z",
      urenPerWeek: "32–40",
      werkvorm: "hybride",
    });
    expect(record.bronSpecifiek).toMatchObject({
      eind_datum: "2027-03-31T00:00:00.000Z",
      uren_per_week: "32–40",
      werkvorm: "hybride",
    });
  });

  it("retains a closed or deleted v1 row as closed in the curated lifecycle", () => {
    const draft = mapV1JobToDraft({
      ...sampleJob(),
      archived_at: "2026-08-29T12:00:00.000Z",
      status: "closed",
    });

    expect(draft.lifecycle).toBe("closed");
    expect(draft.status).toBe("closed");
    expect(draft.bronSpecifiek.value).toMatchObject({
      v1_archived_at: "2026-08-29T12:00:00.000Z",
      v1_status: "closed",
    });
  });

  it("never imports forbidden recruitment tables (JI-MIG-05)", () => {
    expect(NEON_V1_FORBIDDEN_TABLES).toContain("candidates");
    expect(NEON_V1_FORBIDDEN_TABLES).toContain("job_matches");
    expect(NEON_V1_FORBIDDEN_TABLES).not.toContain("jobs");
  });
});

describe("Neon v1 backfill run", () => {
  it("produces identical fixture evidence with concurrency 1 and 16", async () => {
    const fixture = await loadNeonV1Fixture("neon-v1-sample.json");
    const runFixture = (concurrency: number) =>
      runNeonV1Backfill({
        bindings: MOTIAN_V1_BRON_BINDINGS,
        concurrency,
        curateStore: new InMemoryCurateStore(),
        objectStore: new InMemoryObjectStore(),
        provenanceStore: fixedSnapshotProvenanceStore(),
        runStore: new InMemoryBackfillRunStore(),
        source: createFixtureNeonV1Source(fixture),
        startedAt: new Date(fixture.capturedAt),
      });

    const sequential = await runFixture(1);
    const concurrent = await runFixture(16);

    expect(sequential.status).toBe("succeeded");
    expect(concurrent.status).toBe("succeeded");
    expect(concurrent.evidence).toEqual(sequential.evidence);
    expect(concurrent.metrics.imported).toBe(200);
    expect(concurrent.evidence.scopeManifest?.orderedDigest).toBe(
      sequential.evidence.scopeManifest?.orderedDigest
    );
  });

  it("stops dispatch after the first row failure and drains in-flight rows", async () => {
    const jobs = [
      fixtureJob("1", "external-1"),
      fixtureJob("2", "external-2"),
      fixtureJob("3", "external-3"),
      fixtureJob("4", "external-4"),
    ];
    const [failingJob, inFlightJob] = jobs;
    if (!failingJob || !inFlightJob) {
      throw new Error("Expected failure test jobs");
    }
    const backingStore = fixedSnapshotProvenanceStore();
    const dispatched: string[] = [];
    const failingRead = Promise.withResolvers<null>();
    const inFlightRead = Promise.withResolvers<null>();
    const initialDispatchComplete = Promise.withResolvers<undefined>();
    const provenanceStore: BackfillProvenanceStore = {
      consumeReconciliationSnapshot: (bronIds, batchSize, consume) =>
        backingStore.consumeReconciliationSnapshot(bronIds, batchSize, consume),
      findByAanvraagId: (aanvraagId) =>
        backingStore.findByAanvraagId(aanvraagId),
      findByV1Id: (v1Id) => {
        dispatched.push(v1Id);
        if (dispatched.length === 2) {
          initialDispatchComplete.resolve();
        }
        if (v1Id === failingJob.id) {
          return failingRead.promise;
        }
        if (v1Id === inFlightJob.id) {
          return inFlightRead.promise;
        }
        return backingStore.findByV1Id(v1Id);
      },
      registerV1Id: (record) => backingStore.registerV1Id(record),
    };

    const resultPromise = runNeonV1Backfill({
      bindings,
      concurrency: 2,
      curateStore: new InMemoryCurateStore(),
      objectStore: new InMemoryObjectStore(),
      provenanceStore,
      runStore: new InMemoryBackfillRunStore(),
      source: createFixtureNeonV1Source({
        capturedAt: "2026-09-03T10:05:00.000Z",
        contractVersion: NEON_V1_BACKFILL_CONTRACT_VERSION,
        jobs,
      }),
    });
    await initialDispatchComplete.promise;
    failingRead.reject(new Error("synthetic provenance read failure"));
    await Bun.sleep(0);
    inFlightRead.resolve(null);
    const result = await resultPromise;

    expect(result.status).toBe("failed");
    expect(result.evidence.failure).toEqual({
      code: "PROVENANCE_READ_FAILED",
      phase: "provenance",
    });
    expect(dispatched).toEqual([failingJob.id, inFlightJob.id]);
    expect(result.metrics).toMatchObject({
      errors: 1,
      imported: 1,
      selected: 2,
    });
  });

  it("serializes duplicate platform and external_id keys within a batch", async () => {
    const first = fixtureJob("1", "shared-external-id");
    const duplicate = fixtureJob("2", "shared-external-id");
    const independent = fixtureJob("3", "independent-external-id");
    const backingStore = fixedSnapshotProvenanceStore();
    const events: string[] = [];
    const firstRead = Promise.withResolvers<null>();
    const independentDispatched = Promise.withResolvers<undefined>();
    const provenanceStore: BackfillProvenanceStore = {
      consumeReconciliationSnapshot: (bronIds, batchSize, consume) =>
        backingStore.consumeReconciliationSnapshot(bronIds, batchSize, consume),
      findByAanvraagId: (aanvraagId) =>
        backingStore.findByAanvraagId(aanvraagId),
      findByV1Id: (v1Id) => {
        events.push(`find:${v1Id}`);
        if (v1Id === first.id) {
          return firstRead.promise;
        }
        if (v1Id === independent.id) {
          independentDispatched.resolve();
        }
        return backingStore.findByV1Id(v1Id);
      },
      registerV1Id: async (record) => {
        const registered = await backingStore.registerV1Id(record);
        events.push(`registered:${record.v1Id}`);
        return registered;
      },
    };

    const resultPromise = runNeonV1Backfill({
      bindings,
      concurrency: 3,
      curateStore: new InMemoryCurateStore(),
      objectStore: new InMemoryObjectStore(),
      provenanceStore,
      runStore: new InMemoryBackfillRunStore(),
      source: createFixtureNeonV1Source({
        capturedAt: "2026-09-03T10:05:00.000Z",
        contractVersion: NEON_V1_BACKFILL_CONTRACT_VERSION,
        jobs: [first, duplicate, independent],
      }),
    });
    await independentDispatched.promise;

    expect(events).toContain(`find:${first.id}`);
    expect(events).not.toContain(`find:${duplicate.id}`);
    firstRead.resolve(null);
    const result = await resultPromise;

    expect(result.status).toBe("failed");
    expect(events.indexOf(`registered:${first.id}`)).toBeLessThan(
      events.indexOf(`find:${duplicate.id}`)
    );
    expect(result.evidence.failure).toEqual({
      code: "PROVENANCE_MISMATCH",
      phase: "provenance",
    });
  });

  it("serializes identical raw bodies and reuses one content-addressed write", async () => {
    const sharedSourceRow = { raw_payload: { vacancy: "same-object" } };
    const first = {
      ...fixtureJob("1", "external-1"),
      sourceRow: sharedSourceRow,
    };
    const duplicateBody = {
      ...fixtureJob("2", "external-2"),
      sourceRow: sharedSourceRow,
    };
    const backingStore = new InMemoryObjectStore();
    const firstPutStarted = Promise.withResolvers<undefined>();
    const releaseFirstPut = Promise.withResolvers<undefined>();
    let putCalls = 0;
    let successfulReadbacks = 0;
    const objectStore: ObjectStore = {
      deleteExpired: (before) => backingStore.deleteExpired(before),
      get: async (path) => {
        const stored = await backingStore.get(path);
        if (stored) {
          successfulReadbacks += 1;
        }
        return stored;
      },
      put: async (object) => {
        putCalls += 1;
        if (putCalls === 1) {
          firstPutStarted.resolve();
          await releaseFirstPut.promise;
        }
        await backingStore.put(object);
      },
    };

    const resultPromise = runNeonV1Backfill({
      bindings,
      concurrency: 2,
      curateStore: new InMemoryCurateStore(),
      objectStore,
      provenanceStore: new InMemoryBackfillProvenanceStore(),
      runStore: new InMemoryBackfillRunStore(),
      source: createFixtureNeonV1Source({
        capturedAt: "2026-09-03T10:05:00.000Z",
        contractVersion: NEON_V1_BACKFILL_CONTRACT_VERSION,
        jobs: [first, duplicateBody],
      }),
    });
    await firstPutStarted.promise;
    await Bun.sleep(0);

    expect(putCalls).toBe(1);
    releaseFirstPut.resolve();
    const result = await resultPromise;

    expect(result.status).toBe("succeeded");
    expect(putCalls).toBe(1);
    expect(successfulReadbacks).toBe(2);
  });

  afterEach(() => {
    setRawWriteRetrySleepForTests(undefined);
  });

  it("retries the R2 same-object rate error and succeeds", async () => {
    setRawWriteRetrySleepForTests(() => Promise.resolve());
    const backingStore = new InMemoryObjectStore();
    let putCalls = 0;
    const objectStore: ObjectStore = {
      deleteExpired: (before) => backingStore.deleteExpired(before),
      get: (path) => backingStore.get(path),
      put: async (object) => {
        putCalls += 1;
        if (putCalls === 1) {
          throw new Error(
            "Reduce your concurrent request rate for the same object."
          );
        }
        await backingStore.put(object);
      },
    };

    const result = await runNeonV1Backfill({
      bindings,
      curateStore: new InMemoryCurateStore(),
      objectStore,
      provenanceStore: new InMemoryBackfillProvenanceStore(),
      runStore: new InMemoryBackfillRunStore(),
      source: createFixtureNeonV1Source({
        capturedAt: "2026-09-03T10:05:00.000Z",
        contractVersion: NEON_V1_BACKFILL_CONTRACT_VERSION,
        jobs: [sampleJob()],
      }),
    });

    expect(result.status).toBe("succeeded");
    expect(putCalls).toBe(2);
  });

  it("retries transient network errors and succeeds after failures", async () => {
    setRawWriteRetrySleepForTests(() => Promise.resolve());
    const backingStore = new InMemoryObjectStore();
    let putCalls = 0;
    const transientError = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });
    const objectStore: ObjectStore = {
      deleteExpired: (before) => backingStore.deleteExpired(before),
      get: (path) => backingStore.get(path),
      put: async (object) => {
        putCalls += 1;
        if (putCalls <= 3) {
          throw transientError;
        }
        await backingStore.put(object);
      },
    };

    const result = await runNeonV1Backfill({
      bindings,
      curateStore: new InMemoryCurateStore(),
      objectStore,
      provenanceStore: new InMemoryBackfillProvenanceStore(),
      runStore: new InMemoryBackfillRunStore(),
      source: createFixtureNeonV1Source({
        capturedAt: "2026-09-03T10:05:00.000Z",
        contractVersion: NEON_V1_BACKFILL_CONTRACT_VERSION,
        jobs: [sampleJob()],
      }),
    });

    expect(result.status).toBe("succeeded");
    expect(putCalls).toBe(4);
  });

  it("exhausts the full raw-write retry budget on persistent transient errors", async () => {
    setRawWriteRetrySleepForTests(() => Promise.resolve());
    const transientError = Object.assign(
      new Error("TooManyRequests: Cloudflare rate limited"),
      { status: 429 }
    );
    let putCalls = 0;
    const objectStore: ObjectStore = {
      deleteExpired: () => Promise.resolve(0),
      get: () => Promise.resolve(null),
      put: () => {
        putCalls += 1;
        return Promise.reject(transientError);
      },
    };

    const result = await runNeonV1Backfill({
      bindings,
      curateStore: new InMemoryCurateStore(),
      objectStore,
      provenanceStore: new InMemoryBackfillProvenanceStore(),
      runStore: new InMemoryBackfillRunStore(),
      source: createFixtureNeonV1Source({
        capturedAt: "2026-09-03T10:05:00.000Z",
        contractVersion: NEON_V1_BACKFILL_CONTRACT_VERSION,
        jobs: [sampleJob()],
      }),
    });

    expect(result.status).toBe("failed");
    expect(result.evidence.failure).toEqual({
      code: "RAW_WRITE_FAILED",
      phase: "raw-write",
    });
    expect(putCalls).toBe(RAW_WRITE_RETRY_DELAYS_MS.length + 1);
    expect(getBackfillFailureDiagnostic(result)?.error.cause).toBe(
      transientError
    );
  });

  it("does not retry a permanent object-store write error", async () => {
    setRawWriteRetrySleepForTests(() => Promise.resolve());
    const permanentError = Object.assign(new Error("Access denied"), {
      status: 403,
    });
    let putCalls = 0;
    const objectStore: ObjectStore = {
      deleteExpired: () => Promise.resolve(0),
      get: () => Promise.resolve(null),
      put: () => {
        putCalls += 1;
        return Promise.reject(permanentError);
      },
    };

    const result = await runNeonV1Backfill({
      bindings,
      curateStore: new InMemoryCurateStore(),
      objectStore,
      provenanceStore: new InMemoryBackfillProvenanceStore(),
      runStore: new InMemoryBackfillRunStore(),
      source: createFixtureNeonV1Source({
        capturedAt: "2026-09-03T10:05:00.000Z",
        contractVersion: NEON_V1_BACKFILL_CONTRACT_VERSION,
        jobs: [sampleJob()],
      }),
    });

    expect(result.status).toBe("failed");
    expect(result.evidence.failure).toEqual({
      code: "RAW_WRITE_FAILED",
      phase: "raw-write",
    });
    expect(putCalls).toBe(1);
    expect(getBackfillFailureDiagnostic(result)?.error.cause).toBe(
      permanentError
    );
  });

  it("does not retry permanent client errors even when the message looks transient", async () => {
    setRawWriteRetrySleepForTests(() => Promise.resolve());
    const permanentError = Object.assign(
      new Error("timeout while authorizing request"),
      { status: 401 }
    );
    let putCalls = 0;
    const objectStore: ObjectStore = {
      deleteExpired: () => Promise.resolve(0),
      get: () => Promise.resolve(null),
      put: () => {
        putCalls += 1;
        return Promise.reject(permanentError);
      },
    };

    const result = await runNeonV1Backfill({
      bindings,
      curateStore: new InMemoryCurateStore(),
      objectStore,
      provenanceStore: new InMemoryBackfillProvenanceStore(),
      runStore: new InMemoryBackfillRunStore(),
      source: createFixtureNeonV1Source({
        capturedAt: "2026-09-03T10:05:00.000Z",
        contractVersion: NEON_V1_BACKFILL_CONTRACT_VERSION,
        jobs: [sampleJob()],
      }),
    });

    expect(result.status).toBe("failed");
    expect(putCalls).toBe(1);
    expect(getBackfillFailureDiagnostic(result)?.error.cause).toBe(
      permanentError
    );
  });

  it("counts a pre-dispatch raw preparation failure exactly once", async () => {
    const cyclicSourceRow: Record<string, JsonValue> = {};
    cyclicSourceRow.self = cyclicSourceRow;

    const result = await runNeonV1Backfill({
      bindings,
      concurrency: 16,
      curateStore: new InMemoryCurateStore(),
      objectStore: new InMemoryObjectStore(),
      provenanceStore: new InMemoryBackfillProvenanceStore(),
      runStore: new InMemoryBackfillRunStore(),
      source: createFixtureNeonV1Source({
        capturedAt: "2026-09-03T10:05:00.000Z",
        contractVersion: NEON_V1_BACKFILL_CONTRACT_VERSION,
        jobs: [{ ...sampleJob(), sourceRow: cyclicSourceRow }],
      }),
    });

    expect(result.status).toBe("failed");
    expect(result.evidence.failure).toEqual({
      code: "RAW_WRITE_FAILED",
      phase: "raw-write",
    });
    expect(result.metrics).toMatchObject({
      errors: 1,
      found: 1,
      selected: 1,
    });
    expect(result.metrics.platforms.nationalevacaturebank).toMatchObject({
      errors: 1,
      found: 1,
      selected: 1,
    });
  });

  it("imports fixture jobs idempotently on duplicate v1_id", async () => {
    const fixture = {
      capturedAt: "2026-08-29T10:00:00.000Z",
      contractVersion: NEON_V1_BACKFILL_CONTRACT_VERSION,
      jobs: [sampleJob()],
    };
    const curateStore = new InMemoryCurateStore();
    const provenanceStore = new InMemoryBackfillProvenanceStore();
    const runStore = new InMemoryBackfillRunStore();
    const objectStore = new InMemoryObjectStore();
    const sharedInput = {
      bindings,
      curateStore,
      objectStore,
      provenanceStore,
      runStore,
      source: createFixtureNeonV1Source(fixture),
      startedAt: new Date("2026-08-29T10:00:00.000Z"),
    };

    const first = await runNeonV1Backfill(sharedInput);
    const second = await runNeonV1Backfill(sharedInput);

    expect(first.status).toBe("succeeded");
    expect(first.metrics.imported).toBe(1);
    expect(first.evidence.scopeManifest).toMatchObject({
      contractVersion: "motian-v1-scope-manifest/v1",
      digestAlgorithm: "sha256",
      platformCounts: { nationalevacaturebank: 1 },
      selected: 1,
      snapshot: {
        completedAt: fixture.capturedAt,
        startedAt: fixture.capturedAt,
      },
    });
    expect(first.evidence.scopeManifest?.orderedDigest).toMatch(
      /^[0-9a-f]{64}$/u
    );
    expect(first.evidence.targetReconciliation).toMatchObject({
      contractVersion: "motian-v1-target-reconciliation/v1",
      distinctV1Ids: 1,
      matchesScope: true,
      platformCounts: { nationalevacaturebank: 1 },
      records: 1,
    });
    expect(first.evidence.targetReconciliation?.orderedDigest).toBe(
      first.evidence.scopeManifest?.orderedDigest
    );
    expect(first.evidence.metrics.platforms.nationalevacaturebank).toEqual({
      ...reconciliationMetrics({ matched: 1, selected: 1 }),
      errors: 0,
      found: 1,
      imported: 1,
      rejected: 0,
      skipped: 0,
    });
    expect(second.status).toBe("succeeded");
    expect(second.metrics.skipped).toBe(1);
    expect(second.evidence.metrics.platforms.nationalevacaturebank).toEqual({
      ...reconciliationMetrics({ matched: 1, selected: 1 }),
      errors: 0,
      found: 1,
      imported: 0,
      rejected: 0,
      skipped: 1,
    });
    expect(runStore.runs.at(-1)?.evidence).toEqual(second.evidence);
    expect(second.evidence.scopeManifest?.orderedDigest).toBe(
      first.evidence.scopeManifest?.orderedDigest
    );
    expect(second.evidence.targetReconciliation?.matchesScope).toBe(true);
    expect(curateStore.aanvragen).toHaveLength(1);
    expect(objectStore.has(curateStore.aanvragen[0]?.rawPayloadRef ?? "")).toBe(
      true
    );
    expect(curateStore.aanvragen[0]?.rawPayloadRef).toMatch(
      /^raw\/nationalevacaturebank\/\d{4}\/\d{2}\/[0-9a-f]{64}\.json$/u
    );
  });

  it("re-imports same-identity jobs when source content drifts", async () => {
    const firstJob = sampleJob();
    const secondJob = {
      ...firstJob,
      description: "Updated description from Motian.",
    };
    const curateStore = new InMemoryCurateStore();
    const provenanceStore = new InMemoryBackfillProvenanceStore();
    const objectStore = new InMemoryObjectStore();
    const runStore = new InMemoryBackfillRunStore();
    const run = (job: NeonV1JobRow) =>
      runNeonV1Backfill({
        bindings,
        curateStore,
        objectStore,
        provenanceStore,
        runStore,
        source: createFixtureNeonV1Source({
          capturedAt: "2026-08-29T10:00:00.000Z",
          contractVersion: NEON_V1_BACKFILL_CONTRACT_VERSION,
          jobs: [job],
        }),
        startedAt: new Date("2026-08-29T10:00:00.000Z"),
      });

    const first = await run(firstJob);
    const firstProvenance = await provenanceStore.findByV1Id(firstJob.id);
    const second = await run(secondJob);
    const secondProvenance = await provenanceStore.findByV1Id(secondJob.id);

    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("succeeded");
    expect(second.metrics).toMatchObject({
      errors: 0,
      imported: 1,
      matched: 1,
      skipped: 0,
    });
    expect(secondProvenance?.contentHash).not.toBe(
      firstProvenance?.contentHash
    );
    expect(secondProvenance?.rawPayloadRef).not.toBe(
      firstProvenance?.rawPayloadRef
    );
    expect(
      await objectStore.get(secondProvenance?.rawPayloadRef ?? "")
    ).not.toBeNull();
    expect(curateStore.aanvragen[0]?.beschrijving).toBe(secondJob.description);
  });

  it("writes the complete Motian source row to raw storage", async () => {
    const sourceRow = {
      archived_at: null,
      custom_v1_column: { nested: ["preserved"] },
      id: "v1-job-source-row",
      platform: "nationalevacaturebank",
      raw_payload: { body: "original Motian JSON" },
    };
    const fixture = {
      capturedAt: "2026-08-29T10:00:00.000Z",
      contractVersion: NEON_V1_BACKFILL_CONTRACT_VERSION,
      jobs: [
        {
          ...sampleJob(),
          id: "00000000-0000-4000-8000-000000000002",
          sourceRow,
        },
      ],
    };
    const curateStore = new InMemoryCurateStore();
    const objectStore = new InMemoryObjectStore();
    const result = await runNeonV1Backfill({
      bindings,
      curateStore,
      objectStore,
      provenanceStore: new InMemoryBackfillProvenanceStore(),
      runStore: new InMemoryBackfillRunStore(),
      source: createFixtureNeonV1Source(fixture),
      startedAt: new Date("2026-08-29T10:00:00.000Z"),
    });

    const rawPayloadRef = curateStore.aanvragen[0]?.rawPayloadRef;
    if (!rawPayloadRef) {
      throw new Error("Expected the curated row to reference raw storage");
    }
    const stored = await objectStore.get(rawPayloadRef);
    if (!stored) {
      throw new Error("Expected the complete source row in raw storage");
    }

    expect(result.status).toBe("succeeded");
    expect(JSON.parse(new TextDecoder().decode(stored.body))).toEqual(
      sourceRow
    );
  });

  it("fails when the object store cannot read back an exact raw write", async () => {
    const backingStore = new InMemoryObjectStore();
    const missingReadbackStore: ObjectStore = {
      deleteExpired: (before) => backingStore.deleteExpired(before),
      get: () => Promise.resolve(null),
      put: (object) => backingStore.put(object),
    };
    const runStore = new InMemoryBackfillRunStore();

    const result = await runNeonV1Backfill({
      bindings,
      curateStore: new InMemoryCurateStore(),
      objectStore: missingReadbackStore,
      provenanceStore: new InMemoryBackfillProvenanceStore(),
      runStore,
      source: createFixtureNeonV1Source({
        capturedAt: "2026-08-29T10:00:00.000Z",
        contractVersion: NEON_V1_BACKFILL_CONTRACT_VERSION,
        jobs: [sampleJob()],
      }),
    });

    expect(result.status).toBe("failed");
    expect(result.evidence.failure).toEqual({
      code: "RAW_READBACK_FAILED",
      phase: "raw-write",
    });
    expect(runStore.runs.at(-1)?.failure).toEqual(result.evidence.failure);
  });

  it("verifies existing raw bytes before counting a v1_id as skipped", async () => {
    const fixture = {
      capturedAt: "2026-08-29T10:00:00.000Z",
      contractVersion: NEON_V1_BACKFILL_CONTRACT_VERSION,
      jobs: [sampleJob()],
    };
    const curateStore = new InMemoryCurateStore();
    const provenanceStore = new InMemoryBackfillProvenanceStore();
    const objectStore = new InMemoryObjectStore();
    const sharedInput = {
      bindings,
      curateStore,
      objectStore,
      provenanceStore,
      runStore: new InMemoryBackfillRunStore(),
      source: createFixtureNeonV1Source(fixture),
      startedAt: new Date("2026-08-29T10:00:00.000Z"),
    };
    const first = await runNeonV1Backfill(sharedInput);
    const rawPayloadRef = curateStore.aanvragen[0]?.rawPayloadRef;
    if (!rawPayloadRef) {
      throw new Error("Expected raw payload reference after first import");
    }
    const stored = await objectStore.get(rawPayloadRef);
    if (!stored) {
      throw new Error("Expected stored raw payload after first import");
    }
    await objectStore.put({
      ...stored,
      body: new TextEncoder().encode('{"tampered":true}'),
    });

    const second = await runNeonV1Backfill(sharedInput);

    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("failed");
    expect(second.metrics.skipped).toBe(0);
    expect(second.evidence.failure).toEqual({
      code: "RAW_READBACK_FAILED",
      phase: "raw-write",
    });
  });

  it("fails instead of blindly skipping mismatched existing provenance", async () => {
    const fixture = {
      capturedAt: "2026-08-29T10:00:00.000Z",
      contractVersion: NEON_V1_BACKFILL_CONTRACT_VERSION,
      jobs: [sampleJob()],
    };
    const curateStore = new InMemoryCurateStore();
    const provenanceStore = new InMemoryBackfillProvenanceStore();
    const objectStore = new InMemoryObjectStore();
    const sharedInput = {
      bindings,
      curateStore,
      objectStore,
      provenanceStore,
      runStore: new InMemoryBackfillRunStore(),
      source: createFixtureNeonV1Source(fixture),
      startedAt: new Date("2026-08-29T10:00:00.000Z"),
    };
    await runNeonV1Backfill(sharedInput);
    const existing = await provenanceStore.findByV1Id(sampleJob().id);
    if (!existing) {
      throw new Error("Expected provenance after first import");
    }
    await provenanceStore.registerV1Id({
      ...existing,
      bronReferentie: "wrong-external-id",
    });

    const second = await runNeonV1Backfill(sharedInput);

    expect(second.status).toBe("failed");
    expect(second.metrics.skipped).toBe(0);
    expect(second.evidence.failure).toEqual({
      code: "PROVENANCE_MISMATCH",
      phase: "provenance",
    });
  });

  it("keeps a provenance write error as the BackfillFailureError cause", async () => {
    const backingStore = new InMemoryBackfillProvenanceStore();
    const storeError = new Error("duplicate v1_id");
    storeError.name = "PostgresError";
    const provenanceStore: BackfillProvenanceStore = {
      consumeReconciliationSnapshot: (bronIds, batchSize, consume) =>
        backingStore.consumeReconciliationSnapshot(bronIds, batchSize, consume),
      findByAanvraagId: (aanvraagId) =>
        backingStore.findByAanvraagId(aanvraagId),
      findByV1Id: (v1Id) => backingStore.findByV1Id(v1Id),
      registerV1Id: () => Promise.reject(storeError),
    };

    const result = await runNeonV1Backfill({
      bindings,
      curateStore: new InMemoryCurateStore(),
      objectStore: new InMemoryObjectStore(),
      provenanceStore,
      runStore: new InMemoryBackfillRunStore(),
      source: createFixtureNeonV1Source({
        capturedAt: "2026-08-29T10:00:00.000Z",
        contractVersion: NEON_V1_BACKFILL_CONTRACT_VERSION,
        jobs: [sampleJob()],
      }),
    });
    const diagnostic = getBackfillFailureDiagnostic(result);

    expect(result.status).toBe("failed");
    expect(result.evidence.failure).toEqual({
      code: "PROVENANCE_WRITE_FAILED",
      phase: "provenance",
    });
    expect(result.metrics.errors).toBe(1);
    expect(diagnostic).toMatchObject({
      platform: "nationalevacaturebank",
      sourceJobId: "00000000-0000-4000-8000-000000000001",
    });
    expect(diagnostic?.error.name).toBe("BackfillFailureError");
    expect(diagnostic?.error.cause).toBe(storeError);
    expect(JSON.stringify(result)).not.toContain(storeError.message);
  });

  it("refuses a second v1 row that collapses onto an already-bound aanvraag before curating it", async () => {
    const curateStore = new InMemoryCurateStore();
    const provenanceStore = new InMemoryBackfillProvenanceStore();
    const firstJob = sampleJob();
    const secondJob = {
      ...sampleJob(),
      description: "Same posting, different Motian id.",
      id: "00000000-0000-4000-8000-000000000009",
    };

    const result = await runNeonV1Backfill({
      bindings,
      curateStore,
      objectStore: new InMemoryObjectStore(),
      provenanceStore,
      runStore: new InMemoryBackfillRunStore(),
      source: createFixtureNeonV1Source({
        capturedAt: "2026-08-29T10:00:00.000Z",
        contractVersion: NEON_V1_BACKFILL_CONTRACT_VERSION,
        jobs: [firstJob, secondJob],
      }),
    });

    expect(result.status).toBe("failed");
    expect(result.evidence.failure).toEqual({
      code: "PROVENANCE_MISMATCH",
      phase: "provenance",
    });
    expect(getBackfillFailureDiagnostic(result)).toMatchObject({
      sourceJobId: secondJob.id,
    });
    // The collision is refused before curation touches the aanvraag: one
    // aanvraag, one version, one outbox event, still carrying the first row.
    expect(curateStore.aanvragen).toHaveLength(1);
    expect(curateStore.versies).toHaveLength(1);
    expect(curateStore.outboxEvents).toHaveLength(1);
    const firstProvenance = await provenanceStore.findByV1Id(firstJob.id);
    expect(curateStore.aanvragen[0]?.contentHash).toBe(
      firstProvenance?.contentHash
    );
    expect(await provenanceStore.findByV1Id(secondJob.id)).toBeNull();
  });

  it("mirrors the one-v1-id-per-aanvraag guard in the in-memory store", async () => {
    const provenanceStore = new InMemoryBackfillProvenanceStore();
    const aanvraagId = crypto.randomUUID();
    const record = {
      aanvraagId,
      bronId: "bron-1",
      bronReferentie: "ext-1",
      contentHash: "0".repeat(64),
      rawPayloadRef: "raw/ext-1.json",
      v1Id: "v1-1",
    };
    await provenanceStore.registerV1Id(record);
    await provenanceStore.registerV1Id(record);

    await expect(
      provenanceStore.registerV1Id({ ...record, v1Id: "v1-2" })
    ).rejects.toThrow(
      `Refusing to register v1_id v1-2 on aanvraag ${aanvraagId}: aanvraag is already bound to v1_id v1-1`
    );
    expect(await provenanceStore.findByAanvraagId(aanvraagId)).toMatchObject({
      v1Id: "v1-1",
    });
    expect(await provenanceStore.findByAanvraagId("unbound")).toBeNull();
  });

  it("fails exact reconciliation on extra or duplicate target provenance", async () => {
    const [binding] = bindings;
    if (!binding) {
      throw new Error("Expected a Motian binding");
    }
    const provenanceStore = new InMemoryBackfillProvenanceStore();
    await provenanceStore.registerV1Id({
      aanvraagId: crypto.randomUUID(),
      bronId: binding.bronId,
      bronReferentie: "extra-target-row",
      contentHash: "0".repeat(64),
      rawPayloadRef: `raw/${binding.platform}/2026/08/${"0".repeat(64)}.json`,
      v1Id: "00000000-0000-4000-8000-000000000002",
    });
    const consumeSnapshot =
      provenanceStore.consumeReconciliationSnapshot.bind(provenanceStore);
    provenanceStore.consumeReconciliationSnapshot = (
      bronIds,
      batchSize,
      consume
    ) =>
      consumeSnapshot(bronIds, batchSize, (batch) => {
        const [first, ...rest] = batch;
        return consume(first ? [first, first, ...rest] : batch);
      });

    const result = await runNeonV1Backfill({
      bindings,
      curateStore: new InMemoryCurateStore(),
      objectStore: new InMemoryObjectStore(),
      provenanceStore,
      runStore: new InMemoryBackfillRunStore(),
      source: createFixtureNeonV1Source({
        capturedAt: "2026-08-29T10:00:00.000Z",
        contractVersion: NEON_V1_BACKFILL_CONTRACT_VERSION,
        jobs: [sampleJob()],
      }),
    });

    expect(result.status).toBe("failed");
    expect(result.evidence.failure).toEqual({
      code: "RECONCILIATION_DRIFT",
      phase: "reconcile",
    });
    expect(result.metrics.platforms.nationalevacaturebank?.extra).toBe(1);
    expect(result.metrics.platforms.nationalevacaturebank?.duplicates).toBe(1);
  });

  it("fails on a swapped target ID even when source and target counts match", async () => {
    const provenanceStore = new InMemoryBackfillProvenanceStore();
    const consumeSnapshot =
      provenanceStore.consumeReconciliationSnapshot.bind(provenanceStore);
    provenanceStore.consumeReconciliationSnapshot = (
      bronIds,
      batchSize,
      consume
    ) =>
      consumeSnapshot(bronIds, batchSize, (batch) =>
        consume(
          batch.map((record) => ({
            ...record,
            v1Id: "00000000-0000-4000-8000-000000000002",
          }))
        )
      );

    const result = await runNeonV1Backfill({
      bindings,
      curateStore: new InMemoryCurateStore(),
      objectStore: new InMemoryObjectStore(),
      provenanceStore,
      runStore: new InMemoryBackfillRunStore(),
      source: createFixtureNeonV1Source({
        capturedAt: "2026-08-29T10:00:00.000Z",
        contractVersion: NEON_V1_BACKFILL_CONTRACT_VERSION,
        jobs: [sampleJob()],
      }),
    });

    expect(result.status).toBe("failed");
    expect(result.metrics.missing).toBe(0);
    expect(result.metrics.extra).toBe(0);
    expect(result.evidence.targetReconciliation?.records).toBe(1);
    expect(result.evidence.targetReconciliation?.matchesScope).toBe(false);
    expect(result.evidence.failure).toEqual({
      code: "RECONCILIATION_DRIFT",
      phase: "reconcile",
    });
  });

  it("fails reconciliation when target provenance changes after the row check", async () => {
    const provenanceStore = new InMemoryBackfillProvenanceStore();
    const consumeSnapshot =
      provenanceStore.consumeReconciliationSnapshot.bind(provenanceStore);
    provenanceStore.consumeReconciliationSnapshot = (
      bronIds,
      batchSize,
      consume
    ) =>
      consumeSnapshot(bronIds, batchSize, (batch) =>
        consume(
          batch.map((record) => ({
            ...record,
            bronReferentie: "mutated-after-row-check",
          }))
        )
      );

    const result = await runNeonV1Backfill({
      bindings,
      curateStore: new InMemoryCurateStore(),
      objectStore: new InMemoryObjectStore(),
      provenanceStore,
      runStore: new InMemoryBackfillRunStore(),
      source: createFixtureNeonV1Source({
        capturedAt: "2026-08-29T10:00:00.000Z",
        contractVersion: NEON_V1_BACKFILL_CONTRACT_VERSION,
        jobs: [sampleJob()],
      }),
    });

    expect(result.status).toBe("failed");
    expect(result.metrics.missing).toBe(0);
    expect(result.metrics.extra).toBe(0);
    expect(result.evidence.targetReconciliation?.matchesScope).toBe(false);
    expect(result.evidence.failure).toEqual({
      code: "RECONCILIATION_DRIFT",
      phase: "reconcile",
    });
  });

  it("fails closed when the source snapshot disappears after its rows were consumed", async () => {
    const runStore = new InMemoryBackfillRunStore();
    const result = await runNeonV1Backfill({
      bindings,
      curateStore: new InMemoryCurateStore(),
      objectStore: new InMemoryObjectStore(),
      provenanceStore: new InMemoryBackfillProvenanceStore(),
      runStore,
      source: {
        consumeSnapshot: async (_batchSize, consume) => {
          await consume([sampleJob()]);
          throw new Error("snapshot connection dropped before commit");
        },
        label: "lost-snapshot-test",
        loadJobs: () => Promise.resolve([]),
      },
    });

    expect(result.status).toBe("failed");
    expect(result.evidence.failure).toEqual({
      code: "SOURCE_READ_FAILED",
      phase: "source-read",
    });
    expect(result.evidence.scopeManifest).toBeUndefined();
    expect(result.evidence.targetReconciliation).toBeUndefined();
    expect(runStore.runs.at(-1)?.status).toBe("failed");
  });

  it("accepts canonical lowercase UUID source ids in byte order", async () => {
    const orderedIds = [
      "00000000-0000-4000-8000-000000000009",
      "00000000-0000-4000-8000-00000000000a",
      "00000000-0000-4000-8000-00000000000f",
      "00000000-0000-4000-8000-000000000010",
    ];
    const runWithIds = async (ids: readonly string[]) => {
      let consumed = false;
      const result = await runNeonV1Backfill({
        bindings,
        curateStore: new InMemoryCurateStore(),
        objectStore: new InMemoryObjectStore(),
        provenanceStore: new InMemoryBackfillProvenanceStore(),
        runStore: new InMemoryBackfillRunStore(),
        source: {
          consumeSnapshot: async (_batchSize, consume) => {
            await consume(
              ids.map((id) => ({
                ...sampleJob(),
                external_id: `external-${id}`,
                id,
              }))
            );
            consumed = true;
            return {
              completedAt: "2026-09-03T10:05:00.000Z",
              startedAt: "2026-09-03T10:00:00.000Z",
            };
          },
          label: "canonical-ordered-test",
          loadJobs: () => Promise.resolve([]),
        },
      });
      return { consumed, result };
    };

    const accepted = await runWithIds(orderedIds);

    expect(accepted.consumed).toBe(true);
    expect(accepted.result.metrics.selected).toBe(orderedIds.length);
  });

  it("rejects a non-canonical source id shape", async () => {
    const offendingId = "00000000-0000-4000-8000-00000000000A";
    const result = await runNeonV1Backfill({
      bindings,
      curateStore: new InMemoryCurateStore(),
      objectStore: new InMemoryObjectStore(),
      provenanceStore: new InMemoryBackfillProvenanceStore(),
      runStore: new InMemoryBackfillRunStore(),
      source: createFixtureNeonV1Source({
        capturedAt: "2026-09-03T10:05:00.000Z",
        contractVersion: NEON_V1_BACKFILL_CONTRACT_VERSION,
        jobs: [{ ...sampleJob(), id: offendingId }],
      }),
    });
    const diagnostic = getBackfillFailureDiagnostic(result);

    expect(result.evidence.failure).toEqual({
      code: "SOURCE_READ_FAILED",
      phase: "source-read",
    });
    const cause = diagnostic?.error.cause;
    expect(cause).toBeInstanceOf(Error);
    if (!(cause instanceof Error)) {
      throw new Error("Expected a source ID shape diagnostic");
    }
    expect(cause.message).toContain(offendingId);
    expect(cause.message).not.toContain(sampleJob().description);
  });

  it("rejects descending canonical source ids", async () => {
    const result = await runNeonV1Backfill({
      bindings,
      curateStore: new InMemoryCurateStore(),
      objectStore: new InMemoryObjectStore(),
      provenanceStore: new InMemoryBackfillProvenanceStore(),
      runStore: new InMemoryBackfillRunStore(),
      source: {
        consumeSnapshot: async (_batchSize, consume) => {
          await consume([
            {
              ...sampleJob(),
              id: "00000000-0000-4000-8000-000000000002",
            },
            {
              ...sampleJob(),
              id: "00000000-0000-4000-8000-000000000001",
            },
          ]);
          return {
            completedAt: "2026-09-03T10:05:00.000Z",
            startedAt: "2026-09-03T10:00:00.000Z",
          };
        },
        label: "descending-canonical-test",
        loadJobs: () => Promise.resolve([]),
      },
    });

    expect(result.evidence.failure).toEqual({
      code: "SOURCE_READ_FAILED",
      phase: "source-read",
    });
  });

  it("rejects a non-canonical target id shape", async () => {
    const offendingId = "00000000-0000-4000-8000-00000000000A";
    const provenanceStore = new InMemoryBackfillProvenanceStore();
    const consumeSnapshot =
      provenanceStore.consumeReconciliationSnapshot.bind(provenanceStore);
    provenanceStore.consumeReconciliationSnapshot = (
      bronIds,
      batchSize,
      consume
    ) =>
      consumeSnapshot(bronIds, batchSize, (batch) =>
        consume(batch.map((record) => ({ ...record, v1Id: offendingId })))
      );

    const result = await runNeonV1Backfill({
      bindings,
      curateStore: new InMemoryCurateStore(),
      objectStore: new InMemoryObjectStore(),
      provenanceStore,
      runStore: new InMemoryBackfillRunStore(),
      source: createFixtureNeonV1Source({
        capturedAt: "2026-09-03T10:05:00.000Z",
        contractVersion: NEON_V1_BACKFILL_CONTRACT_VERSION,
        jobs: [sampleJob()],
      }),
    });
    const diagnostic = getBackfillFailureDiagnostic(result);

    expect(result.evidence.failure).toEqual({
      code: "RECONCILIATION_READ_FAILED",
      phase: "reconcile",
    });
    const cause = diagnostic?.error.cause;
    expect(cause).toBeInstanceOf(Error);
    if (!(cause instanceof Error)) {
      throw new Error("Expected a target ID shape diagnostic");
    }
    expect(cause.message).toContain(offendingId);
    expect(cause.message).not.toContain(sampleJob().description);
  });

  it("fails a production run when a platform is rejected and persists its evidence", async () => {
    const runStore = new InMemoryBackfillRunStore();
    const result = await runNeonV1Backfill({
      bindings,
      curateStore: new InMemoryCurateStore(),
      execution: { mode: "production", scope: "full" },
      objectStore: new InMemoryObjectStore(),
      provenanceStore: new InMemoryBackfillProvenanceStore(),
      runStore,
      source: createFixtureNeonV1Source({
        capturedAt: "2026-08-29T10:00:00.000Z",
        contractVersion: NEON_V1_BACKFILL_CONTRACT_VERSION,
        jobs: [{ ...sampleJob(), platform: "unsupported-platform" }],
      }),
    });

    expect(result.status).toBe("failed");
    expect(result.metrics.rejected).toBe(1);
    expect(result.evidence.failure).toEqual({
      code: "RECONCILIATION_DRIFT",
      phase: "reconcile",
    });
    expect(result.evidence.metrics.platforms["unsupported-platform"]).toEqual({
      ...reconciliationMetrics({ matched: 0, missing: 1, selected: 1 }),
      errors: 0,
      found: 1,
      imported: 0,
      rejected: 1,
      skipped: 0,
    });
    expect(runStore.runs.at(-1)?.evidence).toEqual(result.evidence);
    expect(runStore.runs.at(-1)?.failure).toEqual(result.evidence.failure);
  });

  it("refuses production when the source cannot hold one consistent snapshot", async () => {
    await expect(
      runNeonV1Backfill({
        bindings,
        curateStore: new InMemoryCurateStore(),
        execution: { mode: "production", scope: "full" },
        objectStore: new InMemoryObjectStore(),
        provenanceStore: new InMemoryBackfillProvenanceStore(),
        runStore: new InMemoryBackfillRunStore(),
        source: {
          label: "non-snapshot-source",
          loadJobs: () => Promise.resolve([sampleJob()]),
        },
      })
    ).rejects.toThrow(
      "Production Motian v1 backfills require a consistent source snapshot"
    );
  });

  it("marks the run failed and writes no curated rows when the source is unreachable", async () => {
    const curateStore = new InMemoryCurateStore();
    const runStore = new InMemoryBackfillRunStore();
    const result = await runNeonV1Backfill({
      bindings,
      curateStore,
      objectStore: new InMemoryObjectStore(),
      provenanceStore: new InMemoryBackfillProvenanceStore(),
      runStore,
      source: new UnreachableNeonV1Source(),
    });

    expect(result.status).toBe("failed");
    expect(result.metrics.errors).toBe(1);
    expect(result.evidence.failure).toEqual({
      code: "SOURCE_READ_FAILED",
      phase: "source-read",
    });
    expect(result.evidence.metrics.platforms.__source__).toEqual({
      ...reconciliationMetrics({ matched: 0, selected: 0 }),
      errors: 1,
      found: 0,
      imported: 0,
      rejected: 0,
      skipped: 0,
    });
    expect(curateStore.aanvragen).toHaveLength(0);
    expect(runStore.runs.at(-1)?.status).toBe("failed");
    expect(runStore.runs.at(-1)?.evidence).toEqual(result.evidence);
    expect(runStore.runs.at(-1)?.failure).toEqual(result.evidence.failure);
    expect(runStore.runs.at(-1)?.reason).toBe(
      "Backfill failed during source-read"
    );
    expect(JSON.stringify(runStore.runs.at(-1))).not.toContain("unreachable");
  });

  it("rejects invalid failure phase/code pairs at the evidence boundary", () => {
    expect(() =>
      backfillFailureEvidenceSchema.parse({
        code: "SOURCE_READ_FAILED",
        phase: "raw-write",
      })
    ).toThrow();
  });

  it("imports all 200 rows from the checked-in CI fixture", async () => {
    const fixture = await loadNeonV1Fixture("neon-v1-sample.json");
    const result = await runNeonV1Backfill({
      bindings: MOTIAN_V1_BRON_BINDINGS,
      curateStore: new InMemoryCurateStore(),
      objectStore: new InMemoryObjectStore(),
      provenanceStore: new InMemoryBackfillProvenanceStore(),
      runStore: new InMemoryBackfillRunStore(),
      source: createFixtureNeonV1Source(fixture),
      startedAt: new Date(fixture.capturedAt),
    });

    expect(fixture.contractVersion).toBe(NEON_V1_BACKFILL_CONTRACT_VERSION);
    expect(fixture.jobs).toHaveLength(200);
    expect(result.status).toBe("succeeded");
    expect(result.metrics).toMatchObject({
      errors: 0,
      imported: 200,
      matched: 200,
      rejected: 0,
      selected: 200,
    });
    expect(Object.keys(result.metrics.platforms)).toHaveLength(7);
  });
});

describe("Starapple CSS-as-description guard (CTP-492 AC6)", () => {
  const cssBlob = [
    ".recruiter-card { font-family: Arial, sans-serif; }",
    ".contact { color: #333; }",
    "@media (max-width: 600px) { .recruiter-card { display: none; } }",
  ].join("\n");

  it("falls back to title when Starapple description is stylesheet chrome", () => {
    const draft = mapV1JobToDraft({
      ...sampleJob(),
      description: cssBlob,
      platform: "starapple-nl",
    });
    expect(draft.beschrijving.value).toBe(
      "Platform engineer Azure (starapple-nl/ext-000001)"
    );
  });

  it("keeps real Starapple vacancy prose", () => {
    const prose =
      "Senior React developer for a healthcare platform in Utrecht.";
    const draft = mapV1JobToDraft({
      ...sampleJob(),
      description: prose,
      platform: "starapple",
    });
    expect(draft.beschrijving.value).toBe(prose);
  });

  it("does not apply the Starapple CSS guard to other platforms", () => {
    const draft = mapV1JobToDraft({
      ...sampleJob(),
      description: cssBlob,
      platform: "nationalevacaturebank",
    });
    expect(draft.beschrijving.value).toBe(cssBlob);
  });
});

// SAFETY: bronSpecifiek is the allowlisted Motian JSON object this mapper builds.
const bron = (job: NeonV1JobRow): Record<string, JsonValue> =>
  mapV1JobToDraft(job).bronSpecifiek.value as Record<string, JsonValue>;

describe("Motian legacy field mapping (CTP-515/527/528/529/530)", () => {
  it("maps the Motian province column to a canonical provincie", () => {
    expect(bron({ ...sampleJob(), province: "zuid-holland" }).provincie).toBe(
      "Zuid-Holland"
    );
    expect(bron({ ...sampleJob(), province: "Fryslân" }).provincie).toBe(
      "Friesland"
    );
  });

  it("reads provincie from a Werkzoeken title when the column is absent", () => {
    expect(
      bron({
        ...sampleJob(),
        location: "Rotterdam",
        platform: "werkzoeken",
        title: "Projectleider Vastgoed (Zuid-Holland)",
      }).provincie
    ).toBe("Zuid-Holland");
    expect(
      bron({
        ...sampleJob(),
        platform: "werkzoeken",
        title: "Data engineer (Utrecht)",
      }).provincie
    ).toBe("Utrecht");
  });

  it("does not read a title province on platforms other than Werkzoeken", () => {
    for (const platform of ["flextender", "starapple-nl", "mipublic"]) {
      expect(
        bron({ ...sampleJob(), platform, title: "Developer Utrecht" }).provincie
      ).toBeNull();
    }
  });

  it("never infers provincie from a city alone", () => {
    expect(
      bron({
        ...sampleJob(),
        location: "Amersfoort",
        title: "Scrum master Amersfoort",
      }).provincie
    ).toBeNull();
  });

  it("collects skills from the Motian competences list", () => {
    const draft = bron({
      ...sampleJob(),
      competences: [
        { name: "TypeScript" },
        { name: "Azure" },
        { name: "azure" },
      ],
    });
    expect(draft.skills).toEqual(["TypeScript", "Azure"]);
  });

  it("leaves skills absent when Motian publishes no competences list", () => {
    expect(
      bron({ ...sampleJob(), requirements: { education: ["HBO"] } }).skills
    ).toBeNull();
  });

  it("maps eind_datum from the typed end_date column", () => {
    expect(
      bron({ ...sampleJob(), end_date: "2027-03-31T00:00:00.000Z" }).eind_datum
    ).toBe("2027-03-31T00:00:00.000Z");
  });

  it("ignores an unparsable application deadline instead of storing Invalid Date", () => {
    const draft = mapV1JobToDraft({
      ...sampleJob(),
      application_deadline: "zo spoedig mogelijk",
    });
    expect(draft.sluitingsdatum).toBeUndefined();
  });
});

describe("Starapple broker self-name collapse (CTP-527 F02)", () => {
  it("does not store the broker's own brand as opdrachtgever", () => {
    // The CTP-514 audit recorded F02 WRONG on exactly this shape: the
    // reachable page names politie as eindklant while Motian carried the
    // intermediary's name. A broker board never publishes itself as client,
    // so the deterministic value is UNKNOWN, not "Starapple".
    for (const company of [
      "Starapple",
      "starapple",
      "Starapple.nl",
      "Starapple BV",
    ]) {
      const draft = mapV1JobToDraft({
        ...sampleJob(),
        company,
        end_client: null,
        platform: "starapple-nl",
      });
      expect(draft.opdrachtgeverNaam.value).toBe(UNKNOWN);
    }
  });

  it("keeps a recorded end client over the broker name", () => {
    const draft = mapV1JobToDraft({
      ...sampleJob(),
      company: "Starapple",
      end_client: "politie",
      platform: "starapple",
    });
    expect(draft.opdrachtgeverNaam.value).toBe("politie");
  });

  it("collapses a self-name recorded in end_client instead of falling back to company", () => {
    // end_client wins over company — but when the winning value IS the
    // broker's own name the row is wrong data, so it becomes UNKNOWN rather
    // than silently promoting the (also unverified) company field.
    const draft = mapV1JobToDraft({
      ...sampleJob(),
      company: "Gemeente Voorbeeld",
      end_client: "Starapple",
      platform: "starapple-nl",
    });
    expect(draft.opdrachtgeverNaam.value).toBe(UNKNOWN);
  });

  it("leaves the same brand untouched on non-Starapple platforms", () => {
    const draft = mapV1JobToDraft({
      ...sampleJob(),
      company: "Starapple",
      platform: "nationalevacaturebank",
    });
    expect(draft.opdrachtgeverNaam.value).toBe("Starapple");
  });

  it("keeps raw company/end_client in bronSpecifiek regardless of collapse", () => {
    const value = bron({
      ...sampleJob(),
      company: "Starapple",
      end_client: null,
      platform: "starapple-nl",
    });
    expect(value.company).toBe("Starapple");
  });
});
