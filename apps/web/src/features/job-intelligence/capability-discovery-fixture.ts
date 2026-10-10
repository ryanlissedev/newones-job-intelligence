import type { CapabilityDiscoveryDocument } from "./rest-job-data-adapter";

type FixtureCapability = CapabilityDiscoveryDocument["capabilities"][number];
type FixtureStatus = FixtureCapability["availability"]["status"];

interface FixtureCapabilityDefinition {
  readonly auditClass: FixtureCapability["effect"]["auditClass"];
  readonly effectClass: FixtureCapability["effect"]["class"];
  readonly grounded?: boolean;
  readonly id: string;
  readonly inputRoot?: "object";
  readonly mcpTools?: readonly string[];
  readonly outcome: string;
  readonly outputRoot?: "array" | "object";
  readonly requiredPermission: string;
  readonly reversible: boolean;
  readonly restOperations: readonly string[];
  readonly status?: FixtureStatus;
  readonly target: FixtureCapability["effect"]["target"];
  readonly uiActions?: readonly string[];
}

const availabilityByStatus = {
  disabled: {
    reason: "Deze capability is uitgeschakeld in deze synthetische fixture.",
    safeNextStep:
      "Bekijk de read-only capability-uitvoer en wacht op een echte provider.",
  },
  "fixture-stub": {
    reason:
      "Deze capability is alleen een fixture/stub en schrijft niets duurzaam.",
    safeNextStep:
      "Gebruik een read-only statusactie en claim geen voltooid effect.",
  },
  implemented: {
    reason: "De registry-handler is beschikbaar in deze synthetische fixture.",
    safeNextStep: "Voer de capability uit met de getoonde invoer.",
  },
  planned: {
    reason: "Deze capability staat op de planning en is nog niet aangesloten.",
    safeNextStep: "Gebruik een beschikbare read-only capability.",
  },
} satisfies Record<
  FixtureStatus,
  Pick<FixtureCapability["availability"], "reason" | "safeNextStep">
>;

const fixtureDefinitions: readonly FixtureCapabilityDefinition[] = [
  {
    auditClass: "access",
    effectClass: "read",
    id: "search_aanvragen",
    outcome: "Zoek aanvragen met Boolean en filters",
    requiredPermission: "recruiter",
    restOperations: ["POST /v1/aanvragen/search"],
    reversible: true,
    target: "internal",
    uiActions: ["SearchPanel.Submit", "SearchPanel.ApplyFilters"],
  },
  {
    auditClass: "access",
    effectClass: "read",
    id: "get_aanvraag",
    outcome: "Haal aanvraagdetail op (preview standaard)",
    requiredPermission: "slice-a:read",
    restOperations: ["GET /v1/aanvragen/{id}"],
    reversible: true,
    target: "internal",
    uiActions: ["DetailPanel.Open"],
  },
  {
    auditClass: "access",
    effectClass: "read",
    id: "batch_get_aanvragen",
    outcome:
      "Haal previews en versies van meerdere aanvragen op in één aanroep",
    requiredPermission: "recruiter",
    restOperations: ["POST /v1/aanvragen/batch"],
    reversible: true,
    target: "internal",
    uiActions: ["SearchPanel.HydrateResults"],
  },
  {
    auditClass: "access",
    effectClass: "read",
    id: "list_versies",
    outcome: "Lijst normalisatieversies van een aanvraag",
    outputRoot: "array",
    requiredPermission: "recruiter",
    restOperations: ["GET /v1/aanvragen/{id}/versies"],
    reversible: true,
    target: "internal",
    uiActions: ["DetailPanel.ListVersies"],
  },
  {
    auditClass: "access",
    effectClass: "read",
    id: "read_raw",
    outcome: "Lees immutable raw payload (preview standaard)",
    requiredPermission: "slice-a:read",
    restOperations: ["GET /v1/raw/{ref}"],
    reversible: true,
    target: "internal",
    uiActions: ["DetailPanel.ReadRawPreview"],
  },
  {
    auditClass: "access",
    effectClass: "read",
    id: "list_bronnen",
    outcome: "Lijst bronnen met status en laatste run",
    outputRoot: "array",
    requiredPermission: "recruiter",
    restOperations: ["GET /v1/bronnen"],
    reversible: true,
    target: "internal",
    uiActions: ["BronPanel.List"],
  },
  {
    auditClass: "access",
    effectClass: "read",
    id: "get_bron",
    outcome: "Haal bronstatus en run-samenvatting op",
    requiredPermission: "recruiter",
    restOperations: ["GET /v1/bronnen/{id}"],
    reversible: true,
    target: "internal",
    uiActions: ["BronPanel.Open"],
  },
  {
    auditClass: "effect",
    effectClass: "commit",
    id: "create_saved_search",
    outcome: "Sla zoekopdracht op met parser/schema versie",
    requiredPermission: "recruiter",
    restOperations: ["POST /v1/saved-searches"],
    reversible: true,
    target: "internal",
    uiActions: ["SearchPanel.SaveQuery"],
  },
  {
    auditClass: "access",
    effectClass: "read",
    id: "list_snapshots",
    outcome:
      "Lijst eigen snapshots met approval- en exportstatus (metadata only)",
    requiredPermission: "slice-a:read",
    restOperations: ["GET /v1/snapshots"],
    reversible: true,
    target: "internal",
  },
  {
    auditClass: "effect",
    effectClass: "commit",
    id: "create_snapshot",
    outcome: "Maak immutable QuerySnapshot van huidige zoekresultaten",
    requiredPermission: "recruiter",
    restOperations: ["POST /v1/snapshots"],
    reversible: false,
    target: "internal",
    uiActions: ["SearchPanel.CreateSnapshot"],
  },
  {
    auditClass: "effect",
    effectClass: "proposal",
    id: "approve_snapshot",
    outcome: "Keur een QuerySnapshot goed met actor, motivatie en expiry",
    requiredPermission: "approval",
    restOperations: ["POST /v1/snapshots/{id}/approval"],
    reversible: false,
    target: "internal",
  },
  {
    auditClass: "access",
    effectClass: "read",
    id: "get_snapshot_approval",
    outcome: "Haal snapshotgebonden approval op inclusief geldigheid",
    requiredPermission: "approval",
    restOperations: ["GET /v1/snapshots/{id}/approval"],
    reversible: true,
    target: "internal",
  },
  {
    auditClass: "access",
    effectClass: "read",
    id: "validate_snapshot_approval",
    outcome: "Controleer of een onverlopen approval voor deze snapshot geldt",
    requiredPermission: "approval",
    restOperations: ["POST /v1/snapshots/{id}/approval/validate"],
    reversible: true,
    target: "internal",
  },
  {
    auditClass: "effect",
    effectClass: "commit",
    id: "commit_export",
    outcome:
      "Exporteer goedgekeurde aanvragen naar Spott (idempotent create per aanvraag)",
    requiredPermission: "export",
    restOperations: ["POST /v1/exports"],
    reversible: false,
    status: "disabled",
    target: "external",
    uiActions: ["DetailPanel.Doorzetten"],
  },
  {
    auditClass: "effect",
    effectClass: "commit",
    id: "markeer_aanvraag",
    outcome: "Markeer aanvraag relevant, niet relevant of gevolgd",
    requiredPermission: "recruiter",
    restOperations: ["POST /v1/aanvragen/{id}/markering"],
    reversible: true,
    target: "internal",
    uiActions: ["DetailPanel.Markeer"],
  },
  {
    auditClass: "access",
    effectClass: "read",
    id: "list_alerts",
    outcome: "Lijst open bron-alerts",
    outputRoot: "array",
    requiredPermission: "operator",
    restOperations: ["GET /v1/alerts"],
    reversible: true,
    target: "internal",
    uiActions: ["AlertsPanel.List"],
  },
  {
    auditClass: "access",
    effectClass: "read",
    id: "get_bron_health",
    outcome: "Haal bron-gezondheid en circuitstatus op",
    requiredPermission: "operator",
    restOperations: ["GET /v1/bronnen/{id}/health"],
    reversible: true,
    target: "internal",
    uiActions: ["BronHealthPanel.Open"],
  },
  {
    auditClass: "effect",
    effectClass: "commit",
    id: "ack_alert",
    outcome: "Bevestig een bron-alert",
    requiredPermission: "operator",
    restOperations: ["POST /v1/alerts/{id}/ack"],
    reversible: true,
    target: "internal",
    uiActions: ["AlertsPanel.Ack"],
  },
  {
    auditClass: "effect",
    effectClass: "commit",
    id: "start_run",
    outcome: "Start geplande bron-run",
    requiredPermission: "operator",
    restOperations: ["POST /v1/bronnen/{id}/runs"],
    reversible: false,
    status: "fixture-stub",
    target: "internal",
    uiActions: ["BronPanel.StartRun"],
  },
  {
    auditClass: "effect",
    effectClass: "commit",
    id: "start_test_import",
    outcome: "Start test-import voor een bron",
    requiredPermission: "operator",
    restOperations: ["POST /v1/bronnen/{id}/test-import"],
    reversible: false,
    status: "fixture-stub",
    target: "internal",
    uiActions: ["BronPanel.StartTestImport"],
  },
  {
    auditClass: "none",
    effectClass: "read",
    grounded: false,
    id: "complete_task",
    outcome: "Rond agent-taak expliciet af (stub)",
    requiredPermission: "recruiter",
    restOperations: ["POST /v1/agent/complete-task"],
    reversible: true,
    status: "fixture-stub",
    target: "internal",
  },
];

const createFixtureCapability = (
  definition: FixtureCapabilityDefinition
): FixtureCapability => {
  const status = definition.status ?? "implemented";
  const executable = status === "implemented";
  const availability = availabilityByStatus[status];
  const grounded = definition.grounded ?? true;
  const evidence = executable && grounded ? "grounded-handler-output" : "none";
  return {
    allowed: true,
    availability: { ...availability, executable, status },
    effect: {
      auditClass: definition.auditClass,
      class: definition.effectClass,
      evidence,
      readback:
        executable && definition.effectClass === "read"
          ? "capability-output"
          : "not-proven",
      reversible: definition.reversible,
      target: definition.target,
    },
    id: definition.id,
    inputSchema: { type: definition.inputRoot ?? "object" },
    outcome: definition.outcome,
    outputSchema: { type: definition.outputRoot ?? "object" },
    requiredPermission: definition.requiredPermission,
    statusMap: {
      handler: "registered",
      mcpTools: definition.mcpTools ?? [definition.id],
      restOperations: definition.restOperations,
      uiActions: definition.uiActions ?? [],
    },
  };
};

const fixtureCapabilities = fixtureDefinitions.map(createFixtureCapability);

export const fixtureCapabilityDiscovery: CapabilityDiscoveryDocument = {
  capabilities: fixtureCapabilities,
  generatedFrom: "slice-a-registry",
  statusCounts: {
    denied: fixtureCapabilities.filter((capability) => !capability.allowed)
      .length,
    disabled: fixtureCapabilities.filter(
      (capability) => capability.availability.status === "disabled"
    ).length,
    executable: fixtureCapabilities.filter(
      (capability) => capability.availability.executable
    ).length,
    fixtureStub: fixtureCapabilities.filter(
      (capability) => capability.availability.status === "fixture-stub"
    ).length,
    planned: fixtureCapabilities.filter(
      (capability) => capability.availability.status === "planned"
    ).length,
  },
};

export const loadFixtureCapabilityDiscovery = () =>
  Promise.resolve(fixtureCapabilityDiscovery);
