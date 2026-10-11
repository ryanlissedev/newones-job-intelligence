import { BOOLEAN_PARSER_VERSION, parseBooleanQuery } from "@ji/domain";
import {
  createCriticalPathSession,
  isCriticalPathEnabled,
  resolveRunKind,
  buildWorkloadMetadata,
  timeCriticalPathPhase,
  withCriticalPathSession,
} from "@ji/performance";
import { Effect, Schema } from "effect";

import { validateSnapshotApproval } from "../../approval/validate-snapshot-approval";
import type { PublicBronView } from "../../bronnen";
import type {
  batchGetAanvragenInputSchema,
  getAanvraagInputSchema,
  getMarkeringInputSchema,
  listVersiesInputSchema,
  markeerAanvraagInputSchema,
  searchAanvragenInputSchema,
} from "../capability-io";
import { hasRecruiterPermission } from "../roles";
import type { SchemaType } from "../schema-helpers";
import {
  FiniteNumber,
  IntegerNumber,
  IsoDateTimeString,
  NonEmptyString,
  NonNegativeInteger,
  optionalField,
  PositiveInteger,
  toCapabilitySchema,
  TrimmedNonEmptyString,
  UnknownRecord,
  UuidString,
} from "../schema-helpers";
import {
  DEFAULT_SEARCH_SCOPE,
  previewText,
  SEARCH_SCOPES,
  searchFiltersSchema,
  SLICE_A_SCHEMA_VERSION,
} from "../schemas";
import type {
  SliceADomainFailure,
  SliceADomainFailureDetails,
} from "../schemas";
import {
  serializeSourceHealthSignals,
  sourceHealthSignalsViewSchema,
} from "../source-health";
import type {
  AanvraagRecord,
  AlertRecord,
  ApprovalRecord,
  ListedSnapshotRecord,
  QuerySnapshotRecord,
  SavedSearchRecord,
  SnapshotListCursor,
} from "../stores/types";
import type { SliceAHandlerDeps } from "./deps";

export { dualBindings, mcpBinding, restBinding } from "./bindings";
export { sliceADomainFailureSchema } from "../schemas";
export {
  createGetOperatorContextHandler,
  getOperatorContextInputSchema,
  getOperatorContextOutputSchema,
  OPERATOR_CONTEXT_CONTRACT_NAME,
  OPERATOR_CONTEXT_CONTRACT_VERSION,
  type OperatorContextCapabilityDescriptor,
} from "./operator-context";

const domainFailure = (
  code: SliceADomainFailure["code"],
  message: string,
  details?: SliceADomainFailureDetails
) => ({ error: { code, details, message }, ok: false as const });

/** Moves one nullable-fallback branch out of previewAanvraag to stay under the complexity budget. */
const orNull = <T>(value: T | null | undefined): T | null => value ?? null;

const previewAanvraag = (record: AanvraagRecord) => ({
  beschrijving: previewText(record.beschrijving),
  bronId: record.bronId,
  bronReferentie: record.bronReferentie,
  bronUrl: orNull(record.bronUrl),
  contracttype: orNull(record.contracttype),
  // CTP-610: the duplicate badge needs the group id on list rows too —
  // it is an opaque identity, not vacancy content. contactpersonen stays
  // full-mode only (recruiter-gated PII).
  dedupGroepId: orNull(record.dedupGroepId),
  duur: orNull(record.duur),
  eindDatum: orNull(record.eindDatum),
  enrichedFields: record.enrichedFields ?? [],
  id: record.id,
  locatie: record.locatie ?? null,
  locatieLand: orNull(record.locatieLand),
  mode: "preview" as const,
  opdrachtgeverNaam: record.opdrachtgeverNaam ?? null,
  opleidingsniveau: record.opleidingsniveau ?? null,
  provincie: record.provincie ?? null,
  publicatiedatum: record.publicatiedatum ?? null,
  rawPayloadRef: record.rawPayloadRef,
  scrapeRunId: record.scrapeRunId,
  skills: record.skills ?? [],
  sluitingsdatum: record.sluitingsdatum?.toISOString() ?? null,
  startDatum: record.startDatum ?? null,
  status: record.status,
  tariefEenheid: record.tariefEenheid ?? null,
  tariefMax: record.tariefMax ?? null,
  tariefMin: record.tariefMin ?? null,
  tariefValuta: record.tariefValuta ?? null,
  titel: record.titel,
  urenPerWeek: record.urenPerWeek ?? null,
  werkvorm: record.werkvorm ?? null,
});

const fullAanvraag = (record: AanvraagRecord) => {
  const { titleFallbackParts: _titleFallbackParts, ...publicRecord } = record;
  return {
    ...publicRecord,
    mode: "full" as const,
  };
};

// Wire I/O schemas live in ../capability-io (browser-safe SoT for CTP-475).
export {
  BATCH_GET_AANVRAGEN_MAX_IDS,
  SEARCH_MAX_LIMIT,
  batchGetAanvragenInputSchema,
  batchGetAanvragenOutputSchema,
  getAanvraagInputSchema,
  getAanvraagOutputSchema,
  getMarkeringInputSchema,
  getMarkeringOutputSchema,
  listVersiesInputSchema,
  listVersiesOutputSchema,
  markeerAanvraagInputSchema,
  markeerAanvraagOutputSchema,
  searchAanvragenInputSchema,
  searchAanvragenOutputSchema,
} from "../capability-io";

export const createSearchAanvragenHandler =
  (deps: SliceAHandlerDeps) =>
  (input: SchemaType<typeof searchAanvragenInputSchema>) => {
    const execute = async () => {
      const result = await timeCriticalPathPhase("api-handler", () =>
        deps.searchAdapter.search(input)
      );
      if (!result.ok) {
        return domainFailure(
          "SYNTAX_ERROR",
          result.error.message,
          result.error
        );
      }
      return {
        ok: true as const,
        value: {
          archiveTotal: result.archiveTotal,
          emptyReason: result.emptyReason,
          facets: result.facets,
          hits: result.hits,
          ids: result.hits.map((hit) => hit.id),
          incomplete: result.incomplete,
          indexVersion: result.indexVersion,
          parserVersion: result.parserVersion,
          scope: result.scope,
          total: result.total,
          windowLimit: result.windowLimit,
        },
      };
    };

    if (!isCriticalPathEnabled()) {
      return execute();
    }

    const session = createCriticalPathSession({
      metadata: buildWorkloadMetadata(),
      runKind: resolveRunKind(),
    });
    return withCriticalPathSession(session, async () => {
      try {
        const response = await execute();
        await session.flush();
        return response;
      } catch (error) {
        await session.flush();
        throw error;
      }
    });
  };

export const createGetAanvraagHandler =
  (deps: SliceAHandlerDeps) =>
  async (
    input: SchemaType<typeof getAanvraagInputSchema>,
    context: {
      principal: { permissions: ReadonlySet<string>; subjectId: string };
    }
  ) => {
    const record = await deps.stores.aanvragen.getById(input.id);
    if (!record) {
      return domainFailure("NOT_FOUND", "Aanvraag not found", { id: input.id });
    }
    if (
      input.full === true &&
      !hasRecruiterPermission(context.principal.permissions)
    ) {
      return domainFailure(
        "FORBIDDEN_FULL",
        "Full detail requires the recruiter role"
      );
    }
    const markering = await deps.stores.markeringen.get(
      input.id,
      context.principal.subjectId,
      deps.scopeId
    );
    return {
      ok: true as const,
      value: {
        aanvraag:
          input.full === true ? fullAanvraag(record) : previewAanvraag(record),
        markering: markering
          ? {
              reden: markering.reden,
              revision: markering.revision,
              status: markering.status,
              updatedAt: markering.updatedAt.toISOString(),
            }
          : null,
      },
    };
  };

const toVersieView = (versie: AanvraagRecord["versies"][number]) => ({
  geldigTot: versie.geldigTot?.toISOString() ?? null,
  geldigVan: versie.geldigVan.toISOString(),
  id: versie.id,
  normalisatieversie: versie.normalisatieversie,
  scrapeRunId: versie.scrapeRunId,
});

export const createListVersiesHandler =
  (deps: SliceAHandlerDeps) =>
  async (input: SchemaType<typeof listVersiesInputSchema>) => {
    const versies = await deps.stores.aanvragen.listVersies(input.aanvraagId);
    if (versies.length === 0) {
      const exists = await deps.stores.aanvragen.getById(input.aanvraagId);
      if (!exists) {
        return domainFailure("NOT_FOUND", "Aanvraag not found", {
          id: input.aanvraagId,
        });
      }
    }
    return {
      ok: true as const,
      value: versies.map(toVersieView),
    };
  };

// Batched search hydration (RJC-379): one call replaces the per-id
// get_aanvraag + list_versies fan-out. The cap matches the largest search
// page (SEARCH_MAX_LIMIT) so any single page hydrates in a single request;
// larger id lists are a validation error, never accepted.
export const createBatchGetAanvragenHandler =
  (deps: SliceAHandlerDeps) =>
  async (
    input: SchemaType<typeof batchGetAanvragenInputSchema>,
    context: {
      principal: { permissions: ReadonlySet<string>; subjectId: string };
    }
  ) => {
    // Same rule as get_aanvraag: full detail is recruiter-only; preview
    // (DEC-008 minimised via previewAanvraag) is the default.
    if (
      input.full === true &&
      !hasRecruiterPermission(context.principal.permissions)
    ) {
      return domainFailure(
        "FORBIDDEN_FULL",
        "Full detail requires the recruiter role"
      );
    }
    const records = await deps.stores.aanvragen.getByIds(input.ids);
    const items = await Promise.all(
      records.map(async (record) => {
        const markering = await deps.stores.markeringen.get(
          record.id,
          context.principal.subjectId,
          deps.scopeId
        );
        return {
          aanvraag:
            input.full === true
              ? fullAanvraag(record)
              : previewAanvraag(record),
          id: record.id,
          markering: markering
            ? {
                reden: markering.reden,
                revision: markering.revision,
                status: markering.status,
                updatedAt: markering.updatedAt.toISOString(),
              }
            : null,
          versies: record.versies.map(toVersieView),
        };
      })
    );
    // Unknown ids are skipped rather than failing the batch, mirroring the
    // per-id path where one failed preview never sank the whole search.
    return { ok: true as const, value: { items } };
  };

export const readRawInputSchema = toCapabilitySchema(
  Schema.Struct({
    full: optionalField(Schema.Boolean),
    ref: NonEmptyString,
  })
);

export const readRawOutputSchema = toCapabilitySchema(
  Schema.Struct({
    contentType: Schema.String,
    full: optionalField(Schema.String),
    mode: Schema.Literals(["full", "preview"]),
    preview: Schema.String,
    ref: Schema.String,
  })
);

export const createReadRawHandler =
  (deps: SliceAHandlerDeps) =>
  async (
    input: SchemaType<typeof readRawInputSchema>,
    context: { principal: { permissions: ReadonlySet<string> } }
  ) => {
    const payload = await deps.stores.rawPayloads.getByRef(input.ref);
    if (!payload) {
      return domainFailure("NOT_FOUND", "Raw payload not found", {
        ref: input.ref,
      });
    }
    if (
      input.full === true &&
      !hasRecruiterPermission(context.principal.permissions)
    ) {
      return domainFailure(
        "FORBIDDEN_FULL",
        "Full raw payload requires the recruiter role"
      );
    }
    const previewValue = {
      contentType: payload.contentType,
      mode: "preview" as const,
      preview: payload.preview,
      ref: payload.ref,
    };
    if (input.full === true) {
      return {
        ok: true as const,
        value: {
          ...previewValue,
          full: payload.full,
          mode: "full" as const,
        },
      };
    }
    return { ok: true as const, value: previewValue };
  };

export const listBronnenOutputSchema = toCapabilitySchema(
  Schema.Array(UnknownRecord)
);

export const createListBronnenHandler =
  (deps: SliceAHandlerDeps) => async () => {
    const bronnen = await deps.bronnen.list();
    return {
      ok: true as const,
      value: bronnen.map((bron: PublicBronView) => ({ ...bron })),
    };
  };

export const getBronInputSchema = toCapabilitySchema(
  Schema.Struct({ bronId: UuidString })
);

export const getBronOutputSchema = toCapabilitySchema(UnknownRecord);

export const createGetBronHandler =
  (deps: SliceAHandlerDeps) =>
  async (input: SchemaType<typeof getBronInputSchema>) => {
    const bron = await deps.bronnen.getById(input.bronId);
    if (!bron) {
      return domainFailure("NOT_FOUND", "Bron not found", {
        bronId: input.bronId,
      });
    }
    return { ok: true as const, value: { ...bron } };
  };

export const createSavedSearchInputSchema = toCapabilitySchema(
  Schema.Struct({
    filters: optionalField(searchFiltersSchema.effect),
    naam: NonEmptyString,
    query: Schema.String,
  })
);

const savedSearchView = Schema.Struct({
  createdAt: Schema.String,
  filters: searchFiltersSchema.effect,
  id: Schema.String,
  naam: Schema.String,
  parserVersion: Schema.String,
  queryText: Schema.String,
  schemaVersion: Schema.String,
  updatedAt: Schema.String,
  userId: Schema.String,
});

export const savedSearchViewSchema = toCapabilitySchema(savedSearchView);

const toSavedSearchView = (record: SavedSearchRecord) => ({
  createdAt: record.createdAt.toISOString(),
  filters: record.filters,
  id: record.id,
  naam: record.naam,
  parserVersion: record.parserVersion,
  queryText: record.queryText,
  schemaVersion: record.schemaVersion,
  updatedAt: record.updatedAt.toISOString(),
  userId: record.userId,
});

export const createSavedSearchHandler =
  (deps: SliceAHandlerDeps) =>
  async (
    input: SchemaType<typeof createSavedSearchInputSchema>,
    context: {
      principal: {
        kind: "agent" | "service" | "user";
        subjectId: string;
      };
    }
  ) => {
    let parserVersion = String(BOOLEAN_PARSER_VERSION);
    if (input.query.trim() !== "") {
      const parsed = parseBooleanQuery(input.query);
      if (!parsed.ok) {
        return domainFailure(
          "SYNTAX_ERROR",
          parsed.error.message,
          parsed.error
        );
      }
      parserVersion = String(parsed.version);
    }
    const { savedSearch } = await deps.stores.savedSearches.createWithAudit(
      {
        deletedAt: null,
        filters: input.filters ?? {},
        naam: input.naam,
        parserVersion,
        queryText: input.query,
        schemaVersion: SLICE_A_SCHEMA_VERSION,
        scopeId: deps.scopeId,
        userId: context.principal.subjectId,
      },
      context.principal.kind
    );
    return { ok: true as const, value: toSavedSearchView(savedSearch) };
  };

export const savedSearchIdInputSchema = toCapabilitySchema(
  Schema.Struct({ id: UuidString })
);
export const listSavedSearchesOutputSchema = toCapabilitySchema(
  Schema.Array(savedSearchView)
);

export const createGetSavedSearchHandler =
  (deps: SliceAHandlerDeps) =>
  async (
    input: SchemaType<typeof savedSearchIdInputSchema>,
    context: { principal: { subjectId: string } }
  ) => {
    const saved = await deps.stores.savedSearches.getById(
      input.id,
      context.principal.subjectId,
      deps.scopeId
    );
    return saved
      ? { ok: true as const, value: toSavedSearchView(saved) }
      : domainFailure("NOT_FOUND", "Saved search not found", { id: input.id });
  };

export const createListSavedSearchesHandler =
  (deps: SliceAHandlerDeps) =>
  async (
    _input: Record<string, never>,
    context: { principal: { subjectId: string } }
  ) => {
    const saved = await deps.stores.savedSearches.list(
      context.principal.subjectId,
      deps.scopeId
    );
    return { ok: true as const, value: saved.map(toSavedSearchView) };
  };

export const updateSavedSearchInputSchema = toCapabilitySchema(
  Schema.Struct({
    filters: optionalField(searchFiltersSchema.effect),
    id: UuidString,
    naam: optionalField(NonEmptyString),
    query: optionalField(Schema.String),
  }).check(
    Schema.makeFilter((input) =>
      input.filters === undefined &&
      input.naam === undefined &&
      input.query === undefined
        ? "At least one saved-search field must be updated"
        : undefined
    )
  )
);

export const createUpdateSavedSearchHandler =
  (deps: SliceAHandlerDeps) =>
  async (
    input: SchemaType<typeof updateSavedSearchInputSchema>,
    context: {
      principal: {
        kind: "agent" | "service" | "user";
        subjectId: string;
      };
    }
  ) => {
    const current = await deps.stores.savedSearches.getById(
      input.id,
      context.principal.subjectId,
      deps.scopeId
    );
    if (!current) {
      return domainFailure("NOT_FOUND", "Saved search not found", {
        id: input.id,
      });
    }
    const queryText = input.query ?? current.queryText;
    const parsed = parseBooleanQuery(queryText);
    if (!parsed.ok) {
      return domainFailure("SYNTAX_ERROR", parsed.error.message, parsed.error);
    }
    const updated = await deps.stores.savedSearches.updateWithAudit(
      input.id,
      context.principal.subjectId,
      deps.scopeId,
      {
        filters: input.filters ?? current.filters,
        naam: input.naam ?? current.naam,
        parserVersion: String(parsed.version),
        queryText,
        schemaVersion: SLICE_A_SCHEMA_VERSION,
      },
      context.principal.kind
    );
    return updated
      ? { ok: true as const, value: toSavedSearchView(updated.savedSearch) }
      : domainFailure("NOT_FOUND", "Saved search not found", { id: input.id });
  };

export const removeSavedSearchOutputSchema = toCapabilitySchema(
  Schema.Struct({
    auditEventId: Schema.String,
    id: Schema.String,
    removed: Schema.Literal(true),
  })
);

export const createRemoveSavedSearchHandler =
  (deps: SliceAHandlerDeps) =>
  async (
    input: SchemaType<typeof savedSearchIdInputSchema>,
    context: {
      principal: {
        kind: "agent" | "service" | "user";
        subjectId: string;
      };
    }
  ) => {
    const removed = await deps.stores.savedSearches.removeWithAudit(
      input.id,
      context.principal.subjectId,
      deps.scopeId,
      context.principal.kind
    );
    return removed
      ? {
          ok: true as const,
          value: {
            auditEventId: removed.auditEvent.id,
            id: input.id,
            removed: true as const,
          },
        }
      : domainFailure("NOT_FOUND", "Saved search not found", { id: input.id });
  };

/**
 * Cap on an explicit snapshot selection. Matches the search hydration window
 * (BATCH_GET_AANVRAGEN_MAX_IDS / searchAanvragen limit max SEARCH_MAX_LIMIT): a recruiter
 * selects from results that arrive at most 100 per request, so a selection
 * larger than one hydrated window cannot have been reviewed as a unit.
 */
export const SNAPSHOT_MAX_SELECTED_IDS = 100;

export const createSnapshotInputSchema = toCapabilitySchema(
  Schema.Struct({
    filters: optionalField(searchFiltersSchema.effect),
    query: Schema.String,
    savedSearchId: optionalField(UuidString),
    /** Scope the selection was made under (RJC-383); recorded as context like query and filters. */
    scope: optionalField(Schema.Literals(SEARCH_SCOPES)),
    selectedIds: Schema.Array(UuidString).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(SNAPSHOT_MAX_SELECTED_IDS)
    ),
  })
);

export const snapshotViewSchema = toCapabilitySchema(
  Schema.Struct({
    createdAt: Schema.String,
    filters: searchFiltersSchema.effect,
    id: Schema.String,
    indexVersion: FiniteNumber,
    parserVersion: Schema.String,
    queryText: Schema.String,
    resultIds: Schema.Array(Schema.String),
    savedSearchId: Schema.NullOr(Schema.String),
    schemaVersion: Schema.String,
    scope: Schema.Literals(SEARCH_SCOPES),
    searchVersion: Schema.Struct({
      appliedSequence: Schema.String,
      generation: IntegerNumber.check(Schema.isGreaterThanOrEqualTo(1)),
    }),
    userId: Schema.String,
  })
);

const toSnapshotView = (record: QuerySnapshotRecord) => ({
  createdAt: record.createdAt.toISOString(),
  filters: record.filters,
  id: record.id,
  indexVersion: record.indexVersion,
  parserVersion: record.parserVersion,
  queryText: record.queryText,
  resultIds: [...record.resultIds],
  savedSearchId: record.savedSearchId,
  schemaVersion: record.schemaVersion,
  scope: record.scope,
  searchVersion: {
    // bigint is not JSON-serializable; the wire format is a decimal string.
    appliedSequence: record.searchVersion.appliedSequence.toString(),
    generation: record.searchVersion.generation,
  },
  userId: record.userId,
});

const sha256 = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

export const getSnapshotInputSchema = toCapabilitySchema(
  Schema.Struct({ id: UuidString })
);

const hexDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));

export const getSnapshotOutputSchema = toCapabilitySchema(
  Schema.Struct({
    approval: Schema.NullOr(
      Schema.Struct({
        actorId: Schema.String,
        createdAt: Schema.String,
        expiresAt: Schema.String,
        id: Schema.String,
        status: Schema.Literals(["approved", "expired"]),
      })
    ),
    createdAt: Schema.String,
    freshness: Schema.Struct({
      searchAppliedSequence: Schema.String,
      searchGeneration: PositiveInteger,
    }),
    id: Schema.String,
    provenance: Schema.Struct({
      parserVersion: Schema.String,
      schemaVersion: Schema.String,
    }),
    queryDigest: hexDigest,
    resultIds: Schema.Array(Schema.String),
    savedSearchId: Schema.NullOr(Schema.String),
    scope: Schema.Literals(SEARCH_SCOPES),
    selectionDigest: hexDigest,
  })
);

export const createGetSnapshotHandler =
  (deps: SliceAHandlerDeps) =>
  async (
    input: SchemaType<typeof getSnapshotInputSchema>,
    context: { principal: { subjectId: string } }
  ) => {
    const snapshot = await deps.stores.snapshots.getById(
      input.id,
      deps.scopeId
    );
    if (!snapshot || snapshot.userId !== context.principal.subjectId) {
      return domainFailure("NOT_FOUND", "QuerySnapshot not found", {
        id: input.id,
      });
    }
    const approval = await deps.stores.approvals.getBySnapshotId(
      snapshot.id,
      deps.scopeId
    );
    const queryDigest = await sha256(
      JSON.stringify({
        filters: snapshot.filters,
        query: snapshot.queryText,
        scope: snapshot.scope,
      })
    );
    const selectionDigest = await sha256(JSON.stringify(snapshot.resultIds));
    return {
      ok: true as const,
      value: {
        approval: approval
          ? {
              actorId: approval.actorId,
              createdAt: approval.createdAt.toISOString(),
              expiresAt: approval.expiresAt.toISOString(),
              id: approval.id,
              status:
                approval.expiresAt.getTime() > Date.now()
                  ? ("approved" as const)
                  : ("expired" as const),
            }
          : null,
        createdAt: snapshot.createdAt.toISOString(),
        freshness: {
          searchAppliedSequence:
            snapshot.searchVersion.appliedSequence.toString(),
          searchGeneration: snapshot.searchVersion.generation,
        },
        id: snapshot.id,
        provenance: {
          parserVersion: snapshot.parserVersion,
          schemaVersion: snapshot.schemaVersion,
        },
        queryDigest,
        resultIds: [...snapshot.resultIds],
        savedSearchId: snapshot.savedSearchId,
        scope: snapshot.scope,
        selectionDigest,
      },
    };
  };

export const LIST_SNAPSHOTS_MAX_LIMIT = 100;
export const LIST_SNAPSHOTS_DEFAULT_LIMIT = 50;

export const listSnapshotsInputSchema = toCapabilitySchema(
  Schema.Struct({
    /** Opaque base64url keyset cursor: `${createdAt ISO}|${id}`. */
    cursor: optionalField(Schema.String),
    limit: optionalField(
      IntegerNumber.check(
        Schema.isGreaterThanOrEqualTo(1),
        Schema.isLessThanOrEqualTo(LIST_SNAPSHOTS_MAX_LIMIT)
      )
    ),
  })
);

const LISTED_SNAPSHOT_STATUSES = [
  "pending",
  "approved",
  "committed",
  "failed",
] as const;

type ListedSnapshotStatus = (typeof LISTED_SNAPSHOT_STATUSES)[number];

const listedSnapshotStatus = Schema.Literals(LISTED_SNAPSHOT_STATUSES);

export const listSnapshotsOutputSchema = toCapabilitySchema(
  Schema.Struct({
    items: Schema.Array(
      Schema.Struct({
        actorId: Schema.NullOr(Schema.String),
        approval: Schema.NullOr(
          Schema.Struct({
            actorId: Schema.String,
            expiresAt: Schema.String,
          })
        ),
        createdAt: Schema.String,
        export: Schema.NullOr(
          Schema.Struct({
            externalIdCount: NonNegativeInteger,
            lastAttemptAt: Schema.String,
            status: Schema.String,
          })
        ),
        id: Schema.String,
        query: Schema.NullOr(Schema.String),
        resultCount: NonNegativeInteger,
        status: listedSnapshotStatus,
      })
    ),
    nextCursor: Schema.NullOr(Schema.String),
  })
);

const encodeSnapshotCursor = (cursor: SnapshotListCursor): string =>
  Buffer.from(
    `${cursor.createdAt.toISOString()}|${cursor.id}`,
    "utf-8"
  ).toString("base64url");

const decodeSnapshotCursor = (cursor: string): SnapshotListCursor | null => {
  const decoded = Buffer.from(cursor, "base64url").toString("utf-8");
  const separator = decoded.lastIndexOf("|");
  if (separator <= 0) {
    return null;
  }
  const createdAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(createdAt.getTime()) || id.length === 0) {
    return null;
  }
  return { createdAt, id };
};

const listedSnapshotStatusFor = (
  record: ListedSnapshotRecord,
  now: number
): ListedSnapshotStatus => {
  if (record.export) {
    if (record.export.hasSuccess) {
      return "committed";
    }
    if (record.export.status === "failed") {
      return "failed";
    }
  }
  if (record.approval && record.approval.expiresAt.getTime() > now) {
    return "approved";
  }
  return "pending";
};

/**
 * Owner-scoped list of snapshots with their latest approval and latest export
 * attempt. Metadata only — no result payloads — so it stays readable under
 * PERM_SLICE_READ where the detail reads are actor-scoped anyway.
 */
export const createListSnapshotsHandler =
  (deps: SliceAHandlerDeps) =>
  async (
    input: SchemaType<typeof listSnapshotsInputSchema>,
    context: { principal: { subjectId: string } }
  ) => {
    let cursor: SnapshotListCursor | undefined;
    if (input.cursor !== undefined) {
      const decoded = decodeSnapshotCursor(input.cursor);
      if (!decoded) {
        return domainFailure("VALIDATION_ERROR", "Invalid cursor");
      }
      cursor = decoded;
    }
    const limit = input.limit ?? LIST_SNAPSHOTS_DEFAULT_LIMIT;
    const rows = await deps.stores.snapshots.list({
      cursor,
      limit: limit + 1,
      scopeId: deps.scopeId,
      userId: context.principal.subjectId,
    });
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    const now = Date.now();
    return {
      ok: true as const,
      value: {
        items: items.map((record) => ({
          actorId: record.actorId,
          approval: record.approval
            ? {
                actorId: record.approval.actorId,
                expiresAt: record.approval.expiresAt.toISOString(),
              }
            : null,
          createdAt: record.createdAt.toISOString(),
          export: record.export
            ? {
                externalIdCount: record.export.externalIdCount,
                lastAttemptAt: record.export.lastAttemptAt.toISOString(),
                status: record.export.status,
              }
            : null,
          id: record.id,
          query: record.query,
          resultCount: record.resultCount,
          status: listedSnapshotStatusFor(record, now),
        })),
        nextCursor:
          rows.length > limit && last
            ? encodeSnapshotCursor({ createdAt: last.createdAt, id: last.id })
            : null,
      },
    };
  };

/**
 * Selection-bound snapshot (RJC-385, Option A): the recruiter explicitly
 * selects the vacancies the snapshot covers; `resultIds` stores exactly that
 * selection. The query and filters are recorded as context only — they no
 * longer determine the result set, so the old implicit behaviour (run the
 * search, keep whatever page one returned — silently the adapter's default
 * limit of 20) is dead: a request without `selectedIds` is a validation
 * error, never a fallback.
 *
 * Every selected id must exist and be retrievable by this caller. Under the
 * current permission model, invoking this capability already requires the
 * recruiter role, and every existing aanvraag is preview-readable to a
 * recruiter — so "retrievable" reduces to "exists in the aanvraag store",
 * checked via the same `getByIds` read path search hydration uses. A snapshot
 * therefore cannot capture ids the caller could not have read.
 *
 * Option B (full async materialisation of ALL query matches) was considered
 * and deferred: the ticket documents it; add it in a follow-up if a product
 * need for "approve all matches" materialises.
 */
export const createSnapshotHandler =
  (deps: SliceAHandlerDeps) =>
  async (
    input: SchemaType<typeof createSnapshotInputSchema>,
    context: { principal: { subjectId: string } }
  ) => {
    const parsed =
      input.query.trim() === ""
        ? { ok: true as const, version: BOOLEAN_PARSER_VERSION }
        : parseBooleanQuery(input.query);
    if (!parsed.ok) {
      return domainFailure("SYNTAX_ERROR", parsed.error.message, parsed.error);
    }

    const uniqueIds = new Set(input.selectedIds);
    if (uniqueIds.size !== input.selectedIds.length) {
      return domainFailure(
        "VALIDATION_ERROR",
        "selectedIds must not contain duplicates"
      );
    }

    const readable = await deps.stores.aanvragen.getByIds(input.selectedIds);
    if (readable.length !== input.selectedIds.length) {
      const readableIds = new Set(readable.map((record) => record.id));
      const unknownIds = input.selectedIds.filter((id) => !readableIds.has(id));
      return domainFailure(
        "VALIDATION_ERROR",
        "selectedIds contains aanvragen that do not exist or are not readable by this caller",
        { unknownIds }
      );
    }

    if (input.savedSearchId) {
      const savedSearch = await deps.stores.savedSearches.getById(
        input.savedSearchId,
        context.principal.subjectId,
        deps.scopeId
      );
      if (!savedSearch) {
        return domainFailure("NOT_FOUND", "Saved search not found", {
          id: input.savedSearchId,
        });
      }
    }

    const searchVersion = await deps.searchAdapter.getAppliedVersion();
    const snapshot = await deps.stores.snapshots.create({
      filters: input.filters ?? {},
      // Legacy scalar kept for existing readers; mirrors how engines derive
      // indexVersion from the durable version (Number(appliedSequence)).
      indexVersion: Number(searchVersion.appliedSequence),
      parserVersion: String(parsed.version),
      queryText: input.query,
      resultIds: [...input.selectedIds],
      savedSearchId: input.savedSearchId ?? null,
      schemaVersion: SLICE_A_SCHEMA_VERSION,
      scope: input.scope ?? DEFAULT_SEARCH_SCOPE,
      scopeId: deps.scopeId,
      searchVersion,
      userId: context.principal.subjectId,
    });
    return { ok: true as const, value: toSnapshotView(snapshot) };
  };

export const approveSnapshotInputSchema = toCapabilitySchema(
  Schema.Struct({
    expiresAt: IsoDateTimeString,
    id: UuidString,
    motivatie: TrimmedNonEmptyString,
  })
);

const approvalViewFields = {
  actorId: Schema.String,
  createdAt: Schema.String,
  expiresAt: Schema.String,
  id: Schema.String,
  motivatie: Schema.String,
  resultIds: Schema.Array(Schema.String),
  snapshotId: Schema.String,
} as const;

export const approvalViewSchema = toCapabilitySchema(
  Schema.Struct({ ...approvalViewFields, auditEventId: Schema.String })
);

const toApprovalView = (record: ApprovalRecord, auditEventId: string) => ({
  actorId: record.actorId,
  auditEventId,
  createdAt: record.createdAt.toISOString(),
  expiresAt: record.expiresAt.toISOString(),
  id: record.id,
  motivatie: record.motivatie,
  resultIds: [...record.resultIds],
  snapshotId: record.snapshotId,
});

export const createApproveSnapshotHandler =
  (deps: SliceAHandlerDeps) =>
  async (
    input: SchemaType<typeof approveSnapshotInputSchema>,
    context: {
      principal: {
        kind: "agent" | "service" | "user";
        subjectId: string;
      };
    }
  ) => {
    const snapshot = await deps.stores.snapshots.getById(
      input.id,
      deps.scopeId
    );
    if (!snapshot) {
      return domainFailure("NOT_FOUND", "QuerySnapshot not found", {
        id: input.id,
      });
    }

    const expiresAt = new Date(input.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) {
      return domainFailure(
        "VALIDATION_ERROR",
        "expiresAt must be a valid ISO datetime"
      );
    }
    if (expiresAt.getTime() <= Date.now()) {
      return domainFailure(
        "VALIDATION_ERROR",
        "expiresAt must be in the future"
      );
    }

    const written = await deps.stores.approvals.createWithAudit(
      {
        actorId: context.principal.subjectId,
        expiresAt,
        motivatie: input.motivatie,
        resultIds: [...snapshot.resultIds],
        scopeId: deps.scopeId,
        snapshotId: snapshot.id,
      },
      context.principal.kind
    );
    if (!written.ok) {
      return domainFailure(
        "ALREADY_APPROVED",
        "This snapshot already has an approval record",
        { id: input.id }
      );
    }

    return {
      ok: true as const,
      value: toApprovalView(written.approval, written.auditEvent.id),
    };
  };

export const getSnapshotApprovalInputSchema = toCapabilitySchema(
  Schema.Struct({ id: UuidString })
);

export const getSnapshotApprovalOutputSchema = toCapabilitySchema(
  Schema.Struct({ ...approvalViewFields, valid: Schema.Boolean })
);

export const createGetSnapshotApprovalHandler =
  (deps: SliceAHandlerDeps) =>
  async (input: SchemaType<typeof getSnapshotApprovalInputSchema>) => {
    const snapshot = await deps.stores.snapshots.getById(
      input.id,
      deps.scopeId
    );
    if (!snapshot) {
      return domainFailure("NOT_FOUND", "QuerySnapshot not found", {
        id: input.id,
      });
    }

    const approval = await deps.stores.approvals.getBySnapshotId(
      input.id,
      deps.scopeId
    );
    if (!approval) {
      return domainFailure(
        "APPROVAL_NOT_FOUND",
        "No approval exists for this snapshot",
        {
          id: input.id,
        }
      );
    }

    const validation = validateSnapshotApproval({
      approval,
      scopeId: deps.scopeId,
      snapshot,
      snapshotId: input.id,
    });

    return {
      ok: true as const,
      value: {
        actorId: approval.actorId,
        createdAt: approval.createdAt.toISOString(),
        expiresAt: approval.expiresAt.toISOString(),
        id: approval.id,
        motivatie: approval.motivatie,
        resultIds: [...approval.resultIds],
        snapshotId: approval.snapshotId,
        valid: validation.ok,
      },
    };
  };

export const validateSnapshotApprovalInputSchema = toCapabilitySchema(
  Schema.Struct({ id: UuidString })
);

export const validateSnapshotApprovalOutputSchema = toCapabilitySchema(
  Schema.Struct({
    approvalId: Schema.String,
    snapshotId: Schema.String,
    valid: Schema.Literal(true),
  })
);

export const createValidateSnapshotApprovalHandler =
  (deps: SliceAHandlerDeps) =>
  async (input: SchemaType<typeof validateSnapshotApprovalInputSchema>) => {
    const snapshot = await deps.stores.snapshots.getById(
      input.id,
      deps.scopeId
    );
    const approval = snapshot
      ? await deps.stores.approvals.getBySnapshotId(input.id, deps.scopeId)
      : null;

    const validation = validateSnapshotApproval({
      approval,
      scopeId: deps.scopeId,
      snapshot,
      snapshotId: input.id,
    });

    if (!validation.ok) {
      return domainFailure(validation.error.code, validation.error.message, {
        id: input.id,
      });
    }

    return {
      ok: true as const,
      value: {
        approvalId: validation.value.id,
        snapshotId: validation.value.snapshotId,
        valid: true as const,
      },
    };
  };

export const createMarkeerAanvraagHandler =
  (deps: SliceAHandlerDeps) =>
  async (
    input: SchemaType<typeof markeerAanvraagInputSchema>,
    context: {
      principal: {
        kind: "agent" | "service" | "user";
        subjectId: string;
      };
    }
  ) => {
    const exists = await deps.stores.aanvragen.getById(input.aanvraagId);
    if (!exists) {
      return domainFailure("NOT_FOUND", "Aanvraag not found", {
        id: input.aanvraagId,
      });
    }
    const { auditEvent, markering } =
      await deps.stores.markeringen.setWithAudit(
        {
          // A superseded id resolves to its live row (getById); mark that one.
          aanvraagId: exists.id,
          reden: input.reden ?? null,
          scopeId: deps.scopeId,
          status: input.status,
          userId: context.principal.subjectId,
        },
        context.principal.kind
      );
    return {
      ok: true as const,
      value: {
        aanvraagId: markering.aanvraagId,
        auditEventId: auditEvent.id,
        reden: markering.reden,
        revision: markering.revision,
        status: markering.status,
        updatedAt: markering.updatedAt.toISOString(),
      },
    };
  };

export const createGetMarkeringHandler =
  (deps: SliceAHandlerDeps) =>
  async (
    input: SchemaType<typeof getMarkeringInputSchema>,
    context: { principal: { subjectId: string } }
  ) => {
    const markering = await deps.stores.markeringen.get(
      input.aanvraagId,
      context.principal.subjectId,
      deps.scopeId
    );
    return markering
      ? {
          ok: true as const,
          value: {
            aanvraagId: markering.aanvraagId,
            reden: markering.reden,
            revision: markering.revision,
            status: markering.status,
            updatedAt: markering.updatedAt.toISOString(),
          },
        }
      : domainFailure("NOT_FOUND", "Markering not found", {
          id: input.aanvraagId,
        });
  };

export const clearMarkeringOutputSchema = toCapabilitySchema(
  Schema.Struct({
    aanvraagId: Schema.String,
    auditEventId: Schema.String,
    cleared: Schema.Literal(true),
  })
);

export const createClearMarkeringHandler =
  (deps: SliceAHandlerDeps) =>
  async (
    input: SchemaType<typeof getMarkeringInputSchema>,
    context: {
      principal: {
        kind: "agent" | "service" | "user";
        subjectId: string;
      };
    }
  ) => {
    const cleared = await deps.stores.markeringen.clearWithAudit(
      input.aanvraagId,
      context.principal.subjectId,
      deps.scopeId,
      context.principal.kind
    );
    return cleared
      ? {
          ok: true as const,
          value: {
            aanvraagId: input.aanvraagId,
            auditEventId: cleared.auditEvent.id,
            cleared: true as const,
          },
        }
      : domainFailure("NOT_FOUND", "Markering not found", {
          id: input.aanvraagId,
        });
  };

export const listAlertsOutputSchema = toCapabilitySchema(
  Schema.Array(
    Schema.Struct({
      ackedAt: Schema.NullOr(Schema.String),
      bronId: Schema.String,
      createdAt: Schema.String,
      id: Schema.String,
      kind: Schema.String,
      message: Schema.String,
    })
  )
);

export const createListAlertsHandler =
  (deps: SliceAHandlerDeps) => async () => {
    const alerts = await deps.stores.alerts.listOpen();
    return {
      ok: true as const,
      value: alerts.map((alert: AlertRecord) => ({
        ackedAt: alert.ackedAt?.toISOString() ?? null,
        bronId: alert.bronId,
        createdAt: alert.createdAt.toISOString(),
        id: alert.id,
        kind: alert.kind,
        message: alert.message,
      })),
    };
  };

export const getBronHealthInputSchema = toCapabilitySchema(
  Schema.Struct({ bronId: UuidString })
);

export const getBronHealthOutputSchema = toCapabilitySchema(
  Schema.Struct({
    bronId: Schema.String,
    circuitStatus: Schema.NullOr(Schema.String),
    healthSignals: Schema.NullOr(sourceHealthSignalsViewSchema),
    lastRunAt: Schema.NullOr(Schema.String),
    lastRunStatus: Schema.NullOr(Schema.String),
    silenceAlertOpen: Schema.NullOr(Schema.Boolean),
  })
);

export const createGetBronHealthHandler =
  (deps: SliceAHandlerDeps) =>
  async (input: SchemaType<typeof getBronHealthInputSchema>) => {
    const sourceHealth = deps.sourceHealthReader
      ? await deps.sourceHealthReader.getByBronId(input.bronId)
      : null;
    // An unavailable telemetry read cannot establish worker death. Avoid a
    // second read against the same unavailable database just to fetch legacy fields.
    const health =
      sourceHealth?.signals.database.reason === "database_unavailable"
        ? null
        : await deps.stores.bronHealth.getByBronId(input.bronId);
    if (!health && !sourceHealth) {
      return domainFailure("NOT_FOUND", "Bron health not found", {
        bronId: input.bronId,
      });
    }
    return {
      ok: true as const,
      value: {
        bronId: health?.bronId ?? input.bronId,
        circuitStatus: health?.circuitStatus ?? null,
        healthSignals: sourceHealth
          ? serializeSourceHealthSignals(sourceHealth.signals)
          : null,
        lastRunAt: health?.lastRunAt?.toISOString() ?? null,
        lastRunStatus: health?.lastRunStatus ?? null,
        silenceAlertOpen: health?.silenceAlertOpen ?? null,
      },
    };
  };

export const ackAlertInputSchema = toCapabilitySchema(
  Schema.Struct({ alertId: UuidString })
);

export const ackAlertOutputSchema = toCapabilitySchema(
  Schema.Struct({
    ackedAt: Schema.String,
    ackedBy: Schema.String,
    alertId: Schema.String,
  })
);

export const createAckAlertHandler =
  (deps: SliceAHandlerDeps) =>
  async (
    input: SchemaType<typeof ackAlertInputSchema>,
    context: { principal: { subjectId: string } }
  ) => {
    const existing = await deps.stores.alerts.getById(input.alertId);
    if (!existing) {
      return domainFailure("NOT_FOUND", "Alert not found", {
        alertId: input.alertId,
      });
    }
    if (existing.ackedAt !== null) {
      return domainFailure("ALREADY_ACKED", "Alert was already acknowledged", {
        alertId: input.alertId,
      });
    }
    const alert = await deps.stores.alerts.ack(
      input.alertId,
      context.principal.subjectId
    );
    if (!alert?.ackedAt || !alert.ackedBy) {
      return domainFailure("NOT_FOUND", "Alert not found", {
        alertId: input.alertId,
      });
    }
    return {
      ok: true as const,
      value: {
        ackedAt: alert.ackedAt.toISOString(),
        ackedBy: alert.ackedBy,
        alertId: alert.id,
      },
    };
  };

export const startRunInputSchema = toCapabilitySchema(
  Schema.Struct({ bronId: UuidString })
);
export const startTestImportInputSchema = toCapabilitySchema(
  Schema.Struct({ bronId: UuidString })
);

export const operatorRunOutputSchema = toCapabilitySchema(
  Schema.Struct({ bronId: Schema.String, runId: Schema.String })
);

export const createStartRunHandler =
  (deps: SliceAHandlerDeps) =>
  async (input: SchemaType<typeof startRunInputSchema>) => {
    const bron = await deps.bronnen.getById(input.bronId);
    if (!bron) {
      return domainFailure("NOT_FOUND", "Bron not found", {
        bronId: input.bronId,
      });
    }
    const run = await deps.stores.operatorRuns.startRun(input.bronId);
    return {
      ok: true as const,
      value: { bronId: input.bronId, runId: run.runId },
    };
  };

export const createStartTestImportHandler =
  (deps: SliceAHandlerDeps) =>
  async (input: SchemaType<typeof startTestImportInputSchema>) => {
    const bron = await deps.bronnen.getById(input.bronId);
    if (!bron) {
      return domainFailure("NOT_FOUND", "Bron not found", {
        bronId: input.bronId,
      });
    }
    const run = await deps.stores.operatorRuns.startTestImport(input.bronId);
    return {
      ok: true as const,
      value: { bronId: input.bronId, runId: run.runId },
    };
  };

export const completeTaskInputSchema = toCapabilitySchema(
  Schema.Struct({
    evidence: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed<readonly string[]>([]))
    ),
    status: Schema.Literals(["blocked", "partial", "success"]),
    summary: NonEmptyString,
  })
);

export const completeTaskOutputSchema = toCapabilitySchema(
  Schema.Struct({
    accepted: Schema.Literal(true),
    evidence: Schema.Array(Schema.String),
    status: Schema.Literals(["blocked", "partial", "success"]),
    summary: Schema.String,
  })
);

export const createCompleteTaskHandler =
  (_deps: SliceAHandlerDeps) =>
  (input: SchemaType<typeof completeTaskInputSchema>) => ({
    ok: true as const,
    value: {
      accepted: true as const,
      evidence: input.evidence,
      status: input.status,
      summary: input.summary,
    },
  });

export { toSnapshotView };
export {
  commitExportInputSchema,
  commitExportOutputSchema,
  createCommitExportHandler,
  createGetExportStatusHandler,
  getExportStatusInputSchema,
  getExportStatusOutputSchema,
} from "./export-handlers";
