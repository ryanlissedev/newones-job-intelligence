import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import path from "node:path";

import {
  InMemorySearchEngine,
  projectionHash,
  SearchAdapter,
} from "@ji/search";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import {
  PostgresAanvraagStore,
  PostgresSearchDocumentLoader,
} from "./aanvraag-stores";
import type { BronRuntimeDatabase } from "./bron-runtime";
import { drainPostgresOutbox } from "./outbox-drain";
import * as schema from "./schema";
import {
  aanvraag,
  bron,
  outboxEvent,
  scrapeRun,
  searchProjectionCheckpoint,
  searchProjectionState,
} from "./schema";
import { runSearchReindex } from "./search-reindex";
import { PostgresSearchVersionStore } from "./search-version-store";

const migratorUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
const applicationUrl =
  process.env.DATABASE_APP_TEST_URL ??
  "postgresql://ji_app:ji_app_local@127.0.0.1:5432/ji_test";
const databaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;
const migrationsFolder = path.join(import.meta.dir, "migrations");
const NOW = new Date("2026-09-05T08:00:00.000Z");

interface ContractCase {
  readonly bronSpecifiek: unknown;
  readonly expected: string | null;
  readonly key: string;
}

const CONTRACT_CASES: readonly ContractCase[] = [
  {
    bronSpecifiek: { contracttype: "  canonical-preserved  " },
    expected: "  canonical-preserved  ",
    key: "canonical",
  },
  {
    bronSpecifiek: { contract_type: "detachering" },
    expected: "detachering",
    key: "alias-detachering",
  },
  {
    bronSpecifiek: {
      contract_type: "alias-ignored",
      contracttype: "canonical-priority",
    },
    expected: "canonical-priority",
    key: "both",
  },
  {
    bronSpecifiek: {
      contract_type: "  alias-padded  ",
    },
    expected: "  alias-padded  ",
    key: "alias-padded",
  },
  {
    bronSpecifiek: {
      contract_type: "fallback-from-null",
      contracttype: null,
    },
    expected: "fallback-from-null",
    key: "null-fallback",
  },
  {
    bronSpecifiek: {
      contract_type: "fallback-from-nonstring",
      contracttype: 42,
    },
    expected: "fallback-from-nonstring",
    key: "nonstring-fallback",
  },
  {
    bronSpecifiek: {
      contract_type: "fallback-from-blank",
      contracttype: "\t",
    },
    expected: "fallback-from-blank",
    key: "blank-fallback",
  },
  { bronSpecifiek: {}, expected: null, key: "missing" },
  { bronSpecifiek: { contracttype: null }, expected: null, key: "null" },
  { bronSpecifiek: { contracttype: 42 }, expected: null, key: "nonstring" },
  { bronSpecifiek: { contracttype: "\t" }, expected: null, key: "blank" },
];

const CONTRACT_VALUES = CONTRACT_CASES.flatMap(({ expected }) =>
  expected === null ? [] : [expected]
);

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

type Database = BronRuntimeDatabase;

const seedContractCases = async (
  database: Database
): Promise<Map<string, string>> => {
  const bronId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  await database.insert(bron).values({
    actief: true,
    categorie: "msp_broker",
    crawlDelayMs: 0,
    id: bronId,
    ingestieType: "html",
    interval: "*/15 * * * *",
    naam: `Synthetic contract projection source ${bronId}`,
    rateLimitPerMinute: 600,
    status: "ready",
    voorwaardenStatus: "toegestaan",
  });
  await database.insert(scrapeRun).values({ bronId, id: runId });
  const rows = await database
    .insert(aanvraag)
    .values(
      CONTRACT_CASES.map(({ bronSpecifiek, key }) => ({
        beschrijving: `Synthetic contract projection ${key}`,
        bronId,
        bronReferentie: key,
        bronSpecifiek,
        contentHash: `synthetic-contract-hash-${key}`,
        eersteGezienOp: NOW,
        eindDatum: key === "canonical" ? "2027-02-28" : null,
        extractieMethode: "html_parser",
        laatstGezienOp: NOW,
        opdrachtgeverNaam: null,
        publicatiedatum: null,
        rawPayloadRef: `raw/synthetic-contract/${key}.json`,
        scrapeRunId: runId,
        startDatum: key === "canonical" ? "2026-10-01" : null,
        status: "active",
        tariefEenheid: null,
        titel: `Synthetic contract case ${key}`,
        urenPerWeek: key === "canonical" ? "32" : null,
        versie: 1,
        werkvorm: null,
      }))
    )
    .returning({ bronReferentie: aanvraag.bronReferentie, id: aanvraag.id });
  const ids = new Map<string, string>();
  for (const row of rows) {
    ids.set(row.bronReferentie, row.id);
  }
  return ids;
};

const requireId = (ids: ReadonlyMap<string, string>, key: string): string => {
  const id = ids.get(key);
  if (!id) {
    throw new Error(`Seeded contract case ${key} is missing`);
  }
  return id;
};

describe("Postgres aanvraag search projection contract aliases", () => {
  let available = false;
  let migratorClient: ReturnType<typeof postgres> | undefined;
  let client: ReturnType<typeof postgres> | undefined;
  let database: Database | undefined;
  let isolatedDatabase: Database | undefined;
  let releaseIsolation: (() => void) | undefined;
  let isolation: Promise<void> | undefined;

  beforeAll(async () => {
    available = await isPostgresAvailable();
    if (!available) {
      if (databaseRequired) {
        throw new Error("Required test database is unavailable");
      }
      return;
    }
    migratorClient = postgres(migratorUrl, { max: 1 });
    await migrate(drizzle(migratorClient, { schema }), { migrationsFolder });
    client = postgres(applicationUrl, { max: 1 });
    database = drizzle(client, { schema });
  });

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await migratorClient?.end({ timeout: 5 });
  });

  beforeEach(async () => {
    if (!database) {
      return;
    }
    const ready = Promise.withResolvers<null>();
    const release = Promise.withResolvers<null>();
    releaseIsolation = () => release.resolve(null);
    isolation = (async () => {
      try {
        await database.transaction(
          async (transaction) => {
            await transaction.delete(outboxEvent);
            await transaction.delete(searchProjectionState);
            await transaction.delete(aanvraag);
            await transaction.delete(searchProjectionCheckpoint);
            isolatedDatabase = transaction;
            ready.resolve(null);
            await release.promise;
            throw new Error("rollback isolated contract projection corpus");
          },
          { isolationLevel: "repeatable read" }
        );
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== "rollback isolated contract projection corpus"
        ) {
          ready.reject(error);
          throw error;
        }
      }
    })();
    await ready.promise;
  });

  afterEach(async () => {
    releaseIsolation?.();
    await isolation;
    isolatedDatabase = undefined;
    releaseIsolation = undefined;
    isolation = undefined;
  });

  const requireDatabase = (): Database => {
    if (!isolatedDatabase) {
      throw new Error("isolated database unavailable");
    }
    return isolatedDatabase;
  };

  it("maps canonical, alias, priority, fallback, and unknown values through single and bulk PostgreSQL loads", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    const db = requireDatabase();
    const ids = await seedContractCases(db);
    const loader = new PostgresSearchDocumentLoader(db);
    const aanvraagStore = new PostgresAanvraagStore(db);

    for (const contractCase of CONTRACT_CASES) {
      const id = requireId(ids, contractCase.key);
      // oxlint-disable-next-line no-await-in-loop -- each assertion exercises the loader's single-row query
      const document = await loader.loadByAggregateId(id);
      expect(document?.contracttype).toBe(contractCase.expected);
      // oxlint-disable-next-line no-await-in-loop -- parity is proven against the actual single-row read store
      const record = await aanvraagStore.getById(id);
      expect(record?.contracttype).toBe(contractCase.expected);
      if (contractCase.key === "canonical") {
        expect(record).toMatchObject({
          eindDatum: "2027-02-28",
          startDatum: "2026-10-01",
          urenPerWeek: "32",
        });
      }
    }
    expect(await loader.loadByAggregateId(crypto.randomUUID())).toBeNull();

    const requestedIds = CONTRACT_CASES.map(({ key }) => requireId(ids, key));
    const bulk = await loader.loadManyByAggregateIds([
      ...requestedIds,
      crypto.randomUUID(),
    ]);
    expect(bulk.size).toBe(CONTRACT_CASES.length);
    const records = await aanvraagStore.getByIds(requestedIds);
    const recordsById = new Map(records.map((record) => [record.id, record]));
    for (const contractCase of CONTRACT_CASES) {
      const id = requireId(ids, contractCase.key);
      expect(bulk.get(id)?.contracttype).toBe(contractCase.expected);
      expect(recordsById.get(id)?.contracttype).toBe(contractCase.expected);
    }
  });

  it("reindexes processed alias history into exact contract filters and facets idempotently", async () => {
    if (!available) {
      expect(available).toBe(false);
      return;
    }
    const db = requireDatabase();
    const ids = await seedContractCases(db);
    const loader = new PostgresSearchDocumentLoader(db);
    const indexName = `contract-projection-${crypto.randomUUID()}`;
    const versionStore = new PostgresSearchVersionStore(db, { indexName });
    const checkpoint = await versionStore.read();
    const engine = new InMemorySearchEngine(versionStore, () => NOW);
    const aliasId = requireId(ids, "alias-padded");
    const aliasDocument = await loader.loadByAggregateId(aliasId);
    if (!aliasDocument) {
      throw new Error("Seeded alias document is missing");
    }
    const preFixDocument = { ...aliasDocument, contracttype: null };
    await engine.upsertDocument(preFixDocument);

    const [historical] = await db
      .insert(outboxEvent)
      .values({
        aggregateId: aliasId,
        aggregateType: "aanvraag",
        eventType: "aanvraag.gewijzigd",
        payload: {},
      })
      .returning({
        id: outboxEvent.id,
        sequenceNumber: outboxEvent.sequenceNumber,
      });
    if (!historical) {
      throw new Error("Historical alias event is missing");
    }
    await db
      .update(outboxEvent)
      .set({ processedAt: NOW })
      .where(eq(outboxEvent.id, historical.id));
    await versionStore.advance(historical.sequenceNumber);
    await db.insert(searchProjectionState).values({
      aggregateId: aliasId,
      appliedSequence: historical.sequenceNumber,
      generation: checkpoint.generation,
      projectionHash: projectionHash(preFixDocument, NOW),
    });

    const changedIds = CONTRACT_CASES.filter(
      ({ key }) => key !== "alias-padded"
    ).map(({ key }) => requireId(ids, key));
    await db.insert(outboxEvent).values(
      changedIds.map((aggregateId) => ({
        aggregateId,
        aggregateType: "aanvraag",
        eventType: "aanvraag.gewijzigd",
        payload: {},
      }))
    );
    const initialDrain = await drainPostgresOutbox({
      database: db,
      engine,
      loader,
      versionStore,
    });
    expect(initialDrain).toMatchObject({
      deadLettered: 0,
      drained: changedIds.length,
      failed: 0,
      released: 0,
    });

    const freshAliasSearch = await new SearchAdapter({ engine }).search({
      filters: { contracttype: ["detachering"] },
      query: "",
      scope: "all",
    });
    expect(freshAliasSearch.ok).toBe(true);
    if (!freshAliasSearch.ok) {
      throw new Error("Expected fresh alias search to succeed");
    }
    expect(freshAliasSearch.hits.map(({ id }) => id)).toEqual([
      requireId(ids, "alias-detachering"),
    ]);
    expect(freshAliasSearch.facets.contracttype).toEqual([
      { count: 1, value: "detachering" },
    ]);

    const beforeRefresh = await new SearchAdapter({ engine }).search({
      filters: { contracttype: ["  alias-padded  "] },
      query: "",
      scope: "all",
    });
    expect(beforeRefresh.ok).toBe(true);
    if (!beforeRefresh.ok) {
      throw new Error("Expected pre-refresh search to succeed");
    }
    expect(beforeRefresh.hits).toEqual([]);

    const reindex = await runSearchReindex({
      apply: true,
      database: db,
      force: true,
      indexName,
      pageSize: 2,
    });
    expect(reindex).toMatchObject({
      enqueued: CONTRACT_CASES.length,
      finalized: true,
      scanned: CONTRACT_CASES.length,
    });
    const refreshDrain = await drainPostgresOutbox({
      database: db,
      engine,
      loader,
      versionStore,
    });
    expect(refreshDrain).toMatchObject({
      deadLettered: 0,
      drained: CONTRACT_CASES.length,
      failed: 0,
      released: 0,
    });

    const filteredSearch = await new SearchAdapter({ engine }).search({
      filters: { contracttype: CONTRACT_VALUES },
      limit: CONTRACT_CASES.length,
      query: "",
      scope: "all",
    });
    expect(filteredSearch.ok).toBe(true);
    if (!filteredSearch.ok) {
      throw new Error("Expected filtered search to succeed");
    }
    const expectedIds = CONTRACT_CASES.filter(
      ({ expected }) => expected !== null
    )
      .map(({ key }) => requireId(ids, key))
      .toSorted();
    expect(filteredSearch.hits.map(({ id }) => id).toSorted()).toEqual(
      expectedIds
    );
    expect(filteredSearch.facets.contracttype).toEqual(
      CONTRACT_VALUES.toSorted().map((value) => ({ count: 1, value }))
    );

    const allSearch = await new SearchAdapter({ engine }).search({
      limit: CONTRACT_CASES.length,
      query: "",
      scope: "all",
    });
    expect(allSearch.ok).toBe(true);
    if (!allSearch.ok) {
      throw new Error("Expected unfiltered search to succeed");
    }
    expect(allSearch.facets.contracttype).toContainEqual({
      count: CONTRACT_CASES.length - CONTRACT_VALUES.length,
      value: "unknown",
    });

    const alreadyCurrent = await runSearchReindex({
      apply: true,
      database: db,
      indexName,
    });
    expect(alreadyCurrent).toMatchObject({
      action: "already-current",
      enqueued: 0,
    });
    const emptyDrain = await drainPostgresOutbox({
      database: db,
      engine,
      loader,
      versionStore,
    });
    expect(emptyDrain).toMatchObject({ claimed: 0, drained: 0, failed: 0 });
    const repeatedSearch = await new SearchAdapter({ engine }).search({
      filters: { contracttype: CONTRACT_VALUES },
      limit: CONTRACT_CASES.length,
      query: "",
      scope: "all",
    });
    expect(repeatedSearch).toEqual(filteredSearch);
  });
});
