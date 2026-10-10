import { defineCapability } from "./capability";
import {
  ackAlertInputSchema,
  ackAlertOutputSchema,
  completeTaskInputSchema,
  completeTaskOutputSchema,
  commitExportInputSchema,
  commitExportOutputSchema,
  batchGetAanvragenInputSchema,
  batchGetAanvragenOutputSchema,
  createAckAlertHandler,
  createApproveSnapshotHandler,
  createBatchGetAanvragenHandler,
  createCompleteTaskHandler,
  createCommitExportHandler,
  createClearMarkeringHandler,
  createGetExportStatusHandler,
  createGetAanvraagHandler,
  createGetBronHandler,
  createGetBronHealthHandler,
  createGetOperatorContextHandler,
  createGetSnapshotApprovalHandler,
  createGetSnapshotHandler,
  createGetMarkeringHandler,
  createGetSavedSearchHandler,
  createListSavedSearchesHandler,
  createListAlertsHandler,
  createListBronnenHandler,
  createListSnapshotsHandler,
  createListVersiesHandler,
  createMarkeerAanvraagHandler,
  createReadRawHandler,
  createSavedSearchHandler,
  createRemoveSavedSearchHandler,
  createSavedSearchInputSchema,
  createSearchAanvragenHandler,
  createSnapshotHandler,
  createSnapshotInputSchema,
  createStartRunHandler,
  createStartTestImportHandler,
  createUpdateSavedSearchHandler,
  createValidateSnapshotApprovalHandler,
  dualBindings,
  approveSnapshotInputSchema,
  approvalViewSchema,
  getSnapshotApprovalInputSchema,
  getSnapshotApprovalOutputSchema,
  getSnapshotInputSchema,
  getSnapshotOutputSchema,
  getExportStatusInputSchema,
  getExportStatusOutputSchema,
  validateSnapshotApprovalInputSchema,
  validateSnapshotApprovalOutputSchema,
  getAanvraagInputSchema,
  getAanvraagOutputSchema,
  getBronHealthInputSchema,
  getBronHealthOutputSchema,
  getBronInputSchema,
  getBronOutputSchema,
  getOperatorContextInputSchema,
  getOperatorContextOutputSchema,
  listAlertsOutputSchema,
  listBronnenOutputSchema,
  listSnapshotsInputSchema,
  listSnapshotsOutputSchema,
  listVersiesInputSchema,
  listVersiesOutputSchema,
  markeerAanvraagInputSchema,
  markeerAanvraagOutputSchema,
  getMarkeringInputSchema,
  getMarkeringOutputSchema,
  clearMarkeringOutputSchema,
  operatorRunOutputSchema,
  readRawInputSchema,
  readRawOutputSchema,
  savedSearchViewSchema,
  savedSearchIdInputSchema,
  listSavedSearchesOutputSchema,
  removeSavedSearchOutputSchema,
  searchAanvragenInputSchema,
  searchAanvragenOutputSchema,
  sliceADomainFailureSchema,
  snapshotViewSchema,
  startRunInputSchema,
  startTestImportInputSchema,
  updateSavedSearchInputSchema,
} from "./handlers";
import type { OperatorContextCapabilityDescriptor } from "./handlers";
import {
  createGetBronOverlapHandler,
  getBronOverlapInputSchema,
  getBronOverlapOutputSchema,
} from "./handlers/bron-overlap";
import {
  createGetBronStatsHandler,
  createGetDashboardOverviewHandler,
  createGetScrapeRunHandler,
  createListScrapeRunsHandler,
  getBronStatsInputSchema,
  getBronStatsOutputSchema,
  getDashboardOverviewInputSchema,
  getDashboardOverviewOutputSchema,
  getScrapeRunInputSchema,
  getScrapeRunOutputSchema,
  listScrapeRunsInputSchema,
  listScrapeRunsOutputSchema,
} from "./handlers/dashboard";
import type { SliceAHandlerDeps } from "./handlers/deps";
import {
  createGetDataDictionaryHandler,
  createListMartsTablesHandler,
  createQueryMartsHandler,
  createSearchQueryCatalogHandler,
  getDataDictionaryInputSchema,
  getDataDictionaryOutputSchema,
  listMartsTablesInputSchema,
  listMartsTablesOutputSchema,
  queryMartsInputSchema,
  queryMartsOutputSchema,
  searchQueryCatalogInputSchema,
  searchQueryCatalogOutputSchema,
} from "./handlers/marts";
import { defineSliceACapabilityEntry } from "./metadata";
import {
  PERM_APPROVAL,
  PERM_EXPORT,
  PERM_MARTS_READ,
  PERM_SLICE_READ,
  ROLE_OPERATOR,
  ROLE_RECRUITER,
} from "./roles";
import { emptyObjectSchema } from "./schema-helpers";
import {
  createSourcingAssessmentHandler,
  sourcingAssessmentInputSchema,
  sourcingAssessmentOutputSchema,
} from "./sourcing-assessment";

export const createSliceACapabilityCatalog = (deps: SliceAHandlerDeps) => {
  const domainFailureSchema = sliceADomainFailureSchema;
  let operatorContextCapabilities: readonly OperatorContextCapabilityDescriptor[] =
    [];

  const getOperatorContext = defineCapability({
    authorization: { permission: ROLE_OPERATOR },
    bindings: dualBindings("POST", "/v1/agent/context", "get_operator_context"),
    effect: "read",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createGetOperatorContextHandler(
      deps,
      () => operatorContextCapabilities
    ),
    id: "get_operator_context",
    inputSchema: getOperatorContextInputSchema,
    outcome: "Lees veilige, permission-aware operatorcontext",
    outputSchema: getOperatorContextOutputSchema,
  });

  const searchAanvragen = defineCapability({
    authorization: { permission: PERM_SLICE_READ },
    bindings: dualBindings("POST", "/v1/aanvragen/search", "search_aanvragen"),
    effect: "read",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createSearchAanvragenHandler(deps),
    id: "search_aanvragen",
    inputSchema: searchAanvragenInputSchema,
    outcome: "Zoek aanvragen met Boolean en filters",
    outputSchema: searchAanvragenOutputSchema,
  });

  const getAanvraag = defineCapability({
    authorization: { permission: PERM_SLICE_READ },
    bindings: dualBindings("GET", "/v1/aanvragen/{id}", "get_aanvraag"),
    effect: "read",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createGetAanvraagHandler(deps),
    id: "get_aanvraag",
    inputSchema: getAanvraagInputSchema,
    outcome: "Haal aanvraagdetail op (preview standaard)",
    outputSchema: getAanvraagOutputSchema,
  });

  const batchGetAanvragen = defineCapability({
    // Recruiter, the stricter of the two per-id capabilities this batches
    // (get_aanvraag: slice-a:read, list_versies: recruiter).
    authorization: { permission: PERM_SLICE_READ },
    bindings: dualBindings(
      "POST",
      "/v1/aanvragen/batch",
      "batch_get_aanvragen"
    ),
    effect: "read",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createBatchGetAanvragenHandler(deps),
    id: "batch_get_aanvragen",
    inputSchema: batchGetAanvragenInputSchema,
    outcome:
      "Haal previews en versies van meerdere aanvragen op in één aanroep",
    outputSchema: batchGetAanvragenOutputSchema,
  });

  const listVersies = defineCapability({
    authorization: { permission: PERM_SLICE_READ },
    bindings: dualBindings("GET", "/v1/aanvragen/{id}/versies", "list_versies"),
    effect: "read",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createListVersiesHandler(deps),
    id: "list_versies",
    inputSchema: listVersiesInputSchema,
    outcome: "Lijst normalisatieversies van een aanvraag",
    outputSchema: listVersiesOutputSchema,
  });

  const readRaw = defineCapability({
    // Raw bodies now embed source contactpersonen (CTP-610) within the
    // preview window, so the recruiter gate that covered `full` must cover
    // the preview too — approver/operator lose raw reads entirely.
    authorization: { permission: ROLE_RECRUITER },
    bindings: dualBindings("GET", "/v1/raw/{ref}", "read_raw"),
    effect: "read",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createReadRawHandler(deps),
    id: "read_raw",
    inputSchema: readRawInputSchema,
    outcome: "Lees immutable raw payload (preview standaard)",
    outputSchema: readRawOutputSchema,
  });

  const evaluateSourcingAssessment = defineCapability({
    authorization: { permission: PERM_SLICE_READ },
    bindings: dualBindings(
      "POST",
      "/v1/sourcing/assessment",
      "evaluate_sourcing_assessment"
    ),
    effect: "read",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createSourcingAssessmentHandler(deps),
    id: "evaluate_sourcing_assessment",
    inputSchema: sourcingAssessmentInputSchema,
    outcome:
      "Evaluate a versioned read-only sourcing answer with bound selection and provenance",
    outputSchema: sourcingAssessmentOutputSchema,
  });

  const listBronnen = defineCapability({
    authorization: { permission: PERM_SLICE_READ },
    bindings: dualBindings("GET", "/v1/bronnen", "list_bronnen"),
    effect: "read",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createListBronnenHandler(deps),
    id: "list_bronnen",
    inputSchema: emptyObjectSchema,
    outcome: "Lijst bronnen met status en laatste run",
    outputSchema: listBronnenOutputSchema,
  });

  const getBron = defineCapability({
    authorization: { permission: PERM_SLICE_READ },
    bindings: dualBindings("GET", "/v1/bronnen/{id}", "get_bron"),
    effect: "read",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createGetBronHandler(deps),
    id: "get_bron",
    inputSchema: getBronInputSchema,
    outcome: "Haal bronstatus en run-samenvatting op",
    outputSchema: getBronOutputSchema,
  });

  const createSavedSearch = defineCapability({
    authorization: { permission: ROLE_RECRUITER },
    bindings: dualBindings("POST", "/v1/saved-searches", "create_saved_search"),
    effect: "internal-write",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createSavedSearchHandler(deps),
    id: "create_saved_search",
    inputSchema: createSavedSearchInputSchema,
    outcome: "Sla zoekopdracht op met parser/schema versie",
    outputSchema: savedSearchViewSchema,
  });

  const listSavedSearches = defineCapability({
    authorization: { permission: PERM_SLICE_READ },
    bindings: dualBindings("GET", "/v1/saved-searches", "list_saved_searches"),
    effect: "read",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createListSavedSearchesHandler(deps),
    id: "list_saved_searches",
    inputSchema: emptyObjectSchema,
    outcome: "Lijst eigen actieve opgeslagen zoekopdrachten",
    outputSchema: listSavedSearchesOutputSchema,
  });

  const getSavedSearch = defineCapability({
    authorization: { permission: PERM_SLICE_READ },
    bindings: dualBindings(
      "GET",
      "/v1/saved-searches/{id}",
      "get_saved_search"
    ),
    effect: "read",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createGetSavedSearchHandler(deps),
    id: "get_saved_search",
    inputSchema: savedSearchIdInputSchema,
    outcome: "Lees een eigen opgeslagen zoekopdracht",
    outputSchema: savedSearchViewSchema,
  });

  const updateSavedSearch = defineCapability({
    authorization: { permission: ROLE_RECRUITER },
    bindings: dualBindings(
      "PUT",
      "/v1/saved-searches/{id}",
      "update_saved_search"
    ),
    effect: "internal-write",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createUpdateSavedSearchHandler(deps),
    id: "update_saved_search",
    inputSchema: updateSavedSearchInputSchema,
    outcome: "Wijzig een eigen opgeslagen zoekopdracht met auditspoor",
    outputSchema: savedSearchViewSchema,
  });

  const removeSavedSearch = defineCapability({
    authorization: { permission: ROLE_RECRUITER },
    bindings: dualBindings(
      "DELETE",
      "/v1/saved-searches/{id}",
      "remove_saved_search"
    ),
    effect: "internal-write",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createRemoveSavedSearchHandler(deps),
    id: "remove_saved_search",
    inputSchema: savedSearchIdInputSchema,
    outcome: "Verwijder een eigen opgeslagen zoekopdracht logisch",
    outputSchema: removeSavedSearchOutputSchema,
  });

  const createSnapshot = defineCapability({
    authorization: { permission: ROLE_RECRUITER },
    bindings: dualBindings("POST", "/v1/snapshots", "create_snapshot"),
    effect: "internal-write",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createSnapshotHandler(deps),
    id: "create_snapshot",
    inputSchema: createSnapshotInputSchema,
    outcome: "Maak immutable QuerySnapshot van huidige zoekresultaten",
    outputSchema: snapshotViewSchema,
  });

  const listSnapshots = defineCapability({
    authorization: { permission: PERM_SLICE_READ },
    bindings: dualBindings("GET", "/v1/snapshots", "list_snapshots"),
    effect: "read",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createListSnapshotsHandler(deps),
    id: "list_snapshots",
    inputSchema: listSnapshotsInputSchema,
    outcome:
      "Lijst eigen snapshots met approval- en exportstatus (metadata only)",
    outputSchema: listSnapshotsOutputSchema,
  });

  const getSnapshot = defineCapability({
    authorization: { permission: PERM_SLICE_READ },
    bindings: dualBindings("GET", "/v1/snapshots/{id}", "get_snapshot"),
    effect: "read",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createGetSnapshotHandler(deps),
    id: "get_snapshot",
    inputSchema: getSnapshotInputSchema,
    outcome: "Lees eigen immutable snapshotcontext en approvalstatus",
    outputSchema: getSnapshotOutputSchema,
  });

  const getExportStatus = defineCapability({
    authorization: { permission: PERM_EXPORT },
    bindings: dualBindings(
      "GET",
      "/v1/exports/{snapshotId}",
      "get_export_status"
    ),
    effect: "read",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createGetExportStatusHandler(deps),
    id: "get_export_status",
    inputSchema: getExportStatusInputSchema,
    outcome: "Lees exportpogingen en herstelstatus zonder exportwrite",
    outputSchema: getExportStatusOutputSchema,
  });

  const approveSnapshot = defineCapability({
    authorization: { permission: PERM_APPROVAL },
    bindings: dualBindings(
      "POST",
      "/v1/snapshots/{id}/approval",
      "approve_snapshot"
    ),
    effect: "internal-write",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createApproveSnapshotHandler(deps),
    id: "approve_snapshot",
    inputSchema: approveSnapshotInputSchema,
    outcome: "Keur een QuerySnapshot goed met actor, motivatie en expiry",
    outputSchema: approvalViewSchema,
  });

  const getSnapshotApproval = defineCapability({
    authorization: { permission: PERM_APPROVAL },
    bindings: dualBindings(
      "GET",
      "/v1/snapshots/{id}/approval",
      "get_snapshot_approval"
    ),
    effect: "read",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createGetSnapshotApprovalHandler(deps),
    id: "get_snapshot_approval",
    inputSchema: getSnapshotApprovalInputSchema,
    outcome: "Haal snapshotgebonden approval op inclusief geldigheid",
    outputSchema: getSnapshotApprovalOutputSchema,
  });

  const validateSnapshotApprovalCapability = defineCapability({
    authorization: { permission: PERM_APPROVAL },
    bindings: dualBindings(
      "POST",
      "/v1/snapshots/{id}/approval/validate",
      "validate_snapshot_approval"
    ),
    effect: "read",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createValidateSnapshotApprovalHandler(deps),
    id: "validate_snapshot_approval",
    inputSchema: validateSnapshotApprovalInputSchema,
    outcome: "Controleer of een onverlopen approval voor deze snapshot geldt",
    outputSchema: validateSnapshotApprovalOutputSchema,
  });

  const commitExportCapability = defineCapability({
    authorization: { permission: PERM_EXPORT },
    bindings: dualBindings("POST", "/v1/exports", "commit_export"),
    effect: "internal-write",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createCommitExportHandler(deps),
    id: "commit_export",
    inputSchema: commitExportInputSchema,
    outcome:
      "Exporteer goedgekeurde aanvragen naar Spott (idempotent create per aanvraag)",
    outputSchema: commitExportOutputSchema,
  });

  const markeerAanvraag = defineCapability({
    authorization: { permission: ROLE_RECRUITER },
    bindings: dualBindings(
      "POST",
      "/v1/aanvragen/{id}/markering",
      "markeer_aanvraag"
    ),
    effect: "internal-write",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createMarkeerAanvraagHandler(deps),
    id: "markeer_aanvraag",
    inputSchema: markeerAanvraagInputSchema,
    outcome: "Markeer aanvraag relevant, niet relevant of gevolgd",
    outputSchema: markeerAanvraagOutputSchema,
  });

  const getMarkering = defineCapability({
    authorization: { permission: PERM_SLICE_READ },
    bindings: dualBindings(
      "GET",
      "/v1/aanvragen/{id}/markering",
      "get_markering"
    ),
    effect: "read",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createGetMarkeringHandler(deps),
    id: "get_markering",
    inputSchema: getMarkeringInputSchema,
    outcome: "Lees eigen markering",
    outputSchema: getMarkeringOutputSchema,
  });

  const clearMarkering = defineCapability({
    authorization: { permission: ROLE_RECRUITER },
    bindings: dualBindings(
      "DELETE",
      "/v1/aanvragen/{id}/markering",
      "clear_markering"
    ),
    effect: "internal-write",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createClearMarkeringHandler(deps),
    id: "clear_markering",
    inputSchema: getMarkeringInputSchema,
    outcome: "Wis eigen markering met behoud van immutable auditspoor",
    outputSchema: clearMarkeringOutputSchema,
  });

  const listAlerts = defineCapability({
    authorization: { permission: ROLE_OPERATOR },
    bindings: dualBindings("GET", "/v1/alerts", "list_alerts"),
    effect: "read",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createListAlertsHandler(deps),
    id: "list_alerts",
    inputSchema: emptyObjectSchema,
    outcome: "Lijst open bron-alerts",
    outputSchema: listAlertsOutputSchema,
  });

  const getBronHealth = defineCapability({
    authorization: { permission: ROLE_OPERATOR },
    bindings: dualBindings("GET", "/v1/bronnen/{id}/health", "get_bron_health"),
    effect: "read",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createGetBronHealthHandler(deps),
    id: "get_bron_health",
    inputSchema: getBronHealthInputSchema,
    outcome: "Haal bron-gezondheid en circuitstatus op",
    outputSchema: getBronHealthOutputSchema,
  });

  const ackAlert = defineCapability({
    authorization: { permission: ROLE_OPERATOR },
    bindings: dualBindings("POST", "/v1/alerts/{id}/ack", "ack_alert"),
    effect: "internal-write",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createAckAlertHandler(deps),
    id: "ack_alert",
    inputSchema: ackAlertInputSchema,
    outcome: "Bevestig een bron-alert",
    outputSchema: ackAlertOutputSchema,
  });

  const startRun = defineCapability({
    authorization: { permission: ROLE_OPERATOR },
    bindings: dualBindings("POST", "/v1/bronnen/{id}/runs", "start_run"),
    effect: "internal-write",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createStartRunHandler(deps),
    id: "start_run",
    inputSchema: startRunInputSchema,
    outcome: "Start geplande bron-run",
    outputSchema: operatorRunOutputSchema,
  });

  const startTestImport = defineCapability({
    authorization: { permission: ROLE_OPERATOR },
    bindings: dualBindings(
      "POST",
      "/v1/bronnen/{id}/test-import",
      "start_test_import"
    ),
    effect: "internal-write",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createStartTestImportHandler(deps),
    id: "start_test_import",
    inputSchema: startTestImportInputSchema,
    outcome: "Start test-import voor een bron",
    outputSchema: operatorRunOutputSchema,
  });

  const getDashboardOverview = defineCapability({
    authorization: { permission: ROLE_OPERATOR },
    bindings: dualBindings("GET", "/v1/dashboard", "get_dashboard_overview"),
    effect: "read",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createGetDashboardOverviewHandler(deps),
    id: "get_dashboard_overview",
    inputSchema: getDashboardOverviewInputSchema,
    outcome: "Lees dashboardoverzicht van ingestie",
    outputSchema: getDashboardOverviewOutputSchema,
  });
  const getBronStats = defineCapability({
    authorization: { permission: ROLE_OPERATOR },
    bindings: dualBindings("GET", "/v1/bronnen/{id}/stats", "get_bron_stats"),
    effect: "read",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createGetBronStatsHandler(deps),
    id: "get_bron_stats",
    inputSchema: getBronStatsInputSchema,
    outcome: "Lees bronstatistieken",
    outputSchema: getBronStatsOutputSchema,
  });
  const listScrapeRuns = defineCapability({
    authorization: { permission: ROLE_OPERATOR },
    bindings: dualBindings("GET", "/v1/scrape-runs", "list_scrape_runs"),
    effect: "read",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createListScrapeRunsHandler(deps),
    id: "list_scrape_runs",
    inputSchema: listScrapeRunsInputSchema,
    outcome: "Lijst scrape runs",
    outputSchema: listScrapeRunsOutputSchema,
  });
  const getScrapeRun = defineCapability({
    authorization: { permission: ROLE_OPERATOR },
    bindings: dualBindings("GET", "/v1/scrape-runs/{id}", "get_scrape_run"),
    effect: "read",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createGetScrapeRunHandler(deps),
    id: "get_scrape_run",
    inputSchema: getScrapeRunInputSchema,
    outcome: "Lees scrape run detail",
    outputSchema: getScrapeRunOutputSchema,
  });

  const getBronOverlap = defineCapability({
    authorization: { permission: ROLE_OPERATOR },
    bindings: dualBindings("GET", "/v1/bronnen/overlap", "get_bron_overlap"),
    effect: "read",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createGetBronOverlapHandler(deps),
    id: "get_bron_overlap",
    inputSchema: getBronOverlapInputSchema,
    outcome: "Lees overlap tussen bronnen via dedup_groep",
    outputSchema: getBronOverlapOutputSchema,
  });

  const listMartsTables = defineCapability({
    authorization: { permission: PERM_MARTS_READ },
    bindings: dualBindings("GET", "/v1/marts/tables", "list_marts_tables"),
    effect: "read",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createListMartsTablesHandler(deps),
    id: "list_marts_tables",
    inputSchema: listMartsTablesInputSchema,
    outcome: "Introspecteer het live marts-schema (tabellen + kolommen)",
    outputSchema: listMartsTablesOutputSchema,
  });

  const queryMarts = defineCapability({
    authorization: { permission: PERM_MARTS_READ },
    bindings: dualBindings("POST", "/v1/marts/query", "query_marts"),
    effect: "read",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createQueryMartsHandler(deps),
    id: "query_marts",
    inputSchema: queryMartsInputSchema,
    outcome:
      "Voer een bewaakte SELECT op marts uit (dry-run, 10s timeout, 10k-rij cap, SQL in output)",
    outputSchema: queryMartsOutputSchema,
  });

  const searchQueryCatalog = defineCapability({
    authorization: { permission: PERM_MARTS_READ },
    bindings: dualBindings(
      "POST",
      "/v1/marts/query-catalog",
      "search_query_catalog"
    ),
    effect: "read",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createSearchQueryCatalogHandler(deps),
    id: "search_query_catalog",
    inputSchema: searchQueryCatalogInputSchema,
    outcome: "Doorzoek opgeslagen query-recepten vóór nieuwe SQL te schrijven",
    outputSchema: searchQueryCatalogOutputSchema,
  });

  const getDataDictionary = defineCapability({
    authorization: { permission: PERM_MARTS_READ },
    bindings: dualBindings(
      "GET",
      "/v1/marts/data-dictionary",
      "get_data_dictionary"
    ),
    effect: "read",
    failureSchema: domainFailureSchema,
    grounding: true,
    handler: createGetDataDictionaryHandler(deps),
    id: "get_data_dictionary",
    inputSchema: getDataDictionaryInputSchema,
    outcome: "Lees de statische marts data-dictionary (semantiek + metrieken)",
    outputSchema: getDataDictionaryOutputSchema,
  });

  const completeTask = defineCapability({
    authorization: { permission: ROLE_RECRUITER },
    bindings: dualBindings("POST", "/v1/agent/complete-task", "complete_task"),
    effect: "internal-write",
    failureSchema: domainFailureSchema,
    grounding: false,
    handler: createCompleteTaskHandler(deps),
    id: "complete_task",
    inputSchema: completeTaskInputSchema,
    outcome: "Rond agent-taak expliciet af (stub)",
    outputSchema: completeTaskOutputSchema,
  });

  const entries = [
    defineSliceACapabilityEntry(getOperatorContext, {
      auditClass: "access",
      reversible: true,
      sideEffectClass: "read",
      target: "internal",
      wiredTransports: [
        "mcp:get_operator_context",
        "rest:POST /v1/agent/context",
      ],
    }),
    defineSliceACapabilityEntry(searchAanvragen, {
      auditClass: "access",
      reversible: true,
      sideEffectClass: "read",
      target: "internal",
      wiredTransports: [
        "mcp:search_aanvragen",
        "rest:POST /v1/aanvragen/search",
        "ui:SearchPanel.Submit",
        "ui:SearchPanel.ApplyFilters",
      ],
    }),
    defineSliceACapabilityEntry(getAanvraag, {
      auditClass: "access",
      reversible: true,
      sideEffectClass: "read",
      target: "internal",
      wiredTransports: [
        "mcp:get_aanvraag",
        "rest:GET /v1/aanvragen/{id}",
        "ui:DetailPanel.Open",
      ],
    }),
    defineSliceACapabilityEntry(batchGetAanvragen, {
      auditClass: "access",
      reversible: true,
      sideEffectClass: "read",
      target: "internal",
      wiredTransports: [
        "mcp:batch_get_aanvragen",
        "rest:POST /v1/aanvragen/batch",
        "ui:SearchPanel.HydrateResults",
      ],
    }),
    defineSliceACapabilityEntry(listVersies, {
      auditClass: "access",
      reversible: true,
      sideEffectClass: "read",
      target: "internal",
      wiredTransports: [
        "mcp:list_versies",
        "rest:GET /v1/aanvragen/{id}/versies",
        "ui:DetailPanel.ListVersies",
      ],
    }),
    defineSliceACapabilityEntry(readRaw, {
      auditClass: "access",
      reversible: true,
      sideEffectClass: "read",
      target: "internal",
      wiredTransports: [
        "mcp:read_raw",
        "rest:GET /v1/raw/{ref}",
        "ui:DetailPanel.ReadRawPreview",
      ],
    }),
    defineSliceACapabilityEntry(evaluateSourcingAssessment, {
      auditClass: "access",
      reversible: true,
      sideEffectClass: "read",
      target: "internal",
      wiredTransports: [
        "mcp:evaluate_sourcing_assessment",
        "rest:POST /v1/sourcing/assessment",
      ],
    }),
    defineSliceACapabilityEntry(listBronnen, {
      auditClass: "access",
      reversible: true,
      sideEffectClass: "read",
      target: "internal",
      wiredTransports: [
        "mcp:list_bronnen",
        "rest:GET /v1/bronnen",
        "ui:BronPanel.List",
      ],
    }),
    defineSliceACapabilityEntry(getBron, {
      auditClass: "access",
      reversible: true,
      sideEffectClass: "read",
      target: "internal",
      wiredTransports: [
        "mcp:get_bron",
        "rest:GET /v1/bronnen/{id}",
        "ui:BronPanel.Open",
      ],
    }),
    defineSliceACapabilityEntry(createSavedSearch, {
      auditClass: "effect",
      reversible: true,
      sideEffectClass: "commit",
      target: "internal",
      wiredTransports: [
        "mcp:create_saved_search",
        "rest:POST /v1/saved-searches",
        "ui:SearchPanel.SaveQuery",
      ],
    }),
    defineSliceACapabilityEntry(listSavedSearches, {
      auditClass: "access",
      reversible: true,
      sideEffectClass: "read",
      target: "internal",
      wiredTransports: [
        "mcp:list_saved_searches",
        "rest:GET /v1/saved-searches",
      ],
    }),
    defineSliceACapabilityEntry(getSavedSearch, {
      auditClass: "access",
      reversible: true,
      sideEffectClass: "read",
      target: "internal",
      wiredTransports: [
        "mcp:get_saved_search",
        "rest:GET /v1/saved-searches/{id}",
      ],
    }),
    defineSliceACapabilityEntry(updateSavedSearch, {
      auditClass: "effect",
      reversible: true,
      sideEffectClass: "commit",
      target: "internal",
      wiredTransports: [
        "mcp:update_saved_search",
        "rest:PUT /v1/saved-searches/{id}",
      ],
    }),
    defineSliceACapabilityEntry(removeSavedSearch, {
      auditClass: "effect",
      reversible: false,
      sideEffectClass: "commit",
      target: "internal",
      wiredTransports: [
        "mcp:remove_saved_search",
        "rest:DELETE /v1/saved-searches/{id}",
      ],
    }),
    defineSliceACapabilityEntry(createSnapshot, {
      auditClass: "effect",
      reversible: false,
      sideEffectClass: "commit",
      target: "internal",
      wiredTransports: [
        "mcp:create_snapshot",
        "rest:POST /v1/snapshots",
        "ui:SearchPanel.CreateSnapshot",
      ],
    }),
    defineSliceACapabilityEntry(listSnapshots, {
      auditClass: "access",
      reversible: true,
      sideEffectClass: "read",
      target: "internal",
      wiredTransports: ["mcp:list_snapshots", "rest:GET /v1/snapshots"],
    }),
    defineSliceACapabilityEntry(getSnapshot, {
      auditClass: "access",
      reversible: true,
      sideEffectClass: "read",
      target: "internal",
      wiredTransports: ["mcp:get_snapshot", "rest:GET /v1/snapshots/{id}"],
    }),
    defineSliceACapabilityEntry(approveSnapshot, {
      auditClass: "effect",
      reversible: false,
      sideEffectClass: "proposal",
      target: "internal",
      wiredTransports: [
        "mcp:approve_snapshot",
        "rest:POST /v1/snapshots/{id}/approval",
      ],
    }),
    defineSliceACapabilityEntry(getSnapshotApproval, {
      auditClass: "access",
      reversible: true,
      sideEffectClass: "read",
      target: "internal",
      wiredTransports: [
        "mcp:get_snapshot_approval",
        "rest:GET /v1/snapshots/{id}/approval",
      ],
    }),
    defineSliceACapabilityEntry(validateSnapshotApprovalCapability, {
      auditClass: "access",
      reversible: true,
      sideEffectClass: "read",
      target: "internal",
      wiredTransports: [
        "mcp:validate_snapshot_approval",
        "rest:POST /v1/snapshots/{id}/approval/validate",
      ],
    }),
    defineSliceACapabilityEntry(commitExportCapability, {
      auditClass: "effect",
      idempotency: ["target", "canonical_vacancy_id", "action_type"],
      reversible: false,
      sideEffectClass: "commit",
      target: "external",
      wiredTransports: [
        "mcp:commit_export",
        "rest:POST /v1/exports",
        "ui:DetailPanel.Doorzetten",
      ],
    }),
    defineSliceACapabilityEntry(getExportStatus, {
      auditClass: "access",
      reversible: true,
      sideEffectClass: "read",
      target: "internal",
      wiredTransports: [
        "mcp:get_export_status",
        "rest:GET /v1/exports/{snapshotId}",
      ],
    }),
    defineSliceACapabilityEntry(markeerAanvraag, {
      auditClass: "effect",
      reversible: true,
      sideEffectClass: "commit",
      target: "internal",
      wiredTransports: [
        "mcp:markeer_aanvraag",
        "rest:POST /v1/aanvragen/{id}/markering",
        "ui:DetailPanel.Markeer",
      ],
    }),
    defineSliceACapabilityEntry(getMarkering, {
      auditClass: "access",
      reversible: true,
      sideEffectClass: "read",
      target: "internal",
      wiredTransports: [
        "mcp:get_markering",
        "rest:GET /v1/aanvragen/{id}/markering",
      ],
    }),
    defineSliceACapabilityEntry(clearMarkering, {
      auditClass: "effect",
      reversible: true,
      sideEffectClass: "commit",
      target: "internal",
      wiredTransports: [
        "mcp:clear_markering",
        "rest:DELETE /v1/aanvragen/{id}/markering",
      ],
    }),
    defineSliceACapabilityEntry(listAlerts, {
      auditClass: "access",
      reversible: true,
      sideEffectClass: "read",
      target: "internal",
      wiredTransports: [
        "mcp:list_alerts",
        "rest:GET /v1/alerts",
        "ui:AlertsPanel.List",
      ],
    }),
    defineSliceACapabilityEntry(getBronHealth, {
      auditClass: "access",
      reversible: true,
      sideEffectClass: "read",
      target: "internal",
      wiredTransports: [
        "mcp:get_bron_health",
        "rest:GET /v1/bronnen/{id}/health",
        "ui:BronHealthPanel.Open",
      ],
    }),
    defineSliceACapabilityEntry(ackAlert, {
      auditClass: "effect",
      reversible: true,
      sideEffectClass: "commit",
      target: "internal",
      wiredTransports: [
        "mcp:ack_alert",
        "rest:POST /v1/alerts/{id}/ack",
        "ui:AlertsPanel.Ack",
      ],
    }),
    defineSliceACapabilityEntry(startRun, {
      auditClass: "effect",
      reversible: false,
      sideEffectClass: "commit",
      target: "internal",
      wiredTransports: [
        "mcp:start_run",
        "rest:POST /v1/bronnen/{id}/runs",
        "ui:BronPanel.StartRun",
      ],
    }),
    defineSliceACapabilityEntry(startTestImport, {
      auditClass: "effect",
      reversible: false,
      sideEffectClass: "commit",
      target: "internal",
      wiredTransports: [
        "mcp:start_test_import",
        "rest:POST /v1/bronnen/{id}/test-import",
        "ui:BronPanel.StartTestImport",
      ],
    }),
    defineSliceACapabilityEntry(getDashboardOverview, {
      auditClass: "access",
      reversible: true,
      sideEffectClass: "read",
      target: "internal",
      wiredTransports: ["mcp:get_dashboard_overview", "rest:GET /v1/dashboard"],
    }),
    defineSliceACapabilityEntry(getBronStats, {
      auditClass: "access",
      reversible: true,
      sideEffectClass: "read",
      target: "internal",
      wiredTransports: [
        "mcp:get_bron_stats",
        "rest:GET /v1/bronnen/{id}/stats",
      ],
    }),
    defineSliceACapabilityEntry(listScrapeRuns, {
      auditClass: "access",
      reversible: true,
      sideEffectClass: "read",
      target: "internal",
      wiredTransports: ["mcp:list_scrape_runs", "rest:GET /v1/scrape-runs"],
    }),
    defineSliceACapabilityEntry(getScrapeRun, {
      auditClass: "access",
      reversible: true,
      sideEffectClass: "read",
      target: "internal",
      wiredTransports: ["mcp:get_scrape_run", "rest:GET /v1/scrape-runs/{id}"],
    }),
    defineSliceACapabilityEntry(getBronOverlap, {
      auditClass: "access",
      reversible: true,
      sideEffectClass: "read",
      target: "internal",
      wiredTransports: ["mcp:get_bron_overlap", "rest:GET /v1/bronnen/overlap"],
    }),
    defineSliceACapabilityEntry(listMartsTables, {
      auditClass: "access",
      reversible: true,
      sideEffectClass: "read",
      target: "internal",
      wiredTransports: [
        "mcp:list_marts_tables",
        "rest:GET /v1/marts/tables",
        "ui:MarktvragenChat.ListTables",
      ],
    }),
    defineSliceACapabilityEntry(queryMarts, {
      auditClass: "access",
      reversible: true,
      sideEffectClass: "read",
      target: "internal",
      wiredTransports: [
        "mcp:query_marts",
        "rest:POST /v1/marts/query",
        "ui:MarktvragenChat.Query",
      ],
    }),
    defineSliceACapabilityEntry(searchQueryCatalog, {
      auditClass: "access",
      reversible: true,
      sideEffectClass: "read",
      target: "internal",
      wiredTransports: [
        "mcp:search_query_catalog",
        "rest:POST /v1/marts/query-catalog",
      ],
    }),
    defineSliceACapabilityEntry(getDataDictionary, {
      auditClass: "access",
      reversible: true,
      sideEffectClass: "read",
      target: "internal",
      wiredTransports: [
        "mcp:get_data_dictionary",
        "rest:GET /v1/marts/data-dictionary",
      ],
    }),
    defineSliceACapabilityEntry(completeTask, {
      auditClass: "none",
      reversible: true,
      sideEffectClass: "read",
      target: "internal",
      wiredTransports: [
        "mcp:complete_task",
        "rest:POST /v1/agent/complete-task",
      ],
    }),
  ] as const;

  operatorContextCapabilities = entries.map(({ capability }) => ({
    effect: capability.effect,
    id: capability.id,
    outcome: capability.outcome,
    permission: capability.authorization.permission,
  }));

  return entries;
};

export type SliceACapabilityCatalog = ReturnType<
  typeof createSliceACapabilityCatalog
>;

export const sliceACapabilityIds = [
  "get_dashboard_overview",
  "get_bron_stats",
  "list_scrape_runs",
  "get_scrape_run",
  "get_bron_overlap",
  "list_marts_tables",
  "query_marts",
  "search_query_catalog",
  "get_data_dictionary",
  "get_operator_context",
  "search_aanvragen",
  "get_aanvraag",
  "list_versies",
  "read_raw",
  "evaluate_sourcing_assessment",
  "list_bronnen",
  "get_bron",
  "create_saved_search",
  "list_saved_searches",
  "get_saved_search",
  "update_saved_search",
  "remove_saved_search",
  "create_snapshot",
  "list_snapshots",
  "get_snapshot",
  "approve_snapshot",
  "get_snapshot_approval",
  "validate_snapshot_approval",
  "commit_export",
  "get_export_status",
  "markeer_aanvraag",
  "get_markering",
  "clear_markering",
  "list_alerts",
  "get_bron_health",
  "ack_alert",
  "start_run",
  "start_test_import",
  "complete_task",
] as const;
