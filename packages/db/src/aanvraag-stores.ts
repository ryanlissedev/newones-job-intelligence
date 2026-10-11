/* oxlint-disable max-classes-per-file -- cohesive Postgres adapters share schema mapping */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- curated JSON is normalised before persistence */
import {
  applyEnrichmentOverlayToAanvraagFacts,
  applyEnrichmentOverlayToSearchFacts,
} from "@ji/application/enrichment";
import type { TitleFallbackDescriptionParts } from "@ji/application/enrichment";
import {
  parseWeeklyHoursRange,
  toValidPublicationDate,
} from "@ji/application/normalise";
import type {
  AanvraagRecord,
  AanvraagStore,
  AanvraagVersieRecord,
  RawPayloadRecord,
  RawPayloadStore,
} from "@ji/application/registry";
import {
  contactpersoonBeleidVoor,
  contactpersonenBinnenRetentie,
  SOURCES,
} from "@ji/application/sources";
import type { ObjectStore } from "@ji/connectors";
import type { AanvraagLifecycle, Contactpersoon } from "@ji/domain";
import type { BulkSearchDocumentLoader, SearchDocument } from "@ji/search";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";

import { readAanvraagBronFacts } from "./aanvraag-read-mapping";
import type { AanvraagBronFacts } from "./aanvraag-read-mapping";
import type { BronRuntimeDatabase } from "./bron-runtime";
import { PostgresEnrichmentStore } from "./enrichment-store";
import { aanvraag, aanvraagVersie } from "./schema/curated";

const previewText = (body: Uint8Array, limit = 240): string => {
  const text = new TextDecoder().decode(body).replaceAll(/\s+/gu, " ").trim();
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 1)}…`;
};

type AanvraagRow = typeof aanvraag.$inferSelect;

const titleFallbackParts = (
  row: AanvraagRow
): TitleFallbackDescriptionParts | null => {
  if (
    typeof row.bronSpecifiek !== "object" ||
    row.bronSpecifiek === null ||
    Array.isArray(row.bronSpecifiek)
  ) {
    return null;
  }
  const record = row.bronSpecifiek as Record<string, unknown>;
  const platform = record.v1_platform ?? record.platform;
  return typeof platform === "string" && platform.trim() !== ""
    ? {
        externalId: row.bronReferentie,
        platform,
        title: row.titel,
      }
    : null;
};

/**
 * Field resolution shared by the read model and the search projection:
 * curated column first, then the bron-fact fallback.
 */
const resolveCuratedFields = (
  row: AanvraagRow,
  bronFacts: AanvraagBronFacts
) => ({
  contracttype: row.contracttype ?? bronFacts.contracttype,
  // locatie_land defaults to NL and is therefore not proof of a published
  // location; preserve an explicitly unknown location so the country facet
  // does not lie.
  locatie: row.locatieTekst,
  locatieLand: row.locatieTekst === null ? null : row.locatieLand,
  opdrachtgeverNaam: row.opdrachtgeverNaam ?? bronFacts.opdrachtgeverNaam,
  // No curated province column; never derive from locatieTekst — only a
  // canonical name the source itself published.
  provincie: bronFacts.provincie,
  publicatiedatum:
    toValidPublicationDate(row.publicatiedatum) ?? bronFacts.publicatiedatum,
  skills: bronFacts.skills,
  startDatum: row.startDatum ?? bronFacts.startDatum,
  tariefMax: row.tariefMax === null ? null : Number(row.tariefMax),
  tariefMin: row.tariefMin === null ? null : Number(row.tariefMin),
  werkvorm: row.werkvorm ?? bronFacts.werkvorm,
});

/** CTP-610: the stored jsonb is written from `Contactpersoon[]` at curate
 * time; the bron's contactpersoon_beleid retention window is applied on the
 * read path so a policy change takes effect without rewriting rows. */
/** bron_id (uuid) → source slug for the contactpersoon_beleid lookup; an
 * unregistered bron falls through to the default policy. */
const SLUG_BY_BRON_ID = new Map<string, string>(
  Object.values(SOURCES).map((definition) => [
    definition.bronId,
    definition.slug,
  ])
);

const readContactpersonen = (row: AanvraagRow): Contactpersoon[] => {
  const stored = Array.isArray(row.contactpersonen)
    ? (row.contactpersonen as Contactpersoon[])
    : [];
  const beleid = contactpersoonBeleidVoor(
    SLUG_BY_BRON_ID.get(row.bronId) ?? ""
  );
  return contactpersonenBinnenRetentie(
    stored,
    row.laatstGezienOp,
    beleid.retentieDagen
  );
};

const toAanvraagRecord = (
  row: AanvraagRow,
  versies: readonly AanvraagVersieRecord[]
): AanvraagRecord => {
  const bronFacts = readAanvraagBronFacts(row.bronSpecifiek);
  return {
    ...resolveCuratedFields(row, bronFacts),
    beschrijving: row.beschrijving,
    bronId: row.bronId,
    bronReferentie: row.bronReferentie,
    bronUrl: row.bronUrl,
    contactpersonen: readContactpersonen(row),
    dedupGroepId: row.dedupGroepId,
    duur: bronFacts.duur,
    eindDatum: row.eindDatum,
    enrichedFields: [],
    id: row.id,
    opleidingsniveau: bronFacts.opleidingsniveau,
    rawPayloadRef: row.rawPayloadRef,
    scrapeRunId: row.scrapeRunId,
    sluitingsdatum: row.sluitingsdatum,
    status: row.status,
    tariefEenheid: row.tariefEenheid,
    tariefValuta:
      row.tariefEenheid === null &&
      row.tariefMax === null &&
      row.tariefMin === null
        ? null
        : row.tariefValuta,
    titel: row.titel,
    titleFallbackParts: titleFallbackParts(row),
    urenPerWeek: row.urenPerWeek,
    versies,
  };
};

const versieColumns = {
  geldigTot: aanvraagVersie.geldigTot,
  geldigVan: aanvraagVersie.geldigVan,
  id: aanvraagVersie.id,
  scrapeRunId: aanvraagVersie.scrapeRunId,
  versie: aanvraagVersie.versie,
};

type VersieRow = Pick<
  typeof aanvraagVersie.$inferSelect,
  keyof typeof versieColumns
>;

const toAanvraagVersie = (row: VersieRow): AanvraagVersieRecord => ({
  geldigTot: row.geldigTot,
  geldigVan: row.geldigVan,
  id: row.id,
  normalisatieversie: String(row.versie),
  scrapeRunId: row.scrapeRunId,
});

/** Chain guard for superseded_by: the mark scripts point at a live row, so 1 hop is the norm. */
const MAX_SUPERSEDE_HOPS = 5;

export class PostgresAanvraagStore implements AanvraagStore {
  private readonly database: BronRuntimeDatabase;
  private readonly enrichmentStore: PostgresEnrichmentStore;

  constructor(database: BronRuntimeDatabase) {
    this.database = database;
    this.enrichmentStore = new PostgresEnrichmentStore(database);
  }

  private async applyOverlays(
    records: readonly AanvraagRecord[]
  ): Promise<readonly AanvraagRecord[]> {
    if (records.length === 0) {
      return records;
    }
    const overlays = await this.enrichmentStore.listOverlayRowsForAanvraagIds(
      records.map((record) => record.id)
    );
    return records.map((record) => {
      const rows = overlays.get(record.id) ?? [];
      if (rows.length === 0) {
        return record;
      }
      const overlaid = applyEnrichmentOverlayToAanvraagFacts(record, rows);
      return {
        ...record,
        beschrijving: overlaid.beschrijving ?? record.beschrijving,
        contracttype: overlaid.contracttype,
        eindDatum: overlaid.eindDatum,
        enrichedFields: [...overlaid.enrichedFields],
        locatie: overlaid.locatie,
        opdrachtgeverNaam: overlaid.opdrachtgeverNaam,
        opleidingsniveau: overlaid.opleidingsniveau,
        publicatiedatum: overlaid.publicatiedatum,
        sluitingsdatum: overlaid.sluitingsdatum
          ? new Date(overlaid.sluitingsdatum)
          : null,
        startDatum: overlaid.startDatum,
        tariefEenheid: overlaid.tariefEenheid,
        tariefMax: overlaid.tariefMax,
        tariefMin: overlaid.tariefMin,
        tariefValuta: overlaid.tariefValuta,
        urenPerWeek: overlaid.urenPerWeek,
        werkvorm: overlaid.werkvorm,
      };
    });
  }

  /**
   * Follows `superseded_by` (0033) to the live row a duplicate was merged
   * into, like `findAanvraagByIdentity`. Returns requested id -> live row;
   * ids with no row, or whose chain does not end in a live row within
   * MAX_SUPERSEDE_HOPS, are absent.
   */
  private async resolveLiveRows(
    ids: readonly string[]
  ): Promise<Map<string, AanvraagRow>> {
    const resolved = new Map<string, AanvraagRow>();
    // requested id -> id to look up next
    let pending = new Map(ids.map((id) => [id, id]));
    for (let hop = 0; hop <= MAX_SUPERSEDE_HOPS && pending.size > 0; hop += 1) {
      const lookup = [...new Set(pending.values())];
      // oxlint-disable-next-line no-await-in-loop -- each hop depends on the previous one; bounded by MAX_SUPERSEDE_HOPS
      const rows = await this.database
        .select()
        .from(aanvraag)
        .where(inArray(aanvraag.id, lookup));
      const byId = new Map(rows.map((row) => [row.id, row]));
      const next = new Map<string, string>();
      for (const [requested, current] of pending) {
        const row = byId.get(current);
        if (!row) {
          continue;
        }
        if (row.supersededBy === null) {
          resolved.set(requested, row);
        } else {
          next.set(requested, row.supersededBy);
        }
      }
      pending = next;
    }
    return resolved;
  }

  private async listVersiesFor(
    aanvraagIds: readonly string[]
  ): Promise<Map<string, AanvraagVersieRecord[]>> {
    const versiesByAanvraagId = new Map<string, AanvraagVersieRecord[]>();
    if (aanvraagIds.length === 0) {
      return versiesByAanvraagId;
    }
    const versieRows = await this.database
      .select({ aanvraagId: aanvraagVersie.aanvraagId, ...versieColumns })
      .from(aanvraagVersie)
      .where(inArray(aanvraagVersie.aanvraagId, [...aanvraagIds]))
      .orderBy(asc(aanvraagVersie.versie));
    for (const row of versieRows) {
      const versies = versiesByAanvraagId.get(row.aanvraagId) ?? [];
      versies.push(toAanvraagVersie(row));
      versiesByAanvraagId.set(row.aanvraagId, versies);
    }
    return versiesByAanvraagId;
  }

  /**
   * Detail read. A superseded id resolves to the live row it was merged
   * into (the returned record carries the live id), so old links and
   * snapshots keep working instead of returning NOT_FOUND.
   */
  async getById(id: string): Promise<AanvraagRecord | null> {
    const resolved = await this.resolveLiveRows([id]);
    const row = resolved.get(id);
    if (!row) {
      return null;
    }
    const versies = await this.listVersies(row.id);
    const [record] = await this.applyOverlays([toAanvraagRecord(row, versies)]);
    return record ?? null;
  }

  /**
   * Batch read (search hydration, compare, export selections). Superseded ids
   * resolve to their live row; the output keeps input order and lists each
   * live row once.
   */
  async getByIds(ids: readonly string[]): Promise<readonly AanvraagRecord[]> {
    if (ids.length === 0) {
      return [];
    }
    const uniqueIds = [...new Set(ids)];
    const resolved = await this.resolveLiveRows(uniqueIds);
    const liveIds = [...new Set([...resolved.values()].map((row) => row.id))];
    const versiesByAanvraagId = await this.listVersiesFor(liveIds);
    const records: AanvraagRecord[] = [];
    const emitted = new Set<string>();
    for (const id of uniqueIds) {
      const row = resolved.get(id);
      if (!row || emitted.has(row.id)) {
        continue;
      }
      emitted.add(row.id);
      records.push(
        toAanvraagRecord(row, versiesByAanvraagId.get(row.id) ?? [])
      );
    }
    return this.applyOverlays(records);
  }

  async listVersies(
    aanvraagId: string
  ): Promise<readonly AanvraagVersieRecord[]> {
    const rows = await this.database
      .select(versieColumns)
      .from(aanvraagVersie)
      .where(eq(aanvraagVersie.aanvraagId, aanvraagId))
      .orderBy(asc(aanvraagVersie.versie));
    return rows.map(toAanvraagVersie);
  }
}

export class PostgresRawPayloadStore implements RawPayloadStore {
  private readonly objectStore: ObjectStore;

  constructor(objectStore: ObjectStore) {
    this.objectStore = objectStore;
  }

  async getByRef(ref: string): Promise<RawPayloadRecord | null> {
    const stored = await this.objectStore.get(ref);
    if (!stored) {
      return null;
    }
    const full = new TextDecoder().decode(stored.body);
    return {
      contentType: stored.contentType,
      full,
      preview: previewText(stored.body),
      ref,
    };
  }
}

const parsePublicationDate = (value: string | null): Date | null => {
  if (value === null) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed);
};

const toSearchDocument = (row: AanvraagRow): SearchDocument => {
  const bronFacts = readAanvraagBronFacts(row.bronSpecifiek);
  const hours = parseWeeklyHoursRange(row.urenPerWeek);
  const {
    publicatiedatum,
    startDatum: _startDatum,
    ...curated
  } = resolveCuratedFields(row, bronFacts);
  return {
    ...curated,
    beschrijving: row.beschrijving,
    bronId: row.bronId,
    // No first-class curated end-client column yet.
    eindklantNaam: null,
    id: row.id,
    laatstGezienOp: row.laatstGezienOp,
    publicatiedatum: parsePublicationDate(publicatiedatum),
    sluitingsdatum: row.sluitingsdatum ?? undefined,
    // SAFETY: curated.status is constrained to AanvraagLifecycle at write time.
    status: row.status as AanvraagLifecycle,
    tariefEenheid: row.tariefEenheid,
    titel: row.titel,
    urenPerWeekMax: hours.max,
    urenPerWeekMin: hours.min,
  };
};

/**
 * Superseded rows (0033) never load: an upsert event for one is a no-op, the
 * mark scripts enqueue `aanvraag.verwijderd` for every row they mark, and
 * projection repair treats a superseded row still in Manticore as an orphan.
 */
export class PostgresSearchDocumentLoader implements BulkSearchDocumentLoader {
  private readonly database: BronRuntimeDatabase;
  private readonly enrichmentStore: PostgresEnrichmentStore;

  constructor(database: BronRuntimeDatabase) {
    this.database = database;
    this.enrichmentStore = new PostgresEnrichmentStore(database);
  }

  private async withSearchOverlays(
    documents: Map<string, SearchDocument>
  ): Promise<Map<string, SearchDocument>> {
    if (documents.size === 0) {
      return documents;
    }
    const overlays = await this.enrichmentStore.listOverlayRowsForAanvraagIds([
      ...documents.keys(),
    ]);
    for (const [id, document] of documents) {
      const rows = overlays.get(id) ?? [];
      if (rows.length === 0) {
        continue;
      }
      const overlaid = applyEnrichmentOverlayToSearchFacts(document, rows);
      documents.set(id, {
        ...document,
        contracttype: overlaid.contracttype,
        locatie: overlaid.locatie,
        opdrachtgeverNaam: overlaid.opdrachtgeverNaam ?? null,
        sluitingsdatum: overlaid.sluitingsdatum
          ? new Date(overlaid.sluitingsdatum)
          : null,
        tariefEenheid: overlaid.tariefEenheid ?? null,
        tariefMax: overlaid.tariefMax,
        tariefMin: overlaid.tariefMin,
        urenPerWeekMax: overlaid.urenPerWeekMax ?? null,
        urenPerWeekMin: overlaid.urenPerWeekMin ?? null,
        werkvorm: overlaid.werkvorm ?? null,
      });
    }
    return documents;
  }

  async loadByAggregateId(aggregateId: string): Promise<SearchDocument | null> {
    const [row] = await this.database
      .select()
      .from(aanvraag)
      .where(and(eq(aanvraag.id, aggregateId), isNull(aanvraag.supersededBy)))
      .limit(1);
    if (!row) {
      return null;
    }
    const documents = await this.withSearchOverlays(
      new Map([[row.id, toSearchDocument(row)]])
    );
    return documents.get(row.id) ?? null;
  }

  /** One `WHERE id IN (...)` for the whole batch (RJC-389). */
  async loadManyByAggregateIds(
    aggregateIds: readonly string[]
  ): Promise<Map<string, SearchDocument>> {
    const documents = new Map<string, SearchDocument>();
    if (aggregateIds.length === 0) {
      return documents;
    }
    const rows = await this.database
      .select()
      .from(aanvraag)
      .where(
        and(
          inArray(aanvraag.id, [...aggregateIds]),
          isNull(aanvraag.supersededBy)
        )
      );
    for (const row of rows) {
      documents.set(row.id, toSearchDocument(row));
    }
    return this.withSearchOverlays(documents);
  }
}
