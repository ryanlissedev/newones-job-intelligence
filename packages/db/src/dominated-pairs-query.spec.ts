import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";

import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import type { BronRuntimeDatabase } from "./bron-runtime";
import {
  RECOVERABLE_STATUSES,
  selectDominatedPairs,
} from "./curate-scrape-run";
import type { DominatedPair } from "./curate-scrape-run";
import * as schema from "./schema";
import { aanvraag, scrapeRun } from "./schema/curated";
import { aanvraagObservation, sourceRecord } from "./schema/staging";

const migratorUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
const databaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;
const migrationsFolder = path.join(import.meta.dir, "migrations");

const isPostgresAvailable = async (): Promise<boolean> => {
  const probe = postgres(migratorUrl, { connect_timeout: 2, max: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
    return true;
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return false;
  }
};

const postgresAvailable = await isPostgresAvailable();
if (!postgresAvailable && databaseRequired) {
  throw new Error("Required test database is unavailable");
}

// Copied from curate-scrape-run.ts at d335981 (not exported there).
const DOMINATING_STATUSES = [
  "awaiting_curation",
  "pending",
  "blocked_ordering",
  "blocked_ordering_legacy",
  "already_committed",
  "curated",
  "unchanged",
] as const;
const APPLIED_STATUSES = ["already_committed", "curated", "unchanged"];

const OBSERVATION_STATUSES = [
  ...RECOVERABLE_STATUSES,
  ...APPLIED_STATUSES,
  "superseded",
  "quarantined",
  "curation_failed",
] as const;
const RUN_STATUSES = [
  "succeeded",
  "succeeded",
  "succeeded",
  "failed",
  "cancelled",
];
const ALL_ELIGIBLE = ["succeeded", "failed", "cancelled"];

/**
 * The query this PR replaces, verbatim from markDominatedUnchangedObservations
 * at d335981. It is the oracle: selectDominatedPairs must return exactly its
 * rows on every input.
 */
const legacyDominatedPairs = (
  database: BronRuntimeDatabase,
  input: {
    bronId: string;
    eligibleRunStatuses: readonly string[];
    limit: number;
    scrapeRunId?: string;
  }
): Promise<DominatedPair[]> => {
  const dominatingObservation = alias(
    aanvraagObservation,
    "dominating_observation"
  );
  const dominatingRun = alias(scrapeRun, "dominating_run");
  return database
    .selectDistinctOn([aanvraagObservation.id], {
      dominatorBronId: dominatingObservation.bronId,
      dominatorBronReferentie: sourceRecord.bronReferentie,
      dominatorContentHash: dominatingObservation.contentHash,
      dominatorId: dominatingObservation.id,
      dominatorPayload: dominatingObservation.payload,
      dominatorRunBronId: dominatingRun.bronId,
      dominatorScrapeRunId: dominatingObservation.scrapeRunId,
      dominatorSourceRecordBronId: sourceRecord.bronId,
      dominatorSourceRecordId: dominatingObservation.sourceRecordId,
      dominatorStatus: dominatingObservation.status,
      id: aanvraagObservation.id,
    })
    .from(aanvraagObservation)
    .innerJoin(
      scrapeRun,
      and(
        eq(scrapeRun.id, aanvraagObservation.scrapeRunId),
        inArray(scrapeRun.status, [...input.eligibleRunStatuses])
      )
    )
    .innerJoin(
      sourceRecord,
      eq(sourceRecord.id, aanvraagObservation.sourceRecordId)
    )
    .innerJoin(
      aanvraag,
      and(
        eq(aanvraag.bronId, aanvraagObservation.bronId),
        eq(aanvraag.bronReferentie, sourceRecord.bronReferentie),
        eq(aanvraag.contentHash, aanvraagObservation.contentHash),
        eq(aanvraag.status, "active")
      )
    )
    .innerJoin(
      dominatingObservation,
      and(
        eq(dominatingObservation.bronId, aanvraagObservation.bronId),
        eq(
          dominatingObservation.sourceRecordId,
          aanvraagObservation.sourceRecordId
        ),
        eq(dominatingObservation.contentHash, aanvraagObservation.contentHash),
        inArray(dominatingObservation.status, [...DOMINATING_STATUSES])
      )
    )
    .innerJoin(
      dominatingRun,
      and(
        eq(dominatingRun.id, dominatingObservation.scrapeRunId),
        eq(dominatingRun.status, "succeeded"),
        gt(dominatingRun.gestart, scrapeRun.gestart)
      )
    )
    .where(
      and(
        eq(aanvraagObservation.bronId, input.bronId),
        eq(aanvraagObservation.outcome, "unchanged"),
        inArray(aanvraagObservation.status, [...RECOVERABLE_STATUSES]),
        input.scrapeRunId === undefined
          ? undefined
          : eq(aanvraagObservation.scrapeRunId, input.scrapeRunId)
      )
    )
    .orderBy(
      aanvraagObservation.id,
      desc(inArray(dominatingObservation.status, APPLIED_STATUSES)),
      desc(dominatingRun.gestart)
    )
    .limit(input.limit);
};

const PARK_MILLER_MODULUS = 2_147_483_647;

/** Park-Miller: a deterministic fixture, so a failure reproduces exactly. */
const prng = (seed: number): (() => number) => {
  let state = seed % PARK_MILLER_MODULUS;
  return () => {
    state = (state * 48_271) % PARK_MILLER_MODULUS;
    return (state - 1) / (PARK_MILLER_MODULUS - 1);
  };
};

const outcomeFor = (seen: number, firstOfVersion: boolean): string => {
  if (seen === 0) {
    return "new";
  }
  return firstOfVersion ? "changed" : "unchanged";
};

interface RecordRow {
  bron_id: string;
  bron_referentie: string;
  content_hash: string;
  id: string;
  raw_payload_ref: string;
  scrape_run_id: string;
}

interface ObservationRow {
  bron_id: string;
  content_hash: string;
  id: string;
  outcome: string;
  payload: string;
  scrape_run_id: string;
  source_record_id: string;
  status: string;
}

interface AanvraagRow {
  beschrijving: string;
  bron_id: string;
  bron_referentie: string;
  content_hash: string;
  eerste_gezien_op: string;
  extractie_methode: string;
  laatst_gezien_op: string;
  raw_payload_ref: string;
  scrape_run_id: string;
  status: string;
  titel: string;
}

interface Fixture {
  bronIds: string[];
  payloadById: Map<string, unknown>;
  runIdsByBron: Map<string, string[]>;
}

interface TieFixture {
  bronId: string;
  dominatedId: string;
  siblingIds: string[];
}

const BRONS = 3;
const RECORDS_PER_BRON = 40;
const RUNS_PER_BRON = 12;
const BASE_TIME = Date.parse("2026-09-01T00:00:00.000Z");
const HOUR = 3_600_000;

const seedFixture = async (client: postgres.Sql): Promise<Fixture> => {
  const random = prng(20_261_011);
  const pick = <T>(values: readonly T[]): T => {
    const value = values.at(Math.floor(random() * values.length));
    if (value === undefined) {
      throw new RangeError("pick from an empty list");
    }
    return value;
  };
  const fixture: Fixture = {
    bronIds: [],
    payloadById: new Map(),
    runIdsByBron: new Map(),
  };
  for (let bronIndex = 0; bronIndex < BRONS; bronIndex += 1) {
    const bronId = crypto.randomUUID();
    fixture.bronIds.push(bronId);
    // oxlint-disable-next-line no-await-in-loop -- fixture rows depend on the bron row
    await client`INSERT INTO curated.bron (id, naam, categorie)
      VALUES (${bronId}, ${`dominated-parity-${bronId}`}, 'parity')`;
    const runs = Array.from({ length: RUNS_PER_BRON }, (_, runIndex) => {
      const status = pick(RUN_STATUSES);
      const gestart = new Date(BASE_TIME + runIndex * HOUR + bronIndex * 1000);
      return {
        bron_id: bronId,
        completion: status === "succeeded" ? "complete" : null,
        failure_class: status === "failed" ? "connector" : null,
        failure_code: status === "failed" ? "FETCH_FAILED" : null,
        failure_message: status === "failed" ? "Connector fetch failed" : null,
        failure_phase: status === "failed" ? "fetch" : null,
        // ISO strings: drizzle() makes the shared client's date serializers transparent.
        geindigd: new Date(gestart.getTime() + 60_000).toISOString(),
        gestart: gestart.toISOString(),
        id: crypto.randomUUID(),
        status,
      };
    });
    fixture.runIdsByBron.set(
      bronId,
      runs.map((run) => run.id)
    );
    // oxlint-disable-next-line no-await-in-loop -- sequential fixture build
    await client`INSERT INTO curated.scrape_run ${client(runs)}`;
    const runIdAt = (runIndex: number): string => {
      const run = runs.at(runIndex);
      if (!run) {
        throw new RangeError(`no run ${runIndex}`);
      }
      return run.id;
    };
    const records: RecordRow[] = [];
    const observations: ObservationRow[] = [];
    const aanvragen: AanvraagRow[] = [];
    for (
      let recordIndex = 0;
      recordIndex < RECORDS_PER_BRON;
      recordIndex += 1
    ) {
      const recordId = crypto.randomUUID();
      const bronReferentie = `parity-${bronIndex}-${recordIndex}`;
      const firstRun = Math.floor(random() * 4);
      let version = 0;
      let seen = 0;
      const versions: string[] = [];
      for (let runIndex = firstRun; runIndex < RUNS_PER_BRON; runIndex += 1) {
        if (random() < 0.15) {
          continue;
        }
        if (seen > 0 && random() < 0.2) {
          version += 1;
        }
        const contentHash = `${bronReferentie}:v${version}`;
        const firstOfVersion = !versions.includes(contentHash);
        versions.push(contentHash);
        const id = crypto.randomUUID();
        const payload = {
          bronReferentie,
          contentHash,
          nested: { run: runIndex, tags: ["a", "b"] },
        };
        fixture.payloadById.set(id, payload);
        observations.push({
          bron_id: bronId,
          content_hash: contentHash,
          id,
          outcome: outcomeFor(seen, firstOfVersion),
          payload: JSON.stringify(payload),
          scrape_run_id: runIdAt(runIndex),
          source_record_id: recordId,
          status:
            random() < 0.5
              ? pick(RECOVERABLE_STATUSES)
              : pick(OBSERVATION_STATUSES),
        });
        seen += 1;
      }
      records.push({
        bron_id: bronId,
        bron_referentie: bronReferentie,
        content_hash: `${bronReferentie}:v${version}`,
        id: recordId,
        raw_payload_ref: `raw/${bronReferentie}`,
        scrape_run_id: runIdAt(firstRun),
      });
      const aanvraagDraw = random();
      if (aanvraagDraw < 0.9) {
        aanvragen.push({
          beschrijving: "parity",
          bron_id: bronId,
          bron_referentie: bronReferentie,
          // Mostly the current version; some stale, so the content join filters.
          content_hash:
            aanvraagDraw < 0.75
              ? `${bronReferentie}:v${version}`
              : `${bronReferentie}:v${Math.max(0, version - 1)}`,
          eerste_gezien_op: new Date(BASE_TIME).toISOString(),
          extractie_methode: "json-ld",
          laatst_gezien_op: new Date(BASE_TIME).toISOString(),
          raw_payload_ref: `raw/${bronReferentie}`,
          scrape_run_id: runIdAt(firstRun),
          status: aanvraagDraw < 0.8 ? "active" : "closed",
          titel: "parity",
        });
      }
    }
    // oxlint-disable-next-line no-await-in-loop -- sequential fixture build
    await client`INSERT INTO staging.source_record ${client(records)}`;
    // oxlint-disable-next-line no-await-in-loop -- sequential fixture build
    await client`INSERT INTO staging.aanvraag_observation ${client(observations)}`;
    // oxlint-disable-next-line no-await-in-loop -- sequential fixture build
    await client`INSERT INTO curated.aanvraag ${client(aanvragen)}`;
  }
  return fixture;
};

const seedTieFixture = async (client: postgres.Sql): Promise<TieFixture> => {
  const bronId = crypto.randomUUID();
  const recordId = crypto.randomUUID();
  const contentHash = "tie-break-content";
  const bronReferentie = "tie-break";
  const earlierRunId = crypto.randomUUID();
  const firstSiblingRunId = crypto.randomUUID();
  const secondSiblingRunId = crypto.randomUUID();
  const dominatedId = crypto.randomUUID();
  const firstSiblingId = crypto.randomUUID();
  const secondSiblingId = crypto.randomUUID();
  const earlierStarted = "2026-09-10T00:00:00.000Z";
  const siblingStarted = "2026-09-11T00:00:00.000Z";

  await client`INSERT INTO curated.bron (id, naam, categorie)
    VALUES (${bronId}, ${`dominated-tie-${bronId}`}, 'parity')`;
  await client`INSERT INTO curated.scrape_run ${client([
    {
      bron_id: bronId,
      completion: "complete",
      geindigd: "2026-09-10T00:01:00.000Z",
      gestart: earlierStarted,
      id: earlierRunId,
      status: "succeeded",
    },
    {
      bron_id: bronId,
      completion: "complete",
      geindigd: "2026-09-11T00:01:00.000Z",
      gestart: siblingStarted,
      id: firstSiblingRunId,
      status: "succeeded",
    },
    {
      bron_id: bronId,
      completion: "complete",
      geindigd: "2026-09-11T00:02:00.000Z",
      gestart: siblingStarted,
      id: secondSiblingRunId,
      status: "succeeded",
    },
  ])}`;
  const record: RecordRow = {
    bron_id: bronId,
    bron_referentie: bronReferentie,
    content_hash: contentHash,
    id: recordId,
    raw_payload_ref: `raw/${bronReferentie}`,
    scrape_run_id: earlierRunId,
  };
  const observations: ObservationRow[] = [
    {
      bron_id: bronId,
      content_hash: contentHash,
      id: dominatedId,
      outcome: "unchanged",
      payload: JSON.stringify({ bronReferentie, contentHash, variant: "old" }),
      scrape_run_id: earlierRunId,
      source_record_id: recordId,
      status: "pending",
    },
    {
      bron_id: bronId,
      content_hash: contentHash,
      id: firstSiblingId,
      outcome: "unchanged",
      payload: JSON.stringify({
        bronReferentie,
        contentHash,
        variant: "first-sibling",
      }),
      scrape_run_id: firstSiblingRunId,
      source_record_id: recordId,
      status: "curated",
    },
    {
      bron_id: bronId,
      content_hash: contentHash,
      id: secondSiblingId,
      outcome: "unchanged",
      payload: JSON.stringify({
        bronReferentie,
        contentHash,
        variant: "second-sibling",
      }),
      scrape_run_id: secondSiblingRunId,
      source_record_id: recordId,
      status: "curated",
    },
  ];
  const aanvraagRow: AanvraagRow = {
    beschrijving: "tie-break",
    bron_id: bronId,
    bron_referentie: bronReferentie,
    content_hash: contentHash,
    eerste_gezien_op: earlierStarted,
    extractie_methode: "json-ld",
    laatst_gezien_op: siblingStarted,
    raw_payload_ref: record.raw_payload_ref,
    scrape_run_id: earlierRunId,
    status: "active",
    titel: "tie-break",
  };
  await client`INSERT INTO staging.source_record ${client([record])}`;
  await client`INSERT INTO staging.aanvraag_observation ${client(observations)}`;
  await client`INSERT INTO curated.aanvraag ${client([aanvraagRow])}`;

  return {
    bronId,
    dominatedId,
    siblingIds: [firstSiblingId, secondSiblingId],
  };
};

describe
  .skipIf(!postgresAvailable)
  .serial(
    "selectDominatedPairs parity with the legacy DISTINCT ON sweep",
    () => {
      let client: ReturnType<typeof postgres>;
      let database: BronRuntimeDatabase;
      let fixture: Fixture;
      let tieFixture: TieFixture;

      beforeAll(async () => {
        client = postgres(migratorUrl, { max: 1, onnotice: () => {} });
        await migrate(drizzle(client), { migrationsFolder });
        database = drizzle(client, { schema });
        fixture = await seedFixture(client);
        tieFixture = await seedTieFixture(client);
        await client`ANALYZE staging.aanvraag_observation`;
      });

      afterAll(async () => {
        if (fixture) {
          const bronIds = [...fixture.bronIds, tieFixture.bronId];
          await client`DELETE FROM curated.aanvraag WHERE bron_id IN ${client(bronIds)}`;
          await client`DELETE FROM curated.bron WHERE id IN ${client(bronIds)}`;
        }
        await client.end({ timeout: 5 });
      });

      const inputs = () =>
        fixture.bronIds.flatMap((bronId) =>
          [["succeeded"], ALL_ELIGIBLE].flatMap((eligibleRunStatuses) =>
            [10_000, 7, 1].flatMap((limit) => [
              { bronId, eligibleRunStatuses, limit },
              ...(fixture.runIdsByBron.get(bronId) ?? []).map(
                (scrapeRunId) => ({
                  bronId,
                  eligibleRunStatuses,
                  limit,
                  scrapeRunId,
                })
              ),
            ])
          )
        );

      it("returns exactly the legacy rows for every bron, run scope, eligibility and limit", async () => {
        let compared = 0;
        for (const input of inputs()) {
          // oxlint-disable-next-line no-await-in-loop -- one comparison at a time keeps failures readable
          const [legacy, rewritten] = await Promise.all([
            legacyDominatedPairs(database, input),
            selectDominatedPairs(database, input),
          ]);
          expect({ input, rows: rewritten }).toEqual({ input, rows: legacy });
          compared += legacy.length;
        }
        expect(compared).toBeGreaterThan(0);
      });

      it("covers applied and not-yet-applied dominators and returns parsed payloads", async () => {
        const perBron = await Promise.all(
          fixture.bronIds.map((bronId) =>
            selectDominatedPairs(database, {
              bronId,
              eligibleRunStatuses: ALL_ELIGIBLE,
              limit: 10_000,
            })
          )
        );
        const pairs = perBron.flat();
        expect(pairs.length).toBeGreaterThanOrEqual(50);
        const statuses = new Set(pairs.map((pair) => pair.dominatorStatus));
        expect(APPLIED_STATUSES.some((status) => statuses.has(status))).toBe(
          true
        );
        expect(
          ["awaiting_curation", "pending", "blocked_ordering"].some((status) =>
            statuses.has(status)
          )
        ).toBe(true);
        for (const pair of pairs) {
          expect(pair.dominatorPayload).toEqual(
            fixture.payloadById.get(pair.dominatorId)
          );
        }
      });

      it("returns no pairs when no run statuses are eligible", async () => {
        const input = {
          bronId: fixture.bronIds[0] ?? "missing-bron",
          eligibleRunStatuses: [],
          limit: 10_000,
        };
        const [legacy, rewritten] = await Promise.all([
          legacyDominatedPairs(database, input),
          selectDominatedPairs(database, input),
        ]);
        expect(legacy).toEqual([]);
        expect(rewritten).toEqual([]);
      });

      it("uses the greater id to break equal-start tie dominators", async () => {
        const input = {
          bronId: tieFixture.bronId,
          eligibleRunStatuses: ["succeeded"],
          limit: 10,
        };
        const [legacy, rewritten] = await Promise.all([
          legacyDominatedPairs(database, input),
          selectDominatedPairs(database, input),
        ]);
        // Lowercase uuid strings sort like Postgres uuid ordering.
        const [greaterSiblingId] = tieFixture.siblingIds
          .toSorted()
          .toReversed();
        expect(rewritten).toHaveLength(1);
        expect(rewritten[0]?.id).toBe(tieFixture.dominatedId);
        expect(rewritten[0]?.dominatorId).toBe(greaterSiblingId);
        expect(legacy).toHaveLength(1);
        const [legacyPair] = legacy;
        if (!legacyPair) {
          throw new Error("expected a legacy dominated pair");
        }
        expect(tieFixture.siblingIds).toContain(legacyPair.dominatorId);
      });
    }
  );
