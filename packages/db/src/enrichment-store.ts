/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- bron_specifiek is validated JSONB at this database I/O boundary; the Motian platform keys are the explicit compatibility contract used for placeholder detection. */
import {
  ENRICHMENT_APPLY_MIN_CONFIDENCE,
  ENRICHMENT_FIELDS,
  ENRICHMENT_OUTBOX_EVENT_TYPE,
  listMissingEnrichmentFields,
  planCuratedEnrichmentPatch,
  planCuratedEnrichmentPatchFromStored,
} from "@ji/application/enrichment";
import type {
  CuratedEnrichmentPatch,
  EnrichmentField,
  EnrichmentOutboxInsertInput,
  EnrichmentOverlayRow,
  EnrichmentProposal,
  TitleFallbackDescriptionParts,
} from "@ji/application/enrichment";
import { closingMomentInstant } from "@ji/application/normalise";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type {
  PostgresJsDatabase,
  PostgresJsTransaction,
} from "drizzle-orm/postgres-js";

import type * as schema from "./schema";
import { aanvraag, aanvraagEnrichment, outboxEvent } from "./schema/curated";

export type EnrichmentDatabase = PostgresJsDatabase<typeof schema>;
type EnrichmentTransaction = PostgresJsTransaction<
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;
type EnrichmentExecutor = EnrichmentDatabase | EnrichmentTransaction;

export interface IncompleteAanvraagCandidate {
  readonly beschrijving: string;
  readonly bronSpecifiek: unknown;
  readonly contracttype: string | null;
  readonly eindDatum: string | null;
  readonly id: string;
  readonly locatieTekst: string | null;
  readonly missingFields: readonly EnrichmentField[];
  readonly opdrachtgeverNaam: string | null;
  readonly publicatiedatum: string | null;
  readonly rawPayloadRef: string;
  readonly sluitingsdatum: string | null;
  readonly startDatum: string | null;
  readonly tariefEenheid: string | null;
  readonly tariefMax: string | null;
  readonly tariefMin: string | null;
  readonly tariefValuta: string | null;
  readonly updatedAt: Date;
  /**
   * Optimistic token for `applyEnrichmentAtomically` (CTP-626): the exact
   * `updated_at` (microseconds, UTC) as read when the candidate was selected.
   * A JS `Date` truncates to milliseconds, so two writes inside one
   * millisecond would look identical to it.
   */
  readonly updatedAtToken: string;
  readonly urenPerWeek: string | null;
  readonly werkvorm: string | null;
  readonly titleFallbackParts: TitleFallbackDescriptionParts | null;
}

export interface AtomicEnrichmentInput {
  readonly aanvraagId: string;
  /** `updatedAtToken` of the candidate as read when it was selected. */
  readonly expectedUpdatedAt: string;
  readonly proposals: readonly EnrichmentProposal[];
}

/**
 * CTP-626. `applied` wrote the proposals, the curated patch and one outbox
 * event in a single transaction. `stale` means the row changed since the
 * candidate was read (a user edit, a curation write, or an earlier attempt
 * of this same job that committed before its ack), so nothing was written.
 * `nothing_to_fill` means the re-read left no fillable gap for the proposed
 * fields (a manual CLEARED or a value filled meanwhile), so nothing was
 * written either.
 */
export type AtomicEnrichmentOutcome =
  | {
      readonly outcome: "applied";
      readonly fields: readonly EnrichmentField[];
      readonly outboxEventId: string;
    }
  | { readonly outcome: "stale" }
  | { readonly outcome: "nothing_to_fill" };

export interface PendingCuratedApplyCandidate {
  readonly beschrijving: string;
  readonly bronSpecifiek: unknown;
  readonly contracttype: string | null;
  readonly eindDatum: string | null;
  readonly id: string;
  readonly locatieTekst: string | null;
  readonly opdrachtgeverNaam: string | null;
  readonly patch: CuratedEnrichmentPatch;
  readonly publicatiedatum: string | null;
  readonly sluitingsdatum: string | null;
  readonly startDatum: string | null;
  readonly tariefEenheid: string | null;
  readonly tariefMax: string | null;
  readonly tariefMin: string | null;
  readonly tariefValuta: string | null;
  readonly urenPerWeek: string | null;
  readonly werkvorm: string | null;
  readonly titleFallbackParts: TitleFallbackDescriptionParts | null;
}

export interface AanvraagEnrichmentRow {
  readonly aanvraagId: string;
  readonly confidence: number;
  readonly createdAt: Date;
  readonly field: EnrichmentField;
  readonly id: string;
  readonly rawRefs: unknown;
  readonly source: string;
  readonly updatedAt: Date;
  readonly value: unknown;
}

const toNumericString = (value: string | null): string | null =>
  value === null ? null : value;

/**
 * `aanvraag.updated_at` rendered with its full microsecond precision in UTC,
 * independent of the session time zone. The optimistic token for CTP-626.
 */
export const aanvraagUpdatedAtToken = sql<string>`to_char(${aanvraag.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const sourcePlatform = (bronSpecifiek: unknown): string | null => {
  if (
    typeof bronSpecifiek !== "object" ||
    bronSpecifiek === null ||
    Array.isArray(bronSpecifiek)
  ) {
    return null;
  }
  const record = bronSpecifiek as Record<string, unknown>;
  const platform = record.v1_platform ?? record.platform;
  return typeof platform === "string" && platform.trim() !== ""
    ? platform
    : null;
};

const titleFallbackParts = (row: {
  readonly bronReferentie: string;
  readonly bronSpecifiek: unknown;
  readonly titel: string;
}): TitleFallbackDescriptionParts | null => {
  const platform = sourcePlatform(row.bronSpecifiek);
  return platform === null
    ? null
    : {
        externalId: row.bronReferentie,
        platform,
        title: row.titel,
      };
};

const titleFallbackSql = sql`
  ${aanvraag.beschrijving} = concat(
    ${aanvraag.titel},
    ' (',
    COALESCE(
      ${aanvraag.bronSpecifiek}->>'v1_platform',
      ${aanvraag.bronSpecifiek}->>'platform'
    ),
    '/',
    ${aanvraag.bronReferentie},
    ')'
  )
`;

/** Rows with at least one gap enrichment may fill; shared by the inline
 * candidate scan and the stored-proposal apply scan. */
const incompleteAanvraagSql = sql`(
  ${aanvraag.locatieTekst} IS NULL
  OR trim(${aanvraag.locatieTekst}) = ''
  OR ${aanvraag.locatieTekst} = 'unknown'
  OR (
    ${aanvraag.tariefMin} IS NULL
    AND ${aanvraag.tariefMax} IS NULL
    AND ${aanvraag.tariefEenheid} IS NULL
  )
  OR COALESCE(
    NULLIF(trim(${aanvraag.contracttype}), ''),
    NULLIF(trim(${aanvraag.bronSpecifiek}->>'contracttype'), ''),
    NULLIF(trim(${aanvraag.bronSpecifiek}->>'contract_type'), '')
  ) IS NULL
  OR COALESCE(
    NULLIF(trim(${aanvraag.werkvorm}), ''),
    NULLIF(trim(${aanvraag.bronSpecifiek}->>'werkvorm'), '')
  ) IS NULL
  OR ${aanvraag.publicatiedatum} IS NULL
  OR trim(${aanvraag.publicatiedatum}) = ''
  OR ${aanvraag.publicatiedatum} = 'unknown'
  OR (${titleFallbackSql})
  OR ${aanvraag.urenPerWeek} IS NULL
  OR trim(${aanvraag.urenPerWeek}) = ''
  OR ${aanvraag.urenPerWeek} = 'unknown'
  OR ${aanvraag.eindDatum} IS NULL
  OR trim(${aanvraag.eindDatum}) = ''
  OR ${aanvraag.eindDatum} = 'unknown'
  OR ${aanvraag.sluitingsdatum} IS NULL
  OR COALESCE(
    NULLIF(trim(${aanvraag.startDatum}), ''),
    NULLIF(trim(${aanvraag.bronSpecifiek}->>'startDatum'), ''),
    NULLIF(trim(${aanvraag.bronSpecifiek}->>'start_datum'), '')
  ) IS NULL
  OR COALESCE(
    NULLIF(trim(${aanvraag.opdrachtgeverNaam}), ''),
    NULLIF(trim(${aanvraag.bronSpecifiek}->>'opdrachtgeverNaam'), ''),
    NULLIF(trim(${aanvraag.bronSpecifiek}->>'opdrachtgever_naam'), '')
  ) IS NULL
  OR COALESCE(
    NULLIF(trim(${aanvraag.bronSpecifiek}->>'opleidingsniveau'), ''),
    NULLIF(trim(${aanvraag.bronSpecifiek}->>'education_level'), '')
  ) IS NULL
)`;

const isEnrichmentField = (field: string): field is EnrichmentField =>
  ENRICHMENT_FIELDS.some((candidate) => candidate === field);

const toEnrichmentField = (field: string): EnrichmentField => {
  if (isEnrichmentField(field)) {
    return field;
  }
  throw new Error(`Unexpected enrichment field: ${field}`);
};

const toOverlayRow = (row: AanvraagEnrichmentRow): EnrichmentOverlayRow => ({
  confidence: row.confidence,
  field: row.field,
  // SAFETY: source column is constrained to EnrichmentSource at write time.
  source: row.source as EnrichmentOverlayRow["source"],
  // SAFETY: jsonb value matches EnrichmentFieldValue at write time.
  value: row.value as EnrichmentOverlayRow["value"],
});

interface IncompleteAanvraagRow {
  readonly beschrijving: string;
  readonly bronReferentie: string;
  readonly bronSpecifiek: unknown;
  readonly contracttype: string | null;
  readonly eindDatum: string | null;
  readonly id: string;
  readonly locatieTekst: string | null;
  readonly opdrachtgeverNaam: string | null;
  readonly publicatiedatum: string | null;
  readonly rawPayloadRef: string;
  readonly sluitingsdatum: Date | null;
  readonly startDatum: string | null;
  readonly tariefEenheid: string | null;
  readonly tariefMax: string | null;
  readonly tariefMin: string | null;
  readonly tariefValuta: string | null;
  readonly titel: string;
  readonly updatedAt: Date;
  readonly updatedAtToken: string;
  readonly urenPerWeek: string | null;
  readonly werkvorm: string | null;
}

const toIncompleteCandidates = (
  rows: readonly IncompleteAanvraagRow[]
): IncompleteAanvraagCandidate[] =>
  rows.flatMap((row) => {
    const missingFields = listMissingEnrichmentFields({
      beschrijving: row.beschrijving,
      bronSpecifiek: row.bronSpecifiek,
      contracttype: row.contracttype,
      eindDatum: row.eindDatum,
      locatieTekst: row.locatieTekst,
      opdrachtgeverNaam: row.opdrachtgeverNaam,
      publicatiedatum: row.publicatiedatum,
      sluitingsdatum: row.sluitingsdatum?.toISOString() ?? null,
      startDatum: row.startDatum,
      tariefEenheid: row.tariefEenheid,
      tariefMax: toNumericString(
        row.tariefMax === null ? null : String(row.tariefMax)
      ),
      tariefMin: toNumericString(
        row.tariefMin === null ? null : String(row.tariefMin)
      ),
      titleFallbackParts: titleFallbackParts(row),
      urenPerWeek: row.urenPerWeek,
      werkvorm: row.werkvorm,
    });
    if (missingFields.length === 0) {
      return [];
    }
    return [
      {
        beschrijving: row.beschrijving,
        bronSpecifiek: row.bronSpecifiek,
        contracttype: row.contracttype,
        eindDatum: row.eindDatum,
        id: row.id,
        locatieTekst: row.locatieTekst,
        missingFields,
        opdrachtgeverNaam: row.opdrachtgeverNaam,
        publicatiedatum: row.publicatiedatum,
        rawPayloadRef: row.rawPayloadRef,
        sluitingsdatum: row.sluitingsdatum?.toISOString() ?? null,
        startDatum: row.startDatum,
        tariefEenheid: row.tariefEenheid,
        tariefMax: toNumericString(
          row.tariefMax === null ? null : String(row.tariefMax)
        ),
        tariefMin: toNumericString(
          row.tariefMin === null ? null : String(row.tariefMin)
        ),
        tariefValuta: row.tariefValuta,
        titleFallbackParts: titleFallbackParts(row),
        updatedAt: row.updatedAt,
        updatedAtToken: row.updatedAtToken,
        urenPerWeek: row.urenPerWeek,
        werkvorm: row.werkvorm,
      },
    ];
  });

const upsertProposalWith = async (
  executor: EnrichmentExecutor,
  aanvraagId: string,
  proposal: EnrichmentProposal
): Promise<AanvraagEnrichmentRow> => {
  const [row] = await executor
    .insert(aanvraagEnrichment)
    .values({
      aanvraagId,
      confidence: String(proposal.confidence),
      field: proposal.field,
      rawRefs: [...proposal.rawRefs],
      source: proposal.source,
      value: proposal.value,
    })
    .onConflictDoUpdate({
      set: {
        confidence: String(proposal.confidence),
        rawRefs: [...proposal.rawRefs],
        source: proposal.source,
        updatedAt: new Date(),
        value: proposal.value,
      },
      target: [aanvraagEnrichment.aanvraagId, aanvraagEnrichment.field],
    })
    .returning();

  if (!row) {
    throw new Error("Enrichment upsert returned no row");
  }

  return {
    aanvraagId: row.aanvraagId,
    confidence: Number(row.confidence),
    createdAt: row.createdAt,
    field: toEnrichmentField(row.field),
    id: row.id,
    rawRefs: row.rawRefs,
    source: row.source,
    updatedAt: row.updatedAt,
    value: row.value,
  };
};

const applyCuratedEnrichmentPatchWith = async (
  executor: EnrichmentExecutor,
  aanvraagId: string,
  patch: CuratedEnrichmentPatch
): Promise<readonly EnrichmentField[]> => {
  if (patch.fields.length === 0) {
    return [];
  }
  const values = {
    updatedAt: new Date(),
  };
  // SAFETY: drizzle update accepts a partial column map; we only assign keys
  // present on CuratedEnrichmentPatch after explicit undefined checks below.
  const setValues = values as typeof values & {
    beschrijving?: string;
    contracttype?: string;
    eindDatum?: string;
    locatieTekst?: string;
    opdrachtgeverNaam?: string;
    publicatiedatum?: string;
    sluitingsdatum?: Date;
    startDatum?: string;
    tariefEenheid?: string;
    tariefMax?: string;
    tariefMin?: string;
    tariefValuta?: string;
    urenPerWeek?: string;
    werkvorm?: string;
  };
  if (patch.beschrijving !== undefined) {
    setValues.beschrijving = patch.beschrijving;
  }
  if (patch.locatieTekst !== undefined) {
    setValues.locatieTekst = patch.locatieTekst;
  }
  if (patch.tariefEenheid !== undefined) {
    setValues.tariefEenheid = patch.tariefEenheid;
  }
  if (patch.tariefMax !== undefined) {
    setValues.tariefMax = patch.tariefMax;
  }
  if (patch.tariefMin !== undefined) {
    setValues.tariefMin = patch.tariefMin;
  }
  if (patch.tariefValuta !== undefined) {
    setValues.tariefValuta = patch.tariefValuta;
  }
  if (patch.contracttype !== undefined) {
    setValues.contracttype = patch.contracttype;
  }
  if (patch.werkvorm !== undefined) {
    setValues.werkvorm = patch.werkvorm;
  }
  if (patch.publicatiedatum !== undefined) {
    setValues.publicatiedatum = patch.publicatiedatum;
  }
  if (patch.urenPerWeek !== undefined) {
    setValues.urenPerWeek = patch.urenPerWeek;
  }
  if (patch.startDatum !== undefined) {
    setValues.startDatum = patch.startDatum;
  }
  if (patch.eindDatum !== undefined) {
    setValues.eindDatum = patch.eindDatum;
  }
  if (patch.opdrachtgeverNaam !== undefined) {
    setValues.opdrachtgeverNaam = patch.opdrachtgeverNaam;
  }
  // The patch carries the extractor's ISO date/datetime string; the
  // timestamptz column stores the closing instant with the same
  // Europe/Amsterdam end-of-day reading the normalisers use.
  if (patch.sluitingsdatum !== undefined) {
    const closing = closingMomentInstant(patch.sluitingsdatum);
    if (closing) {
      setValues.sluitingsdatum = closing;
    }
  }
  await executor
    .update(aanvraag)
    .set(setValues)
    .where(eq(aanvraag.id, aanvraagId));
  return patch.fields;
};

const insertOutboxEventWith = async (
  executor: EnrichmentExecutor,
  input: EnrichmentOutboxInsertInput
): Promise<{ readonly id: string }> => {
  const [row] = await executor
    .insert(outboxEvent)
    .values({
      aggregateId: input.aggregateId,
      aggregateType: input.aggregateType,
      eventType: input.eventType,
      payload: {
        field_count: input.payload.field_count,
        fields: [...input.payload.fields],
      },
    })
    .returning({ id: outboxEvent.id });

  if (!row) {
    throw new Error("Enrichment outbox insert returned no row");
  }
  return { id: row.id };
};

export class PostgresEnrichmentStore {
  private readonly database: EnrichmentDatabase;

  constructor(database: EnrichmentDatabase) {
    this.database = database;
  }

  async listIncomplete(
    limit: number
  ): Promise<readonly IncompleteAanvraagCandidate[]> {
    const rows = await this.database
      .select({
        beschrijving: aanvraag.beschrijving,
        bronReferentie: aanvraag.bronReferentie,
        bronSpecifiek: aanvraag.bronSpecifiek,
        contracttype: aanvraag.contracttype,
        eindDatum: aanvraag.eindDatum,
        id: aanvraag.id,
        locatieTekst: aanvraag.locatieTekst,
        opdrachtgeverNaam: aanvraag.opdrachtgeverNaam,
        publicatiedatum: aanvraag.publicatiedatum,
        rawPayloadRef: aanvraag.rawPayloadRef,
        sluitingsdatum: aanvraag.sluitingsdatum,
        startDatum: aanvraag.startDatum,
        tariefEenheid: aanvraag.tariefEenheid,
        tariefMax: aanvraag.tariefMax,
        tariefMin: aanvraag.tariefMin,
        tariefValuta: aanvraag.tariefValuta,
        titel: aanvraag.titel,
        updatedAt: aanvraag.updatedAt,
        updatedAtToken: aanvraagUpdatedAtToken,
        urenPerWeek: aanvraag.urenPerWeek,
        werkvorm: aanvraag.werkvorm,
      })
      .from(aanvraag)
      .where(incompleteAanvraagSql)
      .limit(limit);
    return toIncompleteCandidates(rows);
  }

  /** One aanvraag as a candidate, or null when it is no longer incomplete (CTP-626 replays). */
  async listIncompleteById(
    aanvraagId: string
  ): Promise<IncompleteAanvraagCandidate | null> {
    const rows = await this.database
      .select({
        beschrijving: aanvraag.beschrijving,
        bronReferentie: aanvraag.bronReferentie,
        bronSpecifiek: aanvraag.bronSpecifiek,
        contracttype: aanvraag.contracttype,
        eindDatum: aanvraag.eindDatum,
        id: aanvraag.id,
        locatieTekst: aanvraag.locatieTekst,
        opdrachtgeverNaam: aanvraag.opdrachtgeverNaam,
        publicatiedatum: aanvraag.publicatiedatum,
        rawPayloadRef: aanvraag.rawPayloadRef,
        sluitingsdatum: aanvraag.sluitingsdatum,
        startDatum: aanvraag.startDatum,
        tariefEenheid: aanvraag.tariefEenheid,
        tariefMax: aanvraag.tariefMax,
        tariefMin: aanvraag.tariefMin,
        tariefValuta: aanvraag.tariefValuta,
        titel: aanvraag.titel,
        updatedAt: aanvraag.updatedAt,
        updatedAtToken: aanvraagUpdatedAtToken,
        urenPerWeek: aanvraag.urenPerWeek,
        werkvorm: aanvraag.werkvorm,
      })
      .from(aanvraag)
      .where(and(eq(aanvraag.id, aanvraagId), incompleteAanvraagSql))
      .limit(1);
    return toIncompleteCandidates(rows)[0] ?? null;
  }

  upsertProposal(
    aanvraagId: string,
    proposal: EnrichmentProposal
  ): Promise<AanvraagEnrichmentRow> {
    return upsertProposalWith(this.database, aanvraagId, proposal);
  }

  /**
   * Persist high-confidence enrichment into curated commercial columns.
   * Provenance stays in aanvraag_enrichment; this only fills first-class columns
   * so search/projector sees them without inventing rates or resurrecting CLEARED.
   */
  applyCuratedEnrichmentPatch(
    aanvraagId: string,
    patch: CuratedEnrichmentPatch
  ): Promise<readonly EnrichmentField[]> {
    return applyCuratedEnrichmentPatchWith(this.database, aanvraagId, patch);
  }

  /**
   * CTP-626: one enrichment lands exactly once. The candidate row is re-read
   * under `FOR UPDATE`, compared against the exact `updated_at` token the
   * caller selected it with, and re-planned against its current facts (so a
   * CLEARED written in the meantime wins). Proposals, curated patch and the
   * outbox event then commit in this single transaction. A replay after a
   * commit that never acked sees a newer `updated_at` and returns `stale`
   * without writing.
   */
  applyEnrichmentAtomically(
    input: AtomicEnrichmentInput
  ): Promise<AtomicEnrichmentOutcome> {
    return this.database.transaction(async (tx) => {
      const [current] = await tx
        .select({
          beschrijving: aanvraag.beschrijving,
          bronReferentie: aanvraag.bronReferentie,
          bronSpecifiek: aanvraag.bronSpecifiek,
          contracttype: aanvraag.contracttype,
          eindDatum: aanvraag.eindDatum,
          locatieTekst: aanvraag.locatieTekst,
          opdrachtgeverNaam: aanvraag.opdrachtgeverNaam,
          publicatiedatum: aanvraag.publicatiedatum,
          sluitingsdatum: aanvraag.sluitingsdatum,
          startDatum: aanvraag.startDatum,
          tariefEenheid: aanvraag.tariefEenheid,
          tariefMax: aanvraag.tariefMax,
          tariefMin: aanvraag.tariefMin,
          tariefValuta: aanvraag.tariefValuta,
          titel: aanvraag.titel,
          updatedAtToken: aanvraagUpdatedAtToken,
          urenPerWeek: aanvraag.urenPerWeek,
          werkvorm: aanvraag.werkvorm,
        })
        .from(aanvraag)
        .where(eq(aanvraag.id, input.aanvraagId))
        .for("update");
      if (!current || current.updatedAtToken !== input.expectedUpdatedAt) {
        return { outcome: "stale" };
      }
      const patch = planCuratedEnrichmentPatch(
        {
          beschrijving: current.beschrijving,
          bronSpecifiek: current.bronSpecifiek,
          contracttype: current.contracttype,
          eindDatum: current.eindDatum,
          locatieTekst: current.locatieTekst,
          opdrachtgeverNaam: current.opdrachtgeverNaam,
          publicatiedatum: current.publicatiedatum,
          sluitingsdatum: current.sluitingsdatum?.toISOString() ?? null,
          startDatum: current.startDatum,
          tariefEenheid: current.tariefEenheid,
          tariefMax: toNumericString(
            current.tariefMax === null ? null : String(current.tariefMax)
          ),
          tariefMin: toNumericString(
            current.tariefMin === null ? null : String(current.tariefMin)
          ),
          tariefValuta: current.tariefValuta,
          titleFallbackParts: titleFallbackParts(current),
          urenPerWeek: current.urenPerWeek,
          werkvorm: current.werkvorm,
        },
        input.proposals
      );
      if (patch === null || patch.fields.length === 0) {
        return { outcome: "nothing_to_fill" };
      }
      for (const proposal of input.proposals) {
        // oxlint-disable-next-line no-await-in-loop -- provenance rows commit in the same transaction, in proposal order
        await upsertProposalWith(tx, input.aanvraagId, proposal);
      }
      await applyCuratedEnrichmentPatchWith(tx, input.aanvraagId, patch);
      const outbox = await insertOutboxEventWith(tx, {
        aggregateId: input.aanvraagId,
        aggregateType: "aanvraag",
        eventType: ENRICHMENT_OUTBOX_EVENT_TYPE,
        payload: { field_count: patch.fields.length, fields: patch.fields },
      });
      return {
        fields: patch.fields,
        outboxEventId: outbox.id,
        outcome: "applied",
      };
    });
  }

  /**
   * Rows that already have high-confidence deterministic aanvraag_enrichment
   * but still have null curated commercial columns. Plans patches via
   * planCuratedEnrichmentPatchFromStored (respects CLEARED / `_cleared`).
   */
  async listPendingCuratedApply(
    limit: number
  ): Promise<readonly PendingCuratedApplyCandidate[]> {
    const rows = await this.database
      .select({
        beschrijving: aanvraag.beschrijving,
        bronReferentie: aanvraag.bronReferentie,
        bronSpecifiek: aanvraag.bronSpecifiek,
        confidence: aanvraagEnrichment.confidence,
        contracttype: aanvraag.contracttype,
        eindDatum: aanvraag.eindDatum,
        field: aanvraagEnrichment.field,
        id: aanvraag.id,
        locatieTekst: aanvraag.locatieTekst,
        opdrachtgeverNaam: aanvraag.opdrachtgeverNaam,
        publicatiedatum: aanvraag.publicatiedatum,
        rawRefs: aanvraagEnrichment.rawRefs,
        sluitingsdatum: aanvraag.sluitingsdatum,
        source: aanvraagEnrichment.source,
        startDatum: aanvraag.startDatum,
        tariefEenheid: aanvraag.tariefEenheid,
        tariefMax: aanvraag.tariefMax,
        tariefMin: aanvraag.tariefMin,
        tariefValuta: aanvraag.tariefValuta,
        titel: aanvraag.titel,
        urenPerWeek: aanvraag.urenPerWeek,
        value: aanvraagEnrichment.value,
        werkvorm: aanvraag.werkvorm,
      })
      .from(aanvraag)
      .innerJoin(
        aanvraagEnrichment,
        eq(aanvraagEnrichment.aanvraagId, aanvraag.id)
      )
      .where(incompleteAanvraagSql)
      .limit(limit * 8);

    const byId = new Map<
      string,
      {
        beschrijving: string;
        titleFallbackParts: TitleFallbackDescriptionParts | null;
        bronSpecifiek: unknown;
        contracttype: string | null;
        eindDatum: string | null;
        locatieTekst: string | null;
        opdrachtgeverNaam: string | null;
        proposals: {
          confidence: number;
          field: string;
          rawRefs: unknown;
          source: string;
          value: unknown;
        }[];
        publicatiedatum: string | null;
        sluitingsdatum: string | null;
        startDatum: string | null;
        tariefEenheid: string | null;
        tariefMax: string | null;
        tariefMin: string | null;
        tariefValuta: string | null;
        urenPerWeek: string | null;
        werkvorm: string | null;
      }
    >();

    for (const row of rows) {
      const confidence = Number(row.confidence);
      if (confidence < ENRICHMENT_APPLY_MIN_CONFIDENCE) {
        continue;
      }
      if (row.source !== "deterministic") {
        continue;
      }
      const existing = byId.get(row.id);
      const proposal = {
        confidence,
        field: row.field,
        rawRefs: row.rawRefs,
        source: row.source,
        value: row.value,
      };
      if (existing) {
        existing.proposals.push(proposal);
        continue;
      }
      byId.set(row.id, {
        beschrijving: row.beschrijving,
        bronSpecifiek: row.bronSpecifiek,
        contracttype: row.contracttype,
        eindDatum: row.eindDatum,
        locatieTekst: row.locatieTekst,
        opdrachtgeverNaam: row.opdrachtgeverNaam,
        proposals: [proposal],
        publicatiedatum: row.publicatiedatum,
        sluitingsdatum: row.sluitingsdatum?.toISOString() ?? null,
        startDatum: row.startDatum,
        tariefEenheid: row.tariefEenheid,
        tariefMax: toNumericString(
          row.tariefMax === null ? null : String(row.tariefMax)
        ),
        tariefMin: toNumericString(
          row.tariefMin === null ? null : String(row.tariefMin)
        ),
        tariefValuta: row.tariefValuta,
        titleFallbackParts: titleFallbackParts(row),
        urenPerWeek: row.urenPerWeek,
        werkvorm: row.werkvorm,
      });
    }

    const result: PendingCuratedApplyCandidate[] = [];
    for (const [id, candidate] of byId) {
      if (result.length >= limit) {
        break;
      }
      const patch = planCuratedEnrichmentPatchFromStored(
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
        candidate.proposals
      );
      if (patch === null) {
        continue;
      }
      result.push({
        beschrijving: candidate.beschrijving,
        bronSpecifiek: candidate.bronSpecifiek,
        contracttype: candidate.contracttype,
        eindDatum: candidate.eindDatum,
        id,
        locatieTekst: candidate.locatieTekst,
        opdrachtgeverNaam: candidate.opdrachtgeverNaam,
        patch,
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
      });
    }
    return result;
  }

  async listForAanvraag(
    aanvraagId: string
  ): Promise<readonly AanvraagEnrichmentRow[]> {
    const byId = await this.listForAanvraagIds([aanvraagId]);
    return byId.get(aanvraagId) ?? [];
  }

  async listForAanvraagIds(
    aanvraagIds: readonly string[]
  ): Promise<ReadonlyMap<string, readonly AanvraagEnrichmentRow[]>> {
    const result = new Map<string, AanvraagEnrichmentRow[]>();
    if (aanvraagIds.length === 0) {
      return result;
    }
    const uniqueIds = [...new Set(aanvraagIds)];
    const rows = await this.database
      .select()
      .from(aanvraagEnrichment)
      .where(inArray(aanvraagEnrichment.aanvraagId, uniqueIds));

    for (const row of rows) {
      const mapped: AanvraagEnrichmentRow = {
        aanvraagId: row.aanvraagId,
        confidence: Number(row.confidence),
        createdAt: row.createdAt,
        field: toEnrichmentField(row.field),
        id: row.id,
        rawRefs: row.rawRefs,
        source: row.source,
        updatedAt: row.updatedAt,
        value: row.value,
      };
      const existing = result.get(row.aanvraagId) ?? [];
      existing.push(mapped);
      result.set(row.aanvraagId, existing);
    }
    return result;
  }

  async listOverlayRowsForAanvraagIds(
    aanvraagIds: readonly string[]
  ): Promise<ReadonlyMap<string, readonly EnrichmentOverlayRow[]>> {
    const rowsById = await this.listForAanvraagIds(aanvraagIds);
    const overlays = new Map<string, readonly EnrichmentOverlayRow[]>();
    for (const [aanvraagId, rows] of rowsById) {
      overlays.set(aanvraagId, rows.map(toOverlayRow));
    }
    return overlays;
  }

  insertOutboxEvent(
    input: EnrichmentOutboxInsertInput
  ): Promise<{ readonly id: string }> {
    return insertOutboxEventWith(this.database, input);
  }
}
