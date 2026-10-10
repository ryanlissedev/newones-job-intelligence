/**
 * Declared Slice A UI actions that U9 must implement.
 * check-capability-coverage fails when an action lacks MCP+REST wiring.
 */
export const sliceAUiActions = [
  {
    action: "SearchPanel.Submit",
    capabilityId: "search_aanvragen",
  },
  {
    action: "SearchPanel.ApplyFilters",
    capabilityId: "search_aanvragen",
  },
  {
    action: "SearchPanel.SaveQuery",
    capabilityId: "create_saved_search",
  },
  {
    action: "SearchPanel.CreateSnapshot",
    capabilityId: "create_snapshot",
  },
  {
    action: "DetailPanel.Open",
    capabilityId: "get_aanvraag",
  },
  {
    action: "DetailPanel.ListVersies",
    capabilityId: "list_versies",
  },
  {
    action: "DetailPanel.ReadRawPreview",
    capabilityId: "read_raw",
  },
  {
    action: "DetailPanel.Markeer",
    capabilityId: "markeer_aanvraag",
  },
  {
    action: "BronPanel.List",
    capabilityId: "list_bronnen",
  },
  {
    action: "BronPanel.Open",
    capabilityId: "get_bron",
  },
  {
    action: "BronPanel.StartRun",
    capabilityId: "start_run",
  },
  {
    action: "BronPanel.StartTestImport",
    capabilityId: "start_test_import",
  },
  {
    action: "AlertsPanel.List",
    capabilityId: "list_alerts",
  },
  {
    action: "AlertsPanel.Ack",
    capabilityId: "ack_alert",
  },
  {
    action: "BronHealthPanel.Open",
    capabilityId: "get_bron_health",
  },
] as const;

export type SliceAUiAction = (typeof sliceAUiActions)[number];
