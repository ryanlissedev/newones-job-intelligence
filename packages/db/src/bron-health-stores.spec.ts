import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type {
  AlertRecord,
  AlertStore,
  BronHealthRecord,
  BronHealthStore,
} from "@ji/application/registry";
import {
  MemoryAlertStore,
  MemoryBronHealthStore,
} from "@ji/application/registry";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  PostgresAlertStore,
  PostgresBronHealthStore,
} from "./bron-health-stores";
import * as schema from "./schema";
import { bron } from "./schema";

const testDatabaseUrl =
  process.env.DATABASE_TEST_URL ??
  "postgresql://ji_migrator:ji_migrator_local@127.0.0.1:5432/ji_test";
const testDatabaseRequired =
  process.env.REQUIRE_DATABASE_TESTS === "1" ||
  process.env.DATABASE_TEST_URL !== undefined;

const isPostgresAvailable = async (): Promise<boolean> => {
  const probe = postgres(testDatabaseUrl, { connect_timeout: 2, max: 1 });
  try {
    await probe`SELECT 1`;
    await probe.end({ timeout: 1 });
    return true;
  } catch {
    await probe.end({ timeout: 1 }).catch(() => {});
    return false;
  }
};

interface BronHealthFixture {
  readonly bronIdA: string;
  readonly bronIdB: string;
  readonly cleanup?: () => Promise<void>;
  readonly store: BronHealthStore;
}

const runBronHealthStoreContract = (
  suiteName: string,
  createFixture: () => Promise<BronHealthFixture | null>
) => {
  describe(suiteName, () => {
    let fixture: BronHealthFixture | null = null;

    beforeAll(async () => {
      fixture = await createFixture();
    });

    afterAll(async () => {
      await fixture?.cleanup?.();
    });

    it("returns null for an unknown bronId", async () => {
      if (!fixture) {
        expect(fixture).toBeNull();
        return;
      }
      const result = await fixture.store.getByBronId(fixture.bronIdA);
      expect(result).toBeNull();
    });

    it("upserts a new health record and retrieves it", async () => {
      if (!fixture) {
        expect(fixture).toBeNull();
        return;
      }
      const record: BronHealthRecord = {
        bronId: fixture.bronIdA,
        circuitStatus: "closed",
        lastRunAt: new Date("2026-09-01T10:00:00.000Z"),
        lastRunStatus: "succeeded",
        silenceAlertOpen: false,
      };

      const upserted = await fixture.store.upsert(record);
      expect(upserted).toEqual(record);

      const retrieved = await fixture.store.getByBronId(fixture.bronIdA);
      expect(retrieved).toEqual(record);
    });

    it("updates an existing health record on conflict", async () => {
      if (!fixture) {
        expect(fixture).toBeNull();
        return;
      }
      const updatedRecord: BronHealthRecord = {
        bronId: fixture.bronIdA,
        circuitStatus: "open",
        lastRunAt: new Date("2026-09-02T12:00:00.000Z"),
        lastRunStatus: "failed",
        silenceAlertOpen: true,
      };

      const upserted = await fixture.store.upsert(updatedRecord);
      expect(upserted).toEqual(updatedRecord);

      const retrieved = await fixture.store.getByBronId(fixture.bronIdA);
      expect(retrieved).toEqual(updatedRecord);
    });

    it("handles nullable lastRunAt and lastRunStatus", async () => {
      if (!fixture) {
        expect(fixture).toBeNull();
        return;
      }
      const nullRecord: BronHealthRecord = {
        bronId: fixture.bronIdA,
        circuitStatus: "closed",
        lastRunAt: null,
        lastRunStatus: null,
        silenceAlertOpen: false,
      };

      const upserted = await fixture.store.upsert(nullRecord);
      expect(upserted).toEqual(nullRecord);

      const retrieved = await fixture.store.getByBronId(fixture.bronIdA);
      expect(retrieved).toEqual(nullRecord);
    });

    it("lists all persisted records across distinct bronIds", async () => {
      if (!fixture) {
        expect(fixture).toBeNull();
        return;
      }
      const recordB: BronHealthRecord = {
        bronId: fixture.bronIdB,
        circuitStatus: "half-open",
        lastRunAt: new Date("2026-09-03T15:00:00.000Z"),
        lastRunStatus: "running",
        silenceAlertOpen: false,
      };

      await fixture.store.upsert(recordB);

      const list = await fixture.store.list();
      expect(list.length).toBeGreaterThanOrEqual(2);
      const ids = list.map((item) => item.bronId);
      expect(ids).toContain(fixture.bronIdA);
      expect(ids).toContain(fixture.bronIdB);
    });
  });
};

interface AlertFixture {
  readonly bronId: string;
  readonly cleanup?: () => Promise<void>;
  readonly store: AlertStore;
}

const runAlertStoreContract = (
  suiteName: string,
  createFixture: () => Promise<AlertFixture | null>
) => {
  describe(suiteName, () => {
    let fixture: AlertFixture | null = null;

    beforeAll(async () => {
      fixture = await createFixture();
    });

    afterAll(async () => {
      await fixture?.cleanup?.();
    });

    it("returns null for an unknown alertId", async () => {
      if (!fixture) {
        expect(fixture).toBeNull();
        return;
      }
      const result = await fixture.store.getById(
        "00000000-0000-0000-0000-000000000000"
      );
      expect(result).toBeNull();
    });

    it("creates an alert with generated id, timestamps, and open state", async () => {
      if (!fixture) {
        expect(fixture).toBeNull();
        return;
      }
      const created = await fixture.store.create({
        bronId: fixture.bronId,
        dedupeKey: `silence:${fixture.bronId}:1`,
        evidence: { ratio: 0.2 },
        kind: "bron.stil",
        message: "Source volume dropped",
      });

      expect(created.id).toBeDefined();
      expect(created.bronId).toBe(fixture.bronId);
      expect(created.dedupeKey).toBe(`silence:${fixture.bronId}:1`);
      expect(created.kind).toBe("bron.stil");
      expect(created.message).toBe("Source volume dropped");
      expect(created.evidence).toEqual({ ratio: 0.2 });
      expect(created.ackedAt).toBeNull();
      expect(created.ackedBy).toBeNull();
      expect(created.createdAt).toBeInstanceOf(Date);

      const fetched = await fixture.store.getById(created.id);
      expect(fetched).toEqual(created);
    });

    it("creates an alert with explicit id if supplied", async () => {
      if (!fixture) {
        expect(fixture).toBeNull();
        return;
      }
      const explicitId = "30000000-0000-4000-8000-000000000030";
      const created = await fixture.store.create({
        bronId: fixture.bronId,
        dedupeKey: `silence:${fixture.bronId}:explicit`,
        evidence: { test: true },
        id: explicitId,
        kind: "bron.stil",
        message: "Explicit id alert",
      });

      expect(created.id).toBe(explicitId);
      const fetched = await fixture.store.getById(explicitId);
      expect(fetched?.id).toBe(explicitId);
    });

    it("finds open alerts by dedupeKey", async () => {
      if (!fixture) {
        expect(fixture).toBeNull();
        return;
      }
      const dedupeKey = `silence:${fixture.bronId}:find-open`;
      const created = await fixture.store.create({
        bronId: fixture.bronId,
        dedupeKey,
        evidence: { count: 0 },
        kind: "bron.stil",
        message: "Find open test",
      });

      const found = await fixture.store.findOpenByDedupeKey(dedupeKey);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);

      const missing = await fixture.store.findOpenByDedupeKey(
        "silence:non-existent"
      );
      expect(missing).toBeNull();
    });

    it("lists open alerts", async () => {
      if (!fixture) {
        expect(fixture).toBeNull();
        return;
      }
      const open = await fixture.store.listOpen();
      expect(open.length).toBeGreaterThanOrEqual(1);
      expect(open.every((record: AlertRecord) => record.ackedAt === null)).toBe(
        true
      );
    });

    it("acknowledges an open alert and prevents subsequent acknowledgments", async () => {
      if (!fixture) {
        expect(fixture).toBeNull();
        return;
      }
      const dedupeKey = `silence:${fixture.bronId}:ack-test`;
      const created = await fixture.store.create({
        bronId: fixture.bronId,
        dedupeKey,
        evidence: { value: 123 },
        kind: "bron.stil",
        message: "To be acknowledged",
      });

      const acked = await fixture.store.ack(created.id, "operator-42");
      expect(acked).not.toBeNull();
      expect(acked?.ackedAt).toBeInstanceOf(Date);
      expect(acked?.ackedBy).toBe("operator-42");

      const secondAck = await fixture.store.ack(created.id, "operator-99");
      expect(secondAck).toBeNull();

      const openAfterAck = await fixture.store.findOpenByDedupeKey(dedupeKey);
      expect(openAfterAck).toBeNull();

      const listAfterAck = await fixture.store.listOpen();
      expect(listAfterAck.some((item) => item.id === created.id)).toBe(false);

      const fetchedAcked = await fixture.store.getById(created.id);
      expect(fetchedAcked?.ackedAt).toBeInstanceOf(Date);
      expect(fetchedAcked?.ackedBy).toBe("operator-42");
    });

    it("returns null when acknowledging non-existent alert", async () => {
      if (!fixture) {
        expect(fixture).toBeNull();
        return;
      }
      const result = await fixture.store.ack(
        "00000000-0000-0000-0000-000000000099",
        "operator-1"
      );
      expect(result).toBeNull();
    });
  });
};

runBronHealthStoreContract("MemoryBronHealthStore contract", () =>
  Promise.resolve({
    bronIdA: "40000000-0000-4000-8000-000000000001",
    bronIdB: "40000000-0000-4000-8000-000000000002",
    store: new MemoryBronHealthStore(),
  })
);

runAlertStoreContract("MemoryAlertStore contract", () =>
  Promise.resolve({
    bronId: "40000000-0000-4000-8000-000000000001",
    store: new MemoryAlertStore(),
  })
);

let postgresAvailable = false;
let sqlClient: ReturnType<typeof postgres> | undefined;

describe("Postgres store contract suites", () => {
  beforeAll(async () => {
    postgresAvailable = await isPostgresAvailable();
    if (!postgresAvailable) {
      if (testDatabaseRequired) {
        throw new Error("Required test database is unavailable");
      }
      return;
    }
    sqlClient = postgres(testDatabaseUrl, { max: 2 });
  });

  afterAll(async () => {
    await sqlClient?.end({ timeout: 5 });
  });

  runBronHealthStoreContract("PostgresBronHealthStore contract", async () => {
    if (!postgresAvailable || !sqlClient) {
      return null;
    }
    const db = drizzle(sqlClient, { schema });
    const bronIdA = crypto.randomUUID();
    const bronIdB = crypto.randomUUID();

    await db.insert(bron).values([
      {
        categorie: "overheidsportaal",
        id: bronIdA,
        naam: `Bron Health Test A ${bronIdA.slice(0, 6)}`,
        status: "ready",
        voorwaardenStatus: "toegestaan",
      },
      {
        categorie: "overheidsportaal",
        id: bronIdB,
        naam: `Bron Health Test B ${bronIdB.slice(0, 6)}`,
        status: "ready",
        voorwaardenStatus: "toegestaan",
      },
    ]);

    return {
      bronIdA,
      bronIdB,
      cleanup: async () => {
        // Table cascades on bron deletion
      },
      store: new PostgresBronHealthStore(db),
    };
  });

  runAlertStoreContract("PostgresAlertStore contract", async () => {
    if (!postgresAvailable || !sqlClient) {
      return null;
    }
    const db = drizzle(sqlClient, { schema });
    const bronId = crypto.randomUUID();

    await db.insert(bron).values({
      categorie: "overheidsportaal",
      id: bronId,
      naam: `Bron Alert Test ${bronId.slice(0, 6)}`,
      status: "ready",
      voorwaardenStatus: "toegestaan",
    });

    return {
      bronId,
      cleanup: async () => {
        // Table cascades on bron deletion
      },
      store: new PostgresAlertStore(db),
    };
  });
});
