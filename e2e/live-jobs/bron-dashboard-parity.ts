/**
 * Pure helpers for RJC-416 / D10: compare /bronnen DOM KPI text to
 * `get_dashboard_overview` JSON for the same window.
 */

export interface BronDashboardTotalStats {
  readonly gewijzigd: number;
  readonly nieuw: number;
  readonly ongewijzigd: number;
  readonly rejected: number;
  readonly runs: number;
  readonly successRate: number | null;
}

export interface BronDashboardOverviewLike {
  readonly bronnen: readonly {
    readonly health: {
      readonly circuitStatus: string;
      readonly silenceAlertOpen: boolean;
    } | null;
    readonly stats: {
      readonly lastRunStatus: string | null;
      readonly runs: number;
    };
  }[];
  readonly total: BronDashboardTotalStats;
}

export interface BronDashboardKpiSnapshot {
  readonly aandacht: number;
  readonly gewijzigd: number;
  readonly nieuw: number;
  readonly ongewijzigd: number;
  readonly rejected: number;
  readonly runs: number;
  /** Rounded percent 0–100, or null when successRate is null. */
  readonly successPercent: number | null;
}

const nlNumber = new Intl.NumberFormat("nl-NL");

export const formatBronDashboardRate = (rate: number | null): string =>
  rate === null ? "—" : `${Math.round(rate * 100)}%`;

export const formatBronDashboardCount = (value: number): string =>
  nlNumber.format(value);

export const attentionCountFromOverview = (
  overview: BronDashboardOverviewLike
): number =>
  overview.bronnen.filter((bron) => {
    if (
      bron.health?.silenceAlertOpen ||
      bron.health?.circuitStatus === "open" ||
      bron.stats.lastRunStatus === "failed"
    ) {
      return true;
    }
    return bron.stats.runs === 0;
  }).length;

export const kpiSnapshotFromOverview = (
  overview: BronDashboardOverviewLike
): BronDashboardKpiSnapshot => ({
  aandacht: attentionCountFromOverview(overview),
  gewijzigd: overview.total.gewijzigd,
  nieuw: overview.total.nieuw,
  ongewijzigd: overview.total.ongewijzigd,
  rejected: overview.total.rejected,
  runs: overview.total.runs,
  successPercent:
    overview.total.successRate === null
      ? null
      : Math.round(overview.total.successRate * 100),
});

/** Strip thin spaces / NBSP that nl-NL formatters may emit. */
export const normalizeDisplayedNumber = (raw: string): string =>
  raw.replaceAll(/[\u00A0\u202F\s]/gu, "").trim();

export const parseDisplayedCount = (raw: string): number => {
  // nl-NL uses "." as thousands separator (e.g. "1.234"); strip grouping only.
  const normalized = normalizeDisplayedNumber(raw).replaceAll(".", "");
  if (!/^-?\d+$/u.test(normalized)) {
    throw new Error(`Expected a whole nl-NL count, got ${JSON.stringify(raw)}`);
  }
  return Number(normalized);
};

export const parseDisplayedSuccessPercent = (raw: string): number | null => {
  const trimmed = raw.trim();
  if (trimmed === "—" || trimmed === "-") {
    return null;
  }
  const match = /^(?<percent>\d+)%$/u.exec(normalizeDisplayedNumber(trimmed));
  if (!match?.groups?.percent) {
    throw new Error(
      `Expected a percent like "42%" or "—", got ${JSON.stringify(raw)}`
    );
  }
  return Number(match.groups.percent);
};

export const assertKpiSnapshotMatchesDom = (
  expected: BronDashboardKpiSnapshot,
  dom: {
    readonly aandacht: string;
    readonly gewijzigd: string;
    readonly nieuw: string;
    readonly ongewijzigd: string;
    readonly rejected: string;
    readonly runs: string;
    readonly successPercent: string;
  }
): void => {
  const actual = {
    aandacht: parseDisplayedCount(dom.aandacht),
    gewijzigd: parseDisplayedCount(dom.gewijzigd),
    nieuw: parseDisplayedCount(dom.nieuw),
    ongewijzigd: parseDisplayedCount(dom.ongewijzigd),
    rejected: parseDisplayedCount(dom.rejected),
    runs: parseDisplayedCount(dom.runs),
    successPercent: parseDisplayedSuccessPercent(dom.successPercent),
  } satisfies BronDashboardKpiSnapshot;

  const mismatches: string[] = [];
  const keys: readonly (keyof BronDashboardKpiSnapshot)[] = [
    "aandacht",
    "gewijzigd",
    "nieuw",
    "ongewijzigd",
    "rejected",
    "runs",
    "successPercent",
  ];
  for (const key of keys) {
    if (expected[key] !== actual[key]) {
      mismatches.push(
        `${key}: expected ${String(expected[key])} got ${String(actual[key])}`
      );
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Bron dashboard DOM KPIs diverge from get_dashboard_overview: ${mismatches.join("; ")}`
    );
  }
};
