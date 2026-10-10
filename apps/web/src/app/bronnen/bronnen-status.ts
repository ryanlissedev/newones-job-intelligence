import type { SourceHealthSignalsView } from "@ji/application/registry";

export interface DashboardStats {
  readonly actief?: boolean | null;
  readonly lastRunAt: string | null;
  readonly lastRunStatus: string | null;
  readonly runs: number;
}

export interface DashboardHealth {
  readonly healthSignals?: SourceHealthSignalsView | null;
  readonly circuitStatus: string | null;
  readonly lastRunAt: string | null;
  readonly silenceAlertOpen: boolean | null;
}

export interface DashboardBron {
  readonly health: DashboardHealth | null;
  readonly stats: DashboardStats;
}

export interface BronCardStatus {
  readonly label:
    | "Aandacht"
    | "Gezond"
    | "Inactief"
    | "Nieuw"
    | "Onbekend"
    | "Bezig"
    | "Geblokkeerd";
  readonly variant: "destructive" | "outline" | "secondary";
}

export type AttentionReason =
  | "silence-alert-open"
  | "circuit-open"
  | "last-run-failed";

export const attentionReasonLabels = {
  "circuit-open": "Circuit open",
  "last-run-failed": "Laatste run mislukt",
  "silence-alert-open": "Stiltesignaal open",
} satisfies Record<AttentionReason, string>;

export const attentionReasons = (
  bron: DashboardBron
): readonly AttentionReason[] => {
  const reasons: AttentionReason[] = [];
  if (bron.health?.silenceAlertOpen) {
    reasons.push("silence-alert-open");
  }
  if (bron.health?.circuitStatus === "open") {
    reasons.push("circuit-open");
  }
  if (bron.stats.lastRunStatus === "failed") {
    reasons.push("last-run-failed");
  }
  return reasons;
};

const aggregateStatuses = {
  blocked: { label: "Geblokkeerd", variant: "destructive" },
  green: { label: "Gezond", variant: "secondary" },
  inactive: { label: "Inactief", variant: "outline" },
  progressing: { label: "Bezig", variant: "secondary" },
  red: { label: "Aandacht", variant: "destructive" },
  unknown: { label: "Onbekend", variant: "outline" },
} satisfies Record<
  SourceHealthSignalsView["aggregate"]["state"],
  BronCardStatus
>;

export const statusFor = (bron: DashboardBron): BronCardStatus => {
  if (bron.stats.actief === false) {
    return { label: "Inactief", variant: "outline" };
  }
  if (bron.stats.actief !== true) {
    return { label: "Onbekend", variant: "outline" };
  }
  const aggregate = bron.health?.healthSignals?.aggregate;
  if (aggregate) {
    if (
      aggregate.state === "green" &&
      (bron.health?.circuitStatus === "open" ||
        bron.health?.silenceAlertOpen === true)
    ) {
      return { label: "Aandacht", variant: "destructive" };
    }
    return aggregateStatuses[aggregate.state];
  }
  if (attentionReasons(bron).length > 0) {
    return { label: "Aandacht", variant: "destructive" };
  }
  if (bron.stats.runs === 0) {
    return { label: "Nieuw", variant: "outline" };
  }
  return { label: "Onbekend", variant: "outline" };
};
