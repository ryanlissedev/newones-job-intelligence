/**
 * Web serialisable contracts from SoT (CTP-475 / migration-map Slice 11).
 *
 * - Types and CapabilitySchema adapters come from the browser-safe
 *   `@ji/application/registry/web-contracts` surface (Effect Schema SoT).
 * - Do **not** re-export `@ji/search` or `@ji/application/registry` here —
 *   those barrels pull Node builtins (`node:async_hooks`, `node:child_process`)
 *   via `@ji/performance` / handler runtime and break Next webpack.
 * - No Effect process runtime is imported or started here (Schema adapters only).
 * - UI presentation enums that differ from wire status (e.g. JobLifecycleStatus
 *   "open"/"closing-soon") stay in `../types.ts` as view-model mapping.
 */

export {
  AANVRAAG_LIFECYCLE,
  MARKERING_STATUSES,
  MarkeringStatusSchema,
  SEARCH_SCOPES,
  SEARCH_SORT_OPTIONS,
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
  markeringReadbackSchema,
  restCapabilityFailureSchema,
  searchAanvragenInputSchema,
  searchAanvragenOutputSchema,
  searchFiltersSchema,
  syntaxErrorDetailsSchema,
  type AanvraagVersieView,
  type AanvraagLifecycle,
  type ApprovalView,
  type CommitExportResult,
  type ExportStatusView,
  type MarkeringReadback,
  type MarkeringStatus,
  type MarkeringView,
  type RestCapabilityFailure,
  type SchemaType,
  type SearchAanvragenInput,
  type SearchAanvragenOutput,
  type SearchFilters,
  type SearchScope,
  type SearchSort,
  type SnapshotApprovalView,
  type SnapshotDetailView,
  type SnapshotView,
} from "@ji/application/registry/web-contracts";
