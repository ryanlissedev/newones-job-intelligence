/* oxlint-disable max-classes-per-file -- cohesive Postgres adapters share schema mapping */
import type {
  CurateStore,
  StoredAanvraag,
  StoredAanvraagVersie,
  StoredDedupGroep,
  StoredOutboxEvent,
} from "@ji/application/identity";
import type {
  AanvraagId,
  AanvraagLifecycle,
  BronId,
  ScrapeRunId,
} from "@ji/domain";
import { AANVRAAG_LIFECYCLE } from "@ji/domain";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { and, eq, isNull, sql } from "drizzle-orm";
import type {
  PostgresJsDatabase,
  PostgresJsTransaction,
} from "drizzle-orm/postgres-js";

import type * as schema from "./schema";
import { aanvraag, aanvraagVersie, dedupGroep, outboxEvent } from "./schema";

export type PostgresCurateDatabase = PostgresJsDatabase<typeof schema>;
/** A drizzle transaction handle: the same query surface, scoped to one tx. */
export type PostgresCurateTransaction = PostgresJsTransaction<
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;
type PostgresCurateExecutor =
  | PostgresCurateDatabase
  | PostgresCurateTransaction;

const requireRow = <Row>(rows: Row[], description: string): Row => {
  const [row] = rows;
  if (!row) {
    throw new Error(`Unable to ${description}`);
  }
  return row;
};

const toLifecycleStatus = (value: string): AanvraagLifecycle => {
  for (const status of AANVRAAG_LIFECYCLE) {
    if (status === value) {
      return status;
    }
  }
  return "unknown";
};

const emptyProvenance = (): StoredAanvraag["provenance"] => ({
  beschrijving: { parserVersion: "postgres-curate-store", sourcePath: "n/a" },
  bron_referentie: {
    parserVersion: "postgres-curate-store",
    sourcePath: "n/a",
  },
  bron_specifiek: { parserVersion: "postgres-curate-store", sourcePath: "n/a" },
  bron_url: { parserVersion: "postgres-curate-store", sourcePath: "n/a" },
  contactpersonen: {
    parserVersion: "postgres-curate-store",
    sourcePath: "n/a",
  },
  locatie_land: { parserVersion: "postgres-curate-store", sourcePath: "n/a" },
  locatie_tekst: { parserVersion: "postgres-curate-store", sourcePath: "n/a" },
  opdrachtgever_naam: {
    parserVersion: "postgres-curate-store",
    sourcePath: "n/a",
  },
  start_datum: { parserVersion: "postgres-curate-store", sourcePath: "n/a" },
  tarief_eenheid: { parserVersion: "postgres-curate-store", sourcePath: "n/a" },
  tarief_max: { parserVersion: "postgres-curate-store", sourcePath: "n/a" },
  tarief_min: { parserVersion: "postgres-curate-store", sourcePath: "n/a" },
  titel: { parserVersion: "postgres-curate-store", sourcePath: "n/a" },
});

const toStoredDedupGroep = (
  row: typeof dedupGroep.$inferSelect,
  dedupKey: string
): StoredDedupGroep => ({
  dedupGroepId: row.id,
  dedupKey,
  handmatigBevestigd: row.handmatigBevestigd,
  status: "reviewable",
});

const toStoredAanvraag = (
  row: typeof aanvraag.$inferSelect
): StoredAanvraag => ({
  aanvraagId: row.id,
  beschrijving: row.beschrijving,
  bronId: row.bronId,
  bronReferentie: row.bronReferentie,
  // SAFETY: Drizzle jsonb for bron_specifiek matches BronSpecifiekJson at runtime.
  bronSpecifiek: row.bronSpecifiek as StoredAanvraag["bronSpecifiek"],
  bronUrl: row.bronUrl,
  // SAFETY: the jsonb column stores Contactpersoon objects written by the
  // application layer (CTP-610); the shape is the writer's contract.
  contactpersonen: row.contactpersonen as StoredAanvraag["contactpersonen"],
  contentHash: row.contentHash,
  contracttype: row.contracttype,
  dedupGroepId: row.dedupGroepId,
  eersteGezienOp: row.eersteGezienOp,
  eindDatum: row.eindDatum,
  extractieMethode: row.extractieMethode,
  laatstGezienOp: row.laatstGezienOp,
  locatieLand: row.locatieLand,
  locatieTekst: row.locatieTekst,
  opdrachtgeverNaam: row.opdrachtgeverNaam,
  parserVersion: "postgres-curate-store",
  provenance: emptyProvenance(),
  publicatiedatum: row.publicatiedatum,
  rawPayloadRef: row.rawPayloadRef,
  scrapeRunId: row.scrapeRunId,
  sluitingsdatum: row.sluitingsdatum,
  startDatum: row.startDatum,
  status: toLifecycleStatus(row.status),
  tariefEenheid: row.tariefEenheid,
  tariefMax: row.tariefMax,
  tariefMin: row.tariefMin,
  tariefValuta: row.tariefValuta,
  titel: row.titel,
  urenPerWeek: row.urenPerWeek,
  versie: row.versie,
  werkvorm: row.werkvorm,
});

export class PostgresCurateStore implements CurateStore {
  private readonly database: PostgresCurateExecutor;

  constructor(database: PostgresCurateExecutor) {
    this.database = database;
  }

  /**
   * One Postgres transaction per aanvraag mutation (RJC-399): `fn` runs
   * against a store bound to the transaction handle, so close versie,
   * insert versie, update aanvraag and the outbox insert commit together
   * or roll back together. Called on a store already inside a transaction
   * this opens a savepoint (drizzle's nested-transaction behaviour).
   */
  withTransaction<T>(fn: (store: CurateStore) => Promise<T>): Promise<T> {
    return this.database.transaction((tx) => fn(new PostgresCurateStore(tx)));
  }

  /**
   * Exact (bron_id, bron_referentie) first. On a miss, the live row with the
   * same normalized referentie (lower + trim; index
   * aanvraag_bron_referentie_live_uidx, 0034) so a casing/whitespace variant
   * updates the existing aanvraag instead of hitting the unique index. A
   * superseded row (0033) resolves to the row it was merged into.
   */
  async findAanvraagByIdentity(
    bronId: BronId,
    bronReferentie: string
  ): Promise<StoredAanvraag | null> {
    const [exact] = await this.database
      .select()
      .from(aanvraag)
      .where(
        and(
          eq(aanvraag.bronId, bronId),
          eq(aanvraag.bronReferentie, bronReferentie)
        )
      )
      .limit(1);
    const [normalized] = exact
      ? [exact]
      : await this.database
          .select()
          .from(aanvraag)
          .where(
            and(
              eq(aanvraag.bronId, bronId),
              sql`lower(btrim(${aanvraag.bronReferentie})) = lower(btrim(${bronReferentie}))`,
              isNull(aanvraag.supersededBy)
            )
          )
          .limit(1);
    if (!normalized) {
      return null;
    }
    if (normalized.supersededBy === null) {
      return toStoredAanvraag(normalized);
    }
    const [kept] = await this.database
      .select()
      .from(aanvraag)
      .where(eq(aanvraag.id, normalized.supersededBy))
      .limit(1);
    return toStoredAanvraag(kept ?? normalized);
  }

  async findDedupGroepByKey(
    dedupKey: string
  ): Promise<StoredDedupGroep | null> {
    const [row] = await this.database
      .select()
      .from(dedupGroep)
      .where(eq(dedupGroep.dedupKey, dedupKey))
      .limit(1);
    return row ? toStoredDedupGroep(row, dedupKey) : null;
  }

  /**
   * Get-or-create in two statements that are race-free together: the insert
   * targets the partial unique index `dedup_groep_dedup_key_uidx`, so a
   * concurrent transaction inserting the same key blocks until this one
   * commits, then hits the conflict and re-selects the committed row. The
   * re-select runs after the conflict wait, so under READ COMMITTED it sees
   * the winner's row even though this transaction started earlier.
   */
  async ensureDedupGroep(input: {
    dedupKey: string;
  }): Promise<StoredDedupGroep> {
    const inserted = await this.database
      .insert(dedupGroep)
      .values({ dedupKey: input.dedupKey, status: "reviewable" })
      .onConflictDoNothing({
        target: dedupGroep.dedupKey,
        where: sql`${dedupGroep.dedupKey} IS NOT NULL`,
      })
      .returning();
    const [row] = inserted;
    if (row) {
      return toStoredDedupGroep(row, input.dedupKey);
    }
    const existing = await this.findDedupGroepByKey(input.dedupKey);
    if (!existing) {
      // Only reachable if the committed group we conflicted with was deleted
      // (splitDedupGroep) between the conflict and the re-select; a rolled
      // back competitor never gets here, because Postgres then lets our own
      // insert proceed instead of reporting a conflict.
      throw new Error(
        "Unable to resolve dedup_groep after a unique-key conflict"
      );
    }
    return existing;
  }

  async insertAanvraag(
    input: Omit<StoredAanvraag, "aanvraagId">
  ): Promise<StoredAanvraag> {
    const rows = await this.database
      .insert(aanvraag)
      .values({
        beschrijving: input.beschrijving,
        bronId: input.bronId,
        bronReferentie: input.bronReferentie,
        bronSpecifiek: input.bronSpecifiek,
        bronUrl: input.bronUrl,
        contactpersonen: input.contactpersonen,
        contentHash: input.contentHash,
        contracttype: input.contracttype,
        dedupGroepId: input.dedupGroepId,
        eersteGezienOp: input.eersteGezienOp,
        eindDatum: input.eindDatum,
        extractieMethode: input.extractieMethode,
        laatstGezienOp: input.laatstGezienOp,
        locatieLand: input.locatieLand,
        locatieTekst: input.locatieTekst,
        opdrachtgeverNaam: input.opdrachtgeverNaam,
        publicatiedatum: input.publicatiedatum,
        rawPayloadRef: input.rawPayloadRef,
        scrapeRunId: input.scrapeRunId,
        sluitingsdatum: input.sluitingsdatum,
        startDatum: input.startDatum,
        status: input.status,
        tariefEenheid: input.tariefEenheid,
        tariefMax: input.tariefMax,
        tariefMin: input.tariefMin,
        tariefValuta: input.tariefValuta,
        titel: input.titel,
        urenPerWeek: input.urenPerWeek,
        versie: input.versie,
        werkvorm: input.werkvorm,
      })
      .returning();
    return toStoredAanvraag(requireRow(rows, "insert aanvraag"));
  }

  async insertOutboxEvent(
    input: Omit<StoredOutboxEvent, "id">
  ): Promise<StoredOutboxEvent> {
    const rows = await this.database
      .insert(outboxEvent)
      .values({
        aggregateId: input.aggregateId,
        aggregateType: input.aggregateType,
        eventType: input.eventType,
        payload: input.payload,
      })
      .returning();
    const row = requireRow(rows, "insert outbox_event");
    return {
      aggregateId: row.aggregateId,
      aggregateType: "aanvraag",
      eventType: row.eventType,
      id: row.id,
      // SAFETY: Drizzle jsonb payload matches OutboxPayload at runtime.
      payload: row.payload as StoredOutboxEvent["payload"],
    };
  }

  async insertVersie(
    input: Omit<StoredAanvraagVersie, "versieId">
  ): Promise<StoredAanvraagVersie> {
    const rows = await this.database
      .insert(aanvraagVersie)
      .values({
        aanvraagId: input.aanvraagId,
        contentHash: input.contentHash,
        geldigTot: input.geldigTot,
        geldigVan: input.geldigVan,
        rawPayloadRef: input.rawPayloadRef,
        scrapeRunId: input.scrapeRunId,
        snapshot: input.snapshot,
        versie: input.versie,
      })
      .returning();
    const row = requireRow(rows, "insert aanvraag_versie");
    return {
      aanvraagId: row.aanvraagId,
      contentHash: row.contentHash,
      geldigTot: row.geldigTot,
      geldigVan: row.geldigVan,
      rawPayloadRef: row.rawPayloadRef,
      // SAFETY: scrape_run ids persisted through this adapter are UUID scrape runs.
      scrapeRunId: row.scrapeRunId as ScrapeRunId,
      // SAFETY: Drizzle jsonb snapshot matches AanvraagSnapshot at runtime.
      snapshot: row.snapshot as StoredAanvraagVersie["snapshot"],
      versie: row.versie,
      versieId: row.id,
    };
  }

  async linkAanvraagToDedupGroep(
    aanvraagId: AanvraagId,
    dedupGroepId: string
  ): Promise<void> {
    const rows = await this.database
      .update(aanvraag)
      .set({ dedupGroepId })
      .where(eq(aanvraag.id, aanvraagId))
      .returning({ id: aanvraag.id });
    requireRow(rows, "link aanvraag to dedup_groep");
  }

  async splitDedupGroep(dedupGroepId: string): Promise<void> {
    await this.database
      .update(aanvraag)
      .set({ dedupGroepId: null })
      .where(eq(aanvraag.dedupGroepId, dedupGroepId));
    await this.database
      .delete(dedupGroep)
      .where(eq(dedupGroep.id, dedupGroepId));
  }

  async updateAanvraag(
    aanvraagId: AanvraagId,
    patch: Partial<StoredAanvraag>
  ): Promise<StoredAanvraag> {
    const rows = await this.database
      .update(aanvraag)
      .set({
        beschrijving: patch.beschrijving,
        // Keep the stored referentie when the patch only differs in casing or
        // surrounding whitespace: the row may have been found through the
        // normalized or superseded path, and the incoming variant can still be
        // held by a superseded row under the exact unique index.
        bronReferentie:
          patch.bronReferentie === undefined
            ? undefined
            : sql`CASE WHEN lower(btrim(${aanvraag.bronReferentie})) = lower(btrim(${patch.bronReferentie})) THEN ${aanvraag.bronReferentie} ELSE ${patch.bronReferentie} END`,
        bronSpecifiek: patch.bronSpecifiek,
        bronUrl: patch.bronUrl,
        contactpersonen: patch.contactpersonen,
        contentHash: patch.contentHash,
        contracttype: patch.contracttype,
        dedupGroepId: patch.dedupGroepId,
        eersteGezienOp: patch.eersteGezienOp,
        eindDatum: patch.eindDatum,
        extractieMethode: patch.extractieMethode,
        laatstGezienOp: patch.laatstGezienOp,
        locatieLand: patch.locatieLand,
        locatieTekst: patch.locatieTekst,
        opdrachtgeverNaam: patch.opdrachtgeverNaam,
        publicatiedatum: patch.publicatiedatum,
        rawPayloadRef: patch.rawPayloadRef,
        scrapeRunId: patch.scrapeRunId,
        sluitingsdatum: patch.sluitingsdatum,
        startDatum: patch.startDatum,
        status: patch.status,
        tariefEenheid: patch.tariefEenheid,
        tariefMax: patch.tariefMax,
        tariefMin: patch.tariefMin,
        tariefValuta: patch.tariefValuta,
        titel: patch.titel,
        urenPerWeek: patch.urenPerWeek,
        versie: patch.versie,
        werkvorm: patch.werkvorm,
      })
      .where(eq(aanvraag.id, aanvraagId))
      .returning();
    return toStoredAanvraag(requireRow(rows, "update aanvraag"));
  }

  async closeOpenVersie(aanvraagId: AanvraagId, closedAt: Date): Promise<void> {
    await this.database
      .update(aanvraagVersie)
      .set({ geldigTot: closedAt })
      .where(
        and(
          eq(aanvraagVersie.aanvraagId, aanvraagId),
          isNull(aanvraagVersie.geldigTot)
        )
      );
  }
}
