"use client";

import {
  Bot,
  CheckCircle2,
  CircleHelp,
  CircleOff,
  FlaskConical,
  Loader2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type {
  CapabilityDiscoveryDocument,
  CapabilityDiscoverySchema,
} from "./rest-job-data-adapter";
import { runAsync } from "./run-async";

interface CapabilityDiscoveryProps {
  readonly compact?: boolean;
  readonly load: () => Promise<CapabilityDiscoveryDocument>;
}

const statusLabel = {
  denied: "Geen toegang",
  disabled: "Uitgeschakeld",
  "fixture-stub": "Fixture / stub",
  implemented: "Beschikbaar",
  planned: "Gepland",
} as const;

type CapabilityDisplayStatus = keyof typeof statusLabel;

export const capabilityDisplayStatus = (
  capability: CapabilityDiscoveryDocument["capabilities"][number]
): CapabilityDisplayStatus =>
  capability.allowed ? capability.availability.status : "denied";

const StatusIcon = ({ status }: { status: CapabilityDisplayStatus }) => {
  if (status === "implemented") {
    return (
      <CheckCircle2 aria-hidden="true" className="size-4 text-emerald-600" />
    );
  }
  if (status === "fixture-stub") {
    return (
      <FlaskConical aria-hidden="true" className="size-4 text-amber-600" />
    );
  }
  return (
    <CircleOff aria-hidden="true" className="size-4 text-muted-foreground" />
  );
};

const effectClassLabel = {
  commit: "Commit",
  proposal: "Voorstel",
  read: "Lezen",
} as const;

const effectEvidenceLabel = {
  "grounded-handler-output": "handler-output is gegrond",
  none: "geen uitvoerbewijs",
  "validated-handler-output": "handler-output is gevalideerd",
} as const;

const readbackLabel = {
  "capability-output": "capability-output",
  "not-proven": "niet bewezen",
} as const;

const schemaRootType = (schema: CapabilityDiscoverySchema): string => {
  const { type } = schema;
  return Array.isArray(type) ? type.join(" | ") : (type ?? "JSON Schema");
};

const transportSummary = (
  statusMap: CapabilityDiscoveryDocument["capabilities"][number]["statusMap"]
): string => {
  const transports = [
    statusMap.mcpTools.length > 0
      ? `MCP (${statusMap.mcpTools.join(", ")})`
      : null,
    statusMap.restOperations.length > 0
      ? `REST (${statusMap.restOperations.join(", ")})`
      : null,
    statusMap.uiActions.length > 0
      ? `UI (${statusMap.uiActions.join(", ")})`
      : null,
  ].filter((transport): transport is string => transport !== null);
  return transports.length > 0 ? transports.join(" · ") : "Geen transport";
};

export const CapabilityMetadata = ({
  capability,
}: {
  readonly capability: CapabilityDiscoveryDocument["capabilities"][number];
}) => (
  <dl className="mt-3 grid gap-2 text-xs">
    <div>
      <dt className="font-medium">Benodigde rol/scope</dt>
      <dd className="text-muted-foreground">{capability.requiredPermission}</dd>
    </div>
    <div>
      <dt className="font-medium">Status</dt>
      <dd className="text-muted-foreground">
        {capability.allowed
          ? capability.availability.reason
          : "Niet uitvoerbaar met jouw huidige rechten."}
      </dd>
    </div>
    <div>
      <dt className="font-medium">Veilige volgende stap</dt>
      <dd className="text-muted-foreground">
        {capability.availability.safeNextStep}
      </dd>
    </div>
    <div>
      <dt className="font-medium">Effect en bewijs</dt>
      <dd className="text-muted-foreground">
        {effectClassLabel[capability.effect.class]} · {capability.effect.target}{" "}
        · {capability.effect.reversible ? "omkeerbaar" : "niet omkeerbaar"} ·{" "}
        {effectEvidenceLabel[capability.effect.evidence]}
      </dd>
    </div>
    <div>
      <dt className="font-medium">Readback</dt>
      <dd className="text-muted-foreground">
        {readbackLabel[capability.effect.readback]}
      </dd>
    </div>
    <div>
      <dt className="font-medium">Schema</dt>
      <dd className="text-muted-foreground">
        Invoer: {schemaRootType(capability.inputSchema)} · uitvoer:{" "}
        {schemaRootType(capability.outputSchema)}
      </dd>
    </div>
    <div>
      <dt className="font-medium">Handler en transport</dt>
      <dd className="text-muted-foreground">
        Handler{" "}
        {capability.statusMap.handler === "registered"
          ? "geregistreerd"
          : "ontbreekt"}{" "}
        · {transportSummary(capability.statusMap)}
      </dd>
    </div>
  </dl>
);

export const CapabilityDiscovery = ({
  compact = false,
  load,
}: CapabilityDiscoveryProps) => {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [document, setDocument] = useState<CapabilityDiscoveryDocument | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const open = async () => {
    dialogRef.current?.showModal();
    if (document || loading) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setDocument(await load());
    } catch {
      setError(
        "De actuele mogelijkheden konden niet worden geladen. Probeer het opnieuw."
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    return () => dialog?.close();
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => runAsync(open)}
        aria-label="Mogelijkheden van de assistent"
        title="Mogelijkheden (help / debug)"
        className={
          compact
            ? "grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            : "inline-flex min-h-10 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        }
      >
        {compact ? (
          <CircleHelp aria-hidden="true" className="size-4" />
        ) : (
          <>
            <Bot aria-hidden="true" className="size-4" />
            <span>Mogelijkheden</span>
          </>
        )}
      </button>
      <dialog
        ref={dialogRef}
        aria-labelledby="capability-title"
        aria-describedby="capability-description"
        className="ji-dialog max-h-[90dvh] w-[min(920px,calc(100%-2rem))] rounded-lg border border-border bg-background p-0 text-foreground shadow-xl backdrop:bg-black/40"
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-border bg-background p-5">
          <div>
            <h2 id="capability-title" className="text-xl font-semibold">
              Mogelijkheden
            </h2>
            <p
              id="capability-description"
              className="mt-1 text-sm text-muted-foreground"
            >
              Actuele mogelijkheden voor jouw rol, rechtstreeks uit dezelfde
              catalogus als REST en MCP.
            </p>
          </div>
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            aria-label="Mogelijkheden sluiten"
            className="grid size-10 shrink-0 place-items-center rounded-md outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden="true" className="size-5" />
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto p-5">
          {loading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 aria-hidden="true" className="size-4 animate-spin" />
              Mogelijkheden laden…
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {document ? (
            <>
              <p className="text-sm text-muted-foreground">
                {document.statusCounts.executable} uitvoerbaar ·{" "}
                {document.statusCounts.fixtureStub} fixture/stub ·{" "}
                {document.statusCounts.disabled} uitgeschakeld ·{" "}
                {document.statusCounts.planned} gepland ·{" "}
                {document.statusCounts.denied} geen toegang
              </p>
              <ul className="grid gap-3 md:grid-cols-2">
                {document.capabilities.map((capability) => (
                  <li
                    key={capability.id}
                    className="rounded-lg border border-border bg-card p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="font-medium">{capability.outcome}</h3>
                        <p className="mt-1 font-mono text-xs text-muted-foreground">
                          {capability.id}
                        </p>
                      </div>
                      <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium">
                        <StatusIcon
                          status={capabilityDisplayStatus(capability)}
                        />
                        {statusLabel[capabilityDisplayStatus(capability)]}
                      </span>
                    </div>
                    <CapabilityMetadata capability={capability} />
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </dialog>
    </>
  );
};
