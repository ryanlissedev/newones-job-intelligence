import { Schema } from "effect";

import type { InvocationPrincipal } from "../capability";
import type { SchemaEncoded, SchemaType } from "../schema-helpers";
import {
  FiniteNumber,
  IsoDateTimeString,
  NonNegativeInteger,
  optionalField,
  PositiveInteger,
  toCapabilitySchema,
  UuidString,
} from "../schema-helpers";
import type { SliceADomainFailure } from "../schemas";
import type {
  AuditEventRecord,
  QuerySnapshotRecord,
  SavedSearchRecord,
} from "../stores/types";
import type { SliceAHandlerDeps } from "./deps";

export const OPERATOR_CONTEXT_CONTRACT_NAME =
  "catapulze.operator-context" as const;
export const OPERATOR_CONTEXT_CONTRACT_VERSION = "1.0.0" as const;

const capabilityAvailability = Schema.Literals([
  "available",
  "unavailable",
  "unknown",
]);
const safeActivityAction = Schema.Literals([
  "approve_snapshot",
  "commit_export",
  "markeer_aanvraag",
]);

export interface OperatorContextCapabilityDescriptor {
  readonly effect: "internal-write" | "read";
  readonly id: string;
  readonly outcome: string;
  readonly permission: string;
}

export const getOperatorContextInputSchema = toCapabilitySchema(
  Schema.Struct({
    savedSearchId: optionalField(UuidString),
    snapshotId: optionalField(UuidString),
  })
);

const notApplicable = Schema.Struct({
  state: Schema.Literal("not_applicable"),
});

const selectedSavedSearch = Schema.Union([
  notApplicable,
  Schema.Struct({
    createdAt: IsoDateTimeString,
    id: UuidString,
    parserVersion: Schema.String,
    schemaVersion: Schema.String,
    state: Schema.Literal("present"),
    updatedAt: IsoDateTimeString,
  }),
]);

const selectedSnapshot = Schema.Union([
  notApplicable,
  Schema.Struct({
    createdAt: IsoDateTimeString,
    id: UuidString,
    indexVersion: FiniteNumber,
    parserVersion: Schema.String,
    savedSearchId: Schema.NullOr(UuidString),
    schemaVersion: Schema.String,
    searchScope: Schema.String,
    searchVersion: Schema.Struct({
      appliedSequence: Schema.String,
      generation: PositiveInteger,
    }),
    selectedCount: NonNegativeInteger,
    state: Schema.Literal("present"),
  }),
]);

const resourceReference = Schema.Union([
  notApplicable,
  Schema.Struct({ id: UuidString, state: Schema.Literal("present") }),
]);

const unknownState = Schema.Struct({ state: Schema.Literal("unknown") });

const freshnessObservation = Schema.Union([
  Schema.Struct({
    observedAt: IsoDateTimeString,
    state: Schema.Literal("present"),
  }),
  unknownState,
  notApplicable,
]);

export const getOperatorContextOutputSchema = toCapabilitySchema(
  Schema.Struct({
    activity: Schema.Struct({
      items: Schema.Array(
        Schema.Struct({
          action: safeActivityAction,
          auditClass: Schema.Literals(["access", "effect", "none"]),
          createdAt: IsoDateTimeString,
          entityType: Schema.String,
        })
      ),
      state: Schema.Literal("present"),
    }),
    actor: Schema.Struct({
      id: Schema.String,
      kind: Schema.Literals(["user", "agent", "service"]),
    }),
    capabilities: Schema.Struct({
      items: Schema.Array(
        Schema.Struct({
          availability: capabilityAvailability,
          effect: Schema.Literals(["read", "internal-write"]),
          id: Schema.String,
          outcome: Schema.String,
        })
      ),
      state: Schema.Literal("present"),
    }),
    contract: Schema.Struct({
      digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
      digestAlgorithm: Schema.Literal("sha256"),
      name: Schema.Literal(OPERATOR_CONTEXT_CONTRACT_NAME),
      version: Schema.Literal(OPERATOR_CONTEXT_CONTRACT_VERSION),
    }),
    freshness: Schema.Struct({
      activity: freshnessObservation,
      capabilityPolicy: unknownState,
      readAt: IsoDateTimeString,
      resourceInventory: unknownState,
      savedSearch: freshnessObservation,
      snapshot: freshnessObservation,
    }),
    preferences: unknownState,
    provenance: Schema.Struct({
      activity: Schema.Literal("actor-and-scope-filtered-audit-store"),
      capabilities: Schema.Literal("permission-filtered-capability-registry"),
      resources: Schema.Literal("explicit-owner-scoped-resource-references"),
      selections: Schema.Literal("explicit-owner-and-scope-store-lookups"),
    }),
    resources: Schema.Struct({
      inventory: unknownState,
      selected: Schema.Struct({
        savedSearch: resourceReference,
        snapshot: resourceReference,
      }),
    }),
    scope: Schema.Struct({ id: Schema.String }),
    selected: Schema.Struct({
      savedSearch: selectedSavedSearch,
      snapshot: selectedSnapshot,
    }),
  })
);

type OperatorContextInput = SchemaType<typeof getOperatorContextInputSchema>;
type OperatorContextOutput = SchemaEncoded<
  typeof getOperatorContextOutputSchema
>;
type OperatorContextDigestContent = Pick<
  OperatorContextOutput,
  | "activity"
  | "actor"
  | "capabilities"
  | "preferences"
  | "provenance"
  | "resources"
  | "scope"
  | "selected"
> & {
  readonly contractName: typeof OPERATOR_CONTEXT_CONTRACT_NAME;
  readonly contractVersion: typeof OPERATOR_CONTEXT_CONTRACT_VERSION;
};

const notFound = (id: string, kind: "Saved search" | "QuerySnapshot") => ({
  error: {
    code: "NOT_FOUND" as const,
    details: { id },
    message: `${kind} not found`,
  },
  ok: false as const,
});

const savedSearchSummary = (record: SavedSearchRecord) => ({
  createdAt: record.createdAt.toISOString(),
  id: record.id,
  parserVersion: record.parserVersion,
  schemaVersion: record.schemaVersion,
  state: "present" as const,
  updatedAt: record.updatedAt.toISOString(),
});

const snapshotSummary = (record: QuerySnapshotRecord) => ({
  createdAt: record.createdAt.toISOString(),
  id: record.id,
  indexVersion: record.indexVersion,
  parserVersion: record.parserVersion,
  savedSearchId: record.savedSearchId,
  schemaVersion: record.schemaVersion,
  searchScope: record.scope,
  searchVersion: {
    appliedSequence: record.searchVersion.appliedSequence.toString(),
    generation: record.searchVersion.generation,
  },
  selectedCount: record.resultIds.length,
  state: "present" as const,
});

type SafeActivityAction = typeof safeActivityAction.Type;

const entityTypeForAction = (action: SafeActivityAction): string => {
  switch (action) {
    case "approve_snapshot": {
      return "query_snapshot";
    }
    case "commit_export": {
      return "export";
    }
    case "markeer_aanvraag": {
      return "aanvraag";
    }
    default: {
      const exhaustiveAction: never = action;
      throw new Error(`Unsupported safe activity action: ${exhaustiveAction}`);
    }
  }
};

const safeActivityActionSchema = toCapabilitySchema(safeActivityAction);

const safeActivitySummary = (event: AuditEventRecord) => {
  const parsedAction = safeActivityActionSchema.safeParse(event.action);
  if (!parsedAction.success) {
    return null;
  }
  return {
    action: parsedAction.data,
    auditClass: event.auditClass,
    createdAt: event.createdAt.toISOString(),
    entityType: entityTypeForAction(parsedAction.data),
  };
};

const compareText = (left: string, right: string): number =>
  left.localeCompare(right);

const digestValue = async (
  value: OperatorContextDigestContent
): Promise<string> => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const ACTIVITY_WINDOW_LIMIT = 10;

const readActorActivity = async (deps: SliceAHandlerDeps, actorId: string) => {
  const events = await deps.stores.audit.listRecentByActorId(
    actorId,
    deps.scopeId,
    ACTIVITY_WINDOW_LIMIT
  );
  // The store bounds the scan before the defense-in-depth allowlist. Unknown
  // actions are omitted, so the safe result can contain fewer than ten items.
  return events
    .filter(
      (event) => event.actorId === actorId && event.scopeId === deps.scopeId
    )
    .map(safeActivitySummary)
    .filter((event) => event !== null);
};

const readUnavailableCapabilityIds = async (
  deps: SliceAHandlerDeps
): Promise<ReadonlySet<string> | null> => {
  if (!deps.capabilityAvailability) {
    return null;
  }
  return await deps.capabilityAvailability.unavailableCapabilityIds();
};

const availabilityFor = (
  capabilityId: string,
  unavailableCapabilityIds: ReadonlySet<string> | null
): "available" | "unavailable" | "unknown" => {
  if (unavailableCapabilityIds === null) {
    return "unknown";
  }
  return unavailableCapabilityIds.has(capabilityId)
    ? "unavailable"
    : "available";
};

const readAuthorizedCapabilities = async (
  deps: SliceAHandlerDeps,
  principal: InvocationPrincipal,
  readCapabilities: () => readonly OperatorContextCapabilityDescriptor[]
) => {
  const unavailableCapabilityIds = await readUnavailableCapabilityIds(deps);
  return readCapabilities()
    .filter((capability) => principal.permissions.has(capability.permission))
    .map((capability) => ({
      availability: availabilityFor(capability.id, unavailableCapabilityIds),
      effect: capability.effect,
      id: capability.id,
      outcome: capability.outcome,
    }))
    .toSorted((left, right) => compareText(left.id, right.id));
};

type SelectedRecordsResult =
  | {
      readonly ok: true;
      readonly savedSearch: SavedSearchRecord | null;
      readonly snapshot: QuerySnapshotRecord | null;
    }
  | { readonly error: SliceADomainFailure; readonly ok: false };

const readSelectedRecords = async (
  deps: SliceAHandlerDeps,
  actorId: string,
  input: OperatorContextInput
): Promise<SelectedRecordsResult> => {
  const savedSearch = input.savedSearchId
    ? await deps.stores.savedSearches.getById(
        input.savedSearchId,
        actorId,
        deps.scopeId
      )
    : null;
  if (
    input.savedSearchId &&
    (!savedSearch ||
      savedSearch.userId !== actorId ||
      savedSearch.scopeId !== deps.scopeId)
  ) {
    return notFound(input.savedSearchId, "Saved search");
  }

  const snapshot = input.snapshotId
    ? await deps.stores.snapshots.getById(input.snapshotId, deps.scopeId)
    : null;
  if (
    input.snapshotId &&
    (!snapshot ||
      snapshot.userId !== actorId ||
      snapshot.scopeId !== deps.scopeId)
  ) {
    return notFound(input.snapshotId, "QuerySnapshot");
  }
  return { ok: true, savedSearch, snapshot };
};

export const createGetOperatorContextHandler =
  (
    deps: SliceAHandlerDeps,
    readCapabilities: () => readonly OperatorContextCapabilityDescriptor[]
  ) =>
  async (
    input: OperatorContextInput,
    context: { readonly principal: InvocationPrincipal }
  ): Promise<
    | {
        readonly ok: true;
        readonly value: SchemaEncoded<typeof getOperatorContextOutputSchema>;
      }
    | { readonly error: SliceADomainFailure; readonly ok: false }
  > => {
    const actorId = context.principal.subjectId;
    const selectedRecords = await readSelectedRecords(deps, actorId, input);
    if (!selectedRecords.ok) {
      return selectedRecords;
    }
    const { savedSearch, snapshot } = selectedRecords;
    const [actorActivity, capabilities] = await Promise.all([
      readActorActivity(deps, actorId),
      readAuthorizedCapabilities(deps, context.principal, readCapabilities),
    ]);

    const selected = {
      savedSearch: savedSearch
        ? savedSearchSummary(savedSearch)
        : { state: "not_applicable" as const },
      snapshot: snapshot
        ? snapshotSummary(snapshot)
        : { state: "not_applicable" as const },
    };
    const stableContent: OperatorContextDigestContent = {
      activity: { items: actorActivity, state: "present" as const },
      actor: { id: actorId, kind: context.principal.kind },
      capabilities: { items: capabilities, state: "present" as const },
      contractName: OPERATOR_CONTEXT_CONTRACT_NAME,
      contractVersion: OPERATOR_CONTEXT_CONTRACT_VERSION,
      preferences: { state: "unknown" as const },
      provenance: {
        activity: "actor-and-scope-filtered-audit-store" as const,
        capabilities: "permission-filtered-capability-registry" as const,
        resources: "explicit-owner-scoped-resource-references" as const,
        selections: "explicit-owner-and-scope-store-lookups" as const,
      },
      resources: {
        inventory: { state: "unknown" as const },
        selected: {
          savedSearch: savedSearch
            ? { id: savedSearch.id, state: "present" as const }
            : { state: "not_applicable" as const },
          snapshot: snapshot
            ? { id: snapshot.id, state: "present" as const }
            : { state: "not_applicable" as const },
        },
      },
      scope: { id: deps.scopeId },
      selected,
    };
    const [newestActivity] = actorActivity;

    return {
      ok: true,
      value: {
        activity: stableContent.activity,
        actor: stableContent.actor,
        capabilities: stableContent.capabilities,
        contract: {
          digest: await digestValue(stableContent),
          digestAlgorithm: "sha256",
          name: OPERATOR_CONTEXT_CONTRACT_NAME,
          version: OPERATOR_CONTEXT_CONTRACT_VERSION,
        },
        freshness: {
          activity: newestActivity
            ? { observedAt: newestActivity.createdAt, state: "present" }
            : { state: "unknown" },
          capabilityPolicy: { state: "unknown" },
          readAt: (deps.now?.() ?? new Date()).toISOString(),
          resourceInventory: { state: "unknown" },
          savedSearch: savedSearch
            ? {
                observedAt: savedSearch.updatedAt.toISOString(),
                state: "present",
              }
            : { state: "not_applicable" },
          snapshot: snapshot
            ? {
                observedAt: snapshot.createdAt.toISOString(),
                state: "present",
              }
            : { state: "not_applicable" },
        },
        preferences: stableContent.preferences,
        provenance: stableContent.provenance,
        resources: stableContent.resources,
        scope: stableContent.scope,
        selected: stableContent.selected,
      },
    };
  };
