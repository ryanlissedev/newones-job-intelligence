import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { PostgresBronOverlapReader } from "./bron-overlap";
import * as schema from "./schema";
import {
  aanvraag,
  aanvraagBronLink,
  bron,
  dedupGroep,
  scrapeRun,
} from "./schema";

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

const NOW = new Date("2026-09-08T08:00:00.000Z");

describe("PostgresBronOverlapReader", () => {
  let postgresAvailable = false;
  let client: ReturnType<typeof postgres> | undefined;
  let database: PostgresJsDatabase<typeof schema> | undefined;
  let reader: PostgresBronOverlapReader | undefined;

  beforeAll(async () => {
    postgresAvailable = await isPostgresAvailable();
    if (!postgresAvailable) {
      if (testDatabaseRequired) {
        throw new Error("Required test database is unavailable");
      }
      return;
    }
    client = postgres(testDatabaseUrl, { max: 1 });
    database = drizzle(client, { schema });
    reader = new PostgresBronOverlapReader(database);
  });

  afterAll(async () => {
    await client?.end({ timeout: 5 });
  });

  it("counts multi-bron dedup groups, top-10, and per-bron share", async () => {
    if (!(postgresAvailable && database && reader)) {
      expect(postgresAvailable).toBe(false);
      return;
    }

    const bronA = crypto.randomUUID();
    const bronB = crypto.randomUUID();
    const bronC = crypto.randomUUID();
    const runA = crypto.randomUUID();
    const runB = crypto.randomUUID();
    const runC = crypto.randomUUID();
    const multiGroepId = crypto.randomUUID();
    const soloGroepId = crypto.randomUUID();
    const suffix = multiGroepId.slice(0, 8);

    await database.insert(bron).values([
      {
        categorie: "msp_broker",
        id: bronA,
        naam: `CTP417 A ${suffix}`,
        status: "ready",
        voorwaardenStatus: "toegestaan",
      },
      {
        categorie: "msp_broker",
        id: bronB,
        naam: `CTP417 B ${suffix}`,
        status: "ready",
        voorwaardenStatus: "toegestaan",
      },
      {
        categorie: "msp_broker",
        id: bronC,
        naam: `CTP417 C ${suffix}`,
        status: "ready",
        voorwaardenStatus: "toegestaan",
      },
    ]);
    await database.insert(scrapeRun).values([
      { bronId: bronA, id: runA },
      { bronId: bronB, id: runB },
      { bronId: bronC, id: runC },
    ]);
    await database.insert(dedupGroep).values([
      { id: multiGroepId, status: "reviewable" },
      { id: soloGroepId, status: "reviewable" },
    ]);

    const aanvraagA = crypto.randomUUID();
    const aanvraagB = crypto.randomUUID();
    const aanvraagC = crypto.randomUUID();
    const aanvraagAlone = crypto.randomUUID();

    await database.insert(aanvraag).values([
      {
        beschrijving: "beschrijving",
        bronId: bronA,
        bronReferentie: `ref-a-${suffix}`,
        contentHash: `hash-a-${suffix}`,
        dedupGroepId: multiGroepId,
        eersteGezienOp: NOW,
        extractieMethode: "html_parser",
        id: aanvraagA,
        laatstGezienOp: NOW,
        rawPayloadRef: `raw/a-${suffix}.html`,
        scrapeRunId: runA,
        status: "active",
        titel: `titel a ${suffix}`,
        versie: 1,
      },
      {
        beschrijving: "beschrijving",
        bronId: bronB,
        bronReferentie: `ref-b-${suffix}`,
        contentHash: `hash-b-${suffix}`,
        dedupGroepId: multiGroepId,
        eersteGezienOp: NOW,
        extractieMethode: "html_parser",
        id: aanvraagB,
        laatstGezienOp: NOW,
        rawPayloadRef: `raw/b-${suffix}.html`,
        scrapeRunId: runB,
        status: "active",
        titel: `titel b ${suffix}`,
        versie: 1,
      },
      {
        beschrijving: "beschrijving",
        bronId: bronC,
        bronReferentie: `ref-c-solo-${suffix}`,
        contentHash: `hash-c-${suffix}`,
        dedupGroepId: soloGroepId,
        eersteGezienOp: NOW,
        extractieMethode: "html_parser",
        id: aanvraagC,
        laatstGezienOp: NOW,
        rawPayloadRef: `raw/c-${suffix}.html`,
        scrapeRunId: runC,
        status: "active",
        titel: `titel c ${suffix}`,
        versie: 1,
      },
      {
        beschrijving: "beschrijving",
        bronId: bronA,
        bronReferentie: `ref-a-alone-${suffix}`,
        contentHash: `hash-alone-${suffix}`,
        dedupGroepId: null,
        eersteGezienOp: NOW,
        extractieMethode: "html_parser",
        id: aanvraagAlone,
        laatstGezienOp: NOW,
        rawPayloadRef: `raw/alone-${suffix}.html`,
        scrapeRunId: runA,
        status: "active",
        titel: `titel alone ${suffix}`,
        versie: 1,
      },
    ]);

    // Link brings bron C into the multi group without inventing a matching heuristic.
    await database.insert(aanvraagBronLink).values({
      aanvraagId: aanvraagA,
      bronId: bronC,
      bronReferentie: `link-c-${suffix}`,
      isPrimary: false,
    });

    try {
      const result = await reader.bronOverlap();
      expect(result.overlapGroepCount).toBeGreaterThanOrEqual(1);

      const top = result.topGroups.find(
        (group) => group.groepId === multiGroepId
      );
      expect(top).toBeDefined();
      expect(top?.bronCount).toBe(3);
      expect(top?.aanvraagCount).toBe(2);
      expect(new Set(top?.bronIds)).toEqual(new Set([bronA, bronB, bronC]));
      expect(
        result.topGroups.some((group) => group.groepId === soloGroepId)
      ).toBe(false);

      const shareA = result.perBron.find((row) => row.bronId === bronA);
      expect(shareA?.totalAanvragen).toBe(2);
      expect(shareA?.overlappingAanvragen).toBe(1);
      expect(shareA?.share).toBeCloseTo(0.5);

      // Solo-group aanvraag on C does not count as overlap; link-only presence
      // expands the groep's bronnen but does not invent a primary aanvraag on C.
      const shareC = result.perBron.find((row) => row.bronId === bronC);
      expect(shareC?.totalAanvragen).toBe(1);
      expect(shareC?.overlappingAanvragen).toBe(0);
      expect(shareC?.share).toBe(0);
    } finally {
      await database
        .delete(aanvraagBronLink)
        .where(eq(aanvraagBronLink.aanvraagId, aanvraagA));
      await database
        .delete(aanvraag)
        .where(
          inArray(aanvraag.id, [aanvraagA, aanvraagB, aanvraagC, aanvraagAlone])
        );
      await database
        .delete(dedupGroep)
        .where(inArray(dedupGroep.id, [multiGroepId, soloGroepId]));
      await database
        .delete(scrapeRun)
        .where(inArray(scrapeRun.id, [runA, runB, runC]));
      await database
        .delete(bron)
        .where(inArray(bron.id, [bronA, bronB, bronC]));
    }
  });
});
