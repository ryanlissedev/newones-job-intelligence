"use client";

import { fixturesEnabled } from "@ji/env/web";
import { Badge } from "@ji/ui/components/badge";
import { Button } from "@ji/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@ji/ui/components/card";
import { Input } from "@ji/ui/components/input";
import { Label } from "@ji/ui/components/label";
import { Textarea } from "@ji/ui/components/textarea";
import { CheckCircle2, Upload } from "lucide-react";
import Link from "next/link";
import type { FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";

import type {
  ExportStatusView,
  SnapshotApprovalView,
  SnapshotDetailView as SnapshotWireView,
} from "./contracts";
import { fixtureJobActions } from "./fixtures";
import { createRestJobIntelligence } from "./rest-job-data-adapter";
import { CapabilityRequestError } from "./rest/capability-client";
import { runAsync } from "./run-async";
import type { JobIntelligenceActions } from "./types";

const dateTimeFormatter = new Intl.DateTimeFormat("nl-NL", {
  dateStyle: "medium",
  timeStyle: "medium",
  timeZone: "Europe/Amsterdam",
});

const formatDateTime = (value: string | null | undefined): string =>
  value ? dateTimeFormatter.format(new Date(value)) : "—";

const pad2 = (part: number): string => String(part).padStart(2, "0");

/** Default approval validity: 7 days, formatted for `datetime-local`. */
const defaultExpiryLocal = (): string => {
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  return `${expires.getFullYear()}-${pad2(expires.getMonth() + 1)}-${pad2(
    expires.getDate()
  )}T${pad2(expires.getHours())}:${pad2(expires.getMinutes())}`;
};

export const NO_APPROVAL_RIGHT = "Geen goedkeuringsrecht";

const failureMessage = (
  error: CapabilityRequestError | null,
  fallback: string
): string => error?.body.error.message ?? fallback;

const isForbidden = (error: CapabilityRequestError | null): boolean =>
  error !== null &&
  error.status === 403 &&
  error.body.error.code === "FORBIDDEN";

const isNotFound = (error: CapabilityRequestError | null): boolean =>
  error !== null &&
  (error.status === 404 || error.status === 400) &&
  error.body.error.code === "NOT_FOUND";

type SnapshotLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "denied" }
  | { readonly kind: "not-found" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly snapshot: SnapshotWireView };

type ApprovalLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "denied" }
  | { readonly kind: "none" }
  | { readonly kind: "ready"; readonly approval: SnapshotApprovalView };

type ExportLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "denied" }
  | { readonly kind: "ready"; readonly status: ExportStatusView };

const Stat = ({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string | number;
}) => (
  <div>
    <p className="text-muted-foreground">{label}</p>
    <p className="font-mono text-sm font-semibold tabular-nums">{value}</p>
  </div>
);

const attemptStatusVariant = (
  status: string
): "destructive" | "outline" | "secondary" => {
  if (status === "failed") {
    return "destructive";
  }
  if (status === "attempted" || status === "confirmed") {
    return "secondary";
  }
  return "outline";
};

export interface SnapshotDetailViewProps {
  readonly approval: ApprovalLoad;
  readonly approvalNotice: string | null;
  readonly defaultExpiry: string;
  readonly exportLoad: ExportLoad;
  readonly exportNotice: string | null;
  readonly isApproving: boolean;
  readonly isExporting: boolean;
  readonly onApprove: (event: FormEvent<HTMLFormElement>) => void;
  readonly onExport: () => void;
  readonly snapshot: SnapshotWireView;
}

const SnapshotMetaCard = ({
  snapshot,
}: {
  readonly snapshot: SnapshotWireView;
}) => (
  <Card>
    <CardHeader className="flex flex-row items-center justify-between gap-3 border-b">
      <CardTitle>Snapshot</CardTitle>
      <Badge variant="outline">{snapshot.scope}</Badge>
    </CardHeader>
    <CardContent className="grid gap-4 pt-4 sm:grid-cols-2 lg:grid-cols-3">
      <Stat label="Aangemaakt" value={formatDateTime(snapshot.createdAt)} />
      <Stat
        label="Geselecteerde opdrachten"
        value={snapshot.resultIds.length}
      />
      <Stat
        label="Zoekgeneratie"
        value={`${snapshot.freshness.searchGeneration} (seq ${snapshot.freshness.searchAppliedSequence})`}
      />
      <Stat label="Parser" value={snapshot.provenance.parserVersion} />
      <Stat label="Schema" value={snapshot.provenance.schemaVersion} />
      <Stat label="Saved search" value={snapshot.savedSearchId ?? "—"} />
      <div className="sm:col-span-2 lg:col-span-3">
        <p className="text-muted-foreground">Query-digest</p>
        <p className="break-all font-mono text-xs">{snapshot.queryDigest}</p>
      </div>
      <div className="sm:col-span-2 lg:col-span-3">
        <p className="text-muted-foreground">Selectie-digest</p>
        <p className="break-all font-mono text-xs">
          {snapshot.selectionDigest}
        </p>
      </div>
    </CardContent>
  </Card>
);

const ApprovalStateSummary = ({
  approval,
}: {
  readonly approval: ApprovalLoad;
}) => (
  <>
    {approval.kind === "loading" ? (
      <p className="text-sm text-muted-foreground">
        Goedkeuring wordt geladen…
      </p>
    ) : null}
    {approval.kind === "denied" ? (
      <p className="text-sm text-muted-foreground">{NO_APPROVAL_RIGHT}</p>
    ) : null}
    {approval.kind === "none" ? (
      <p className="text-sm text-muted-foreground">
        Nog geen goedkeuring voor deze snapshot.
      </p>
    ) : null}
    {approval.kind === "ready" ? (
      <div className="grid gap-4 sm:grid-cols-2">
        <Stat label="Akteur" value={approval.approval.actorId} />
        <Stat
          label="Geldig tot"
          value={formatDateTime(approval.approval.expiresAt)}
        />
        <Stat
          label="Vastgelegd"
          value={formatDateTime(approval.approval.createdAt)}
        />
        <div className="sm:col-span-2">
          <p className="text-muted-foreground">Motivatie</p>
          <p className="text-sm">{approval.approval.motivatie}</p>
        </div>
      </div>
    ) : null}
  </>
);

const ApprovalCard = ({
  approval,
  approvalNotice,
  defaultExpiry,
  isApproving,
  onApprove,
}: {
  readonly approval: ApprovalLoad;
  readonly approvalNotice: string | null;
  readonly defaultExpiry: string;
  readonly isApproving: boolean;
  readonly onApprove: (event: FormEvent<HTMLFormElement>) => void;
}) => (
  <Card>
    <CardHeader className="flex flex-row items-center justify-between gap-3 border-b">
      <CardTitle>Goedkeuring</CardTitle>
      {approval.kind === "ready" ? (
        <Badge variant={approval.approval.valid ? "secondary" : "destructive"}>
          {approval.approval.valid ? "geldig" : "verlopen"}
        </Badge>
      ) : null}
    </CardHeader>
    <CardContent className="space-y-4 pt-4">
      <ApprovalStateSummary approval={approval} />

      {approval.kind === "none" ? (
        <form className="space-y-3" onSubmit={onApprove}>
          <div className="space-y-1.5">
            <Label htmlFor="snapshot-motivatie">Motivatie</Label>
            <Textarea
              id="snapshot-motivatie"
              name="motivatie"
              placeholder="Waarom mogen deze opdrachten geëxporteerd worden?"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="snapshot-expires-at">Geldig tot</Label>
            <Input
              defaultValue={defaultExpiry}
              id="snapshot-expires-at"
              name="expiresAt"
              required
              type="datetime-local"
            />
          </div>
          <Button disabled={isApproving} type="submit">
            <CheckCircle2 aria-hidden="true" className="size-3.5" />
            {isApproving ? "Goedkeuren…" : "Keur snapshot goed"}
          </Button>
        </form>
      ) : null}

      {approvalNotice ? (
        <p className="text-sm text-muted-foreground" role="status">
          {approvalNotice}
        </p>
      ) : null}
    </CardContent>
  </Card>
);

const ExportAttemptList = ({
  status,
}: {
  readonly status: ExportStatusView;
}) => {
  if (status.attempts.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nog geen exportpogingen voor deze snapshot.
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {status.attempts.map((attempt) => (
        <li className="rounded-md border border-border p-3" key={attempt.id}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={attemptStatusVariant(attempt.status)}>
              {attempt.status}
            </Badge>
            <span className="font-mono text-xs">
              {attempt.canonicalVacancyId}
            </span>
            <span className="text-xs text-muted-foreground">
              {formatDateTime(attempt.createdAt)}
            </span>
          </div>
          <dl className="mt-2 grid gap-2 sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">External id</dt>
              <dd className="font-mono text-xs">{attempt.externalId ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Receipt</dt>
              <dd className="font-mono text-xs">
                {attempt.receipt
                  ? `${attempt.receipt.id} (${attempt.receipt.responseHash.slice(0, 12)}…)`
                  : "—"}
              </dd>
            </div>
            {attempt.errorMessage ? (
              <div className="sm:col-span-2">
                <dt className="text-muted-foreground">Fout</dt>
                <dd className="text-xs">{attempt.errorMessage}</dd>
              </div>
            ) : null}
          </dl>
        </li>
      ))}
    </ul>
  );
};

const ExportCard = ({
  approvalValid,
  exportLoad,
  exportNotice,
  isExporting,
  onExport,
}: {
  readonly approvalValid: boolean;
  readonly exportLoad: ExportLoad;
  readonly exportNotice: string | null;
  readonly isExporting: boolean;
  readonly onExport: () => void;
}) => (
  <Card>
    <CardHeader className="flex flex-row items-center justify-between gap-3 border-b">
      <CardTitle>Export naar Spott</CardTitle>
      {exportLoad.kind === "ready" ? (
        <Badge variant={attemptStatusVariant(exportLoad.status.status)}>
          {exportLoad.status.status}
        </Badge>
      ) : null}
    </CardHeader>
    <CardContent className="space-y-4 pt-4">
      {exportLoad.kind === "loading" ? (
        <p className="text-sm text-muted-foreground">
          Exportstatus wordt geladen…
        </p>
      ) : null}
      {exportLoad.kind === "denied" ? (
        <p className="text-sm text-muted-foreground">Geen exportrecht.</p>
      ) : null}
      {exportLoad.kind === "ready" ? (
        <ExportAttemptList status={exportLoad.status} />
      ) : null}

      <Button
        disabled={!approvalValid || isExporting}
        onClick={onExport}
        title={
          approvalValid
            ? "Commit de goedgekeurde selectie naar Spott"
            : "Export vereist een geldige goedkeuring"
        }
        type="button"
        variant="outline"
      >
        <Upload aria-hidden="true" className="size-3.5" />
        {isExporting ? "Exporteren…" : "Exporteren naar Spott"}
      </Button>

      {exportNotice ? (
        <p className="text-sm text-muted-foreground" role="status">
          {exportNotice}
        </p>
      ) : null}
    </CardContent>
  </Card>
);

/**
 * Presentational half of the snapshot screen — every state arrives via props
 * so the render spec can pin the three approval/export states without effects
 * (job-detail-render.spec.ts pattern).
 */
export const SnapshotDetailView = ({
  approval,
  approvalNotice,
  defaultExpiry,
  exportLoad,
  exportNotice,
  isApproving,
  isExporting,
  onApprove,
  onExport,
  snapshot,
}: SnapshotDetailViewProps) => {
  const approvalValid =
    approval.kind === "ready" ? approval.approval.valid : false;
  return (
    <>
      <SnapshotMetaCard snapshot={snapshot} />
      <ApprovalCard
        approval={approval}
        approvalNotice={approvalNotice}
        defaultExpiry={defaultExpiry}
        isApproving={isApproving}
        onApprove={onApprove}
      />
      <ExportCard
        approvalValid={approvalValid}
        exportLoad={exportLoad}
        exportNotice={exportNotice}
        isExporting={isExporting}
        onExport={onExport}
      />
    </>
  );
};

/**
 * Stateful client half: resolves the action surface (REST vs fixture), loads
 * snapshot / approval / export state, and owns the approve + export
 * mutations. The server page only checks auth; all capability traffic goes
 * through this component so fixture mode renders the same screen offline.
 */
export const SnapshotDetail = ({
  snapshotId,
}: {
  readonly snapshotId: string;
}) => {
  const actions: JobIntelligenceActions = useMemo(
    () =>
      fixturesEnabled ? fixtureJobActions : createRestJobIntelligence().actions,
    []
  );
  const [snapshot, setSnapshot] = useState<SnapshotLoad>({ kind: "loading" });
  const [approval, setApproval] = useState<ApprovalLoad>({ kind: "loading" });
  const [exportLoad, setExportLoad] = useState<ExportLoad>({
    kind: "loading",
  });
  const [approvalNotice, setApprovalNotice] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [isApproving, setIsApproving] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [defaultExpiry] = useState(defaultExpiryLocal);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const detail = await actions.getSnapshot(snapshotId);
        if (!cancelled) {
          setSnapshot({ kind: "ready", snapshot: detail });
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        const failure = error instanceof CapabilityRequestError ? error : null;
        if (isNotFound(failure)) {
          setSnapshot({ kind: "not-found" });
          return;
        }
        if (isForbidden(failure)) {
          setSnapshot({ kind: "denied" });
          return;
        }
        setSnapshot({
          kind: "error",
          message: failureMessage(failure, "Snapshot laden mislukt."),
        });
        return;
      }
      try {
        const approvalView = await actions.getSnapshotApproval(snapshotId);
        if (!cancelled) {
          setApproval(
            approvalView
              ? { approval: approvalView, kind: "ready" }
              : { kind: "none" }
          );
        }
      } catch (error) {
        if (!cancelled) {
          const failure =
            error instanceof CapabilityRequestError ? error : null;
          setApproval(
            isForbidden(failure) ? { kind: "denied" } : { kind: "none" }
          );
        }
      }
      try {
        const status = await actions.getExportStatus(snapshotId);
        if (!cancelled) {
          setExportLoad({ kind: "ready", status });
        }
      } catch (error) {
        if (!cancelled) {
          const failure =
            error instanceof CapabilityRequestError ? error : null;
          setExportLoad(
            isForbidden(failure) ? { kind: "denied" } : { kind: "loading" }
          );
        }
      }
    };
    runAsync(load);
    return () => {
      cancelled = true;
    };
  }, [actions, snapshotId]);

  const refreshApproval = async () => {
    try {
      const approvalView = await actions.getSnapshotApproval(snapshotId);
      setApproval(
        approvalView
          ? { approval: approvalView, kind: "ready" }
          : { kind: "none" }
      );
    } catch (error) {
      const failure = error instanceof CapabilityRequestError ? error : null;
      setApproval(isForbidden(failure) ? { kind: "denied" } : { kind: "none" });
    }
  };

  const refreshExportStatus = async () => {
    try {
      const status = await actions.getExportStatus(snapshotId);
      setExportLoad({ kind: "ready", status });
    } catch (error) {
      const failure = error instanceof CapabilityRequestError ? error : null;
      if (isForbidden(failure)) {
        setExportLoad({ kind: "denied" });
      }
    }
  };

  const onApprove = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const motivatie = String(data.get("motivatie") ?? "").trim();
    const expiresAtLocal = String(data.get("expiresAt") ?? "");
    if (motivatie === "" || expiresAtLocal === "") {
      setApprovalNotice("Vul motivatie en geldig-tot in.");
      return;
    }
    const expiresAt = new Date(expiresAtLocal).toISOString();
    setIsApproving(true);
    setApprovalNotice(null);
    runAsync(async () => {
      try {
        await actions.approveSnapshot({ expiresAt, id: snapshotId, motivatie });
        await refreshApproval();
        setApprovalNotice("Goedkeuring vastgelegd.");
      } catch (error) {
        const failure = error instanceof CapabilityRequestError ? error : null;
        setApprovalNotice(
          isForbidden(failure)
            ? NO_APPROVAL_RIGHT
            : failureMessage(failure, "Goedkeuren mislukt. Probeer opnieuw.")
        );
      } finally {
        setIsApproving(false);
      }
    });
  };

  const onExport = () => {
    setIsExporting(true);
    setExportNotice(null);
    runAsync(async () => {
      try {
        const result = await actions.commitExport(snapshotId);
        setExportNotice(
          `Export vastgelegd: ${result.summary.created} aangemaakt, ${result.summary.failed} mislukt, ${result.summary.skipped} overgeslagen.`
        );
        await refreshExportStatus();
      } catch (error) {
        const failure = error instanceof CapabilityRequestError ? error : null;
        setExportNotice(
          isForbidden(failure)
            ? "Geen exportrecht."
            : failureMessage(failure, "Exporteren mislukt. Probeer opnieuw.")
        );
      } finally {
        setIsExporting(false);
      }
    });
  };

  if (snapshot.kind === "loading") {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Snapshot wordt geladen…
      </p>
    );
  }
  if (snapshot.kind === "not-found") {
    return (
      <section className="space-y-4 rounded-lg border border-border bg-card p-8 text-center shadow-sm">
        <h2 className="text-xl font-semibold">Snapshot niet gevonden</h2>
        <p className="text-sm text-muted-foreground">
          Deze snapshot bestaat niet of is niet voor jou zichtbaar.
        </p>
        <Button nativeButton={false} render={<Link href="/jobs" />}>
          Terug naar opdrachten
        </Button>
      </section>
    );
  }
  if (snapshot.kind === "denied") {
    return (
      <section className="space-y-4 rounded-lg border border-border bg-card p-8 text-center shadow-sm">
        <h2 className="text-xl font-semibold">Geen toegang</h2>
        <p className="text-sm text-muted-foreground">
          Je sessie heeft geen recht om deze snapshot te lezen.
        </p>
        <Button nativeButton={false} render={<Link href="/jobs" />}>
          Terug naar opdrachten
        </Button>
      </section>
    );
  }
  if (snapshot.kind === "error") {
    return (
      <section className="space-y-4 rounded-lg border border-border bg-card p-8 text-center shadow-sm">
        <h2 className="text-xl font-semibold">Laden mislukt</h2>
        <p className="text-sm text-muted-foreground">{snapshot.message}</p>
      </section>
    );
  }

  return (
    <SnapshotDetailView
      approval={approval}
      approvalNotice={approvalNotice}
      defaultExpiry={defaultExpiry}
      exportLoad={exportLoad}
      exportNotice={exportNotice}
      isApproving={isApproving}
      isExporting={isExporting}
      onApprove={onApprove}
      onExport={onExport}
      snapshot={snapshot.snapshot}
    />
  );
};
