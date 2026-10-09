import type { SourceHealthSignalsView } from "@ji/application/registry";
import { getInternalServerUrl } from "@ji/env/web";
import { Badge } from "@ji/ui/components/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@ji/ui/components/card";
import { Skeleton } from "@ji/ui/components/skeleton";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import {
  BronnenCardSparkline,
  BronnenSparklineHost,
  BronnenTrendPanel,
} from "@/app/bronnen/bronnen-charts";
import {
  healthReasonLabels,
  healthSignalRows,
  formatSilenceAlert,
} from "@/app/bronnen/bronnen-health-signals";
import {
  BronnenOverlapSection,
  BronnenOverlapSkeleton,
} from "@/app/bronnen/bronnen-overlap";
import {
  attentionReasonLabels,
  attentionReasons,
  statusFor,
} from "@/app/bronnen/bronnen-status";
import {
  aggregateTotalTrend,
  sparklineByBron,
} from "@/app/bronnen/bronnen-timeseries";
import type { BronTimeseriesPoint } from "@/app/bronnen/bronnen-timeseries";
import {
  canAccessBronnen,
  parseBronnenWindow,
  sessionRoleSchema,
  toDashboardApiWindow,
} from "@/app/bronnen/bronnen-window";
import type { BronnenWindow } from "@/app/bronnen/bronnen-window";
import { createCapabilityClient } from "@/features/job-intelligence/rest/capability-client";
import { getServerAuthClient } from "@/lib/auth-server";

export const metadata: Metadata = {
  description: "Gezondheid en opbrengst van alle ingestiebronnen.",
  title: "Bronnen · Newones",
};

interface DashboardStats {
  readonly actief: boolean | null;
  readonly bronId: string | null;
  readonly gewijzigd: number;
  readonly lastRunAt: string | null;
  readonly lastRunStatus: string | null;
  readonly naam: string | null;
  readonly nieuw: number;
  readonly ongewijzigd: number;
  /** Absent from responses served before migration 0030 shipped. */
  readonly onvolledig?: number;
  /** Absent from responses served before migration 0030 shipped. */
  readonly overgeslagen?: number;
  readonly rejected: number;
  readonly runs: number;
  readonly successRate: number | null;
}

interface DashboardHealth {
  readonly healthSignals?: SourceHealthSignalsView | null;
  readonly circuitStatus: string | null;
  readonly lastRunAt: string | null;
  readonly silenceAlertOpen: boolean | null;
}

interface DashboardBron {
  readonly health: DashboardHealth | null;
  readonly stats: DashboardStats;
}

interface DashboardOverview {
  readonly bronnen: readonly DashboardBron[];
  readonly timeseries: readonly BronTimeseriesPoint[];
  readonly total: DashboardStats;
}

const windowOptions: readonly {
  readonly label: string;
  readonly value: BronnenWindow;
}[] = [
  { label: "24 uur", value: "24h" },
  { label: "7 dagen", value: "7d" },
  { label: "30 dagen", value: "30d" },
];

const numberFormatter = new Intl.NumberFormat("nl-NL");
const DASHBOARD_TIME_ZONE = "Europe/Amsterdam";

const getOverview = async (
  window: BronnenWindow
): Promise<DashboardOverview> => {
  const client = createCapabilityClient({
    baseUrl: getInternalServerUrl(),
  });
  return client.get<DashboardOverview>(
    `/v1/dashboard?window=${toDashboardApiWindow(window)}`,
    {
      headers: await headers(),
    }
  );
};

const formatRate = (rate: number | null): string =>
  rate === null ? "—" : `${Math.round(rate * 100)}%`;

const formatDate = (value: string | null): string =>
  value
    ? new Intl.DateTimeFormat("nl-NL", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: DASHBOARD_TIME_ZONE,
      }).format(new Date(value))
    : "Nog geen runs";

const Kpi = ({
  label,
  testId,
  value,
}: {
  readonly label: string;
  readonly testId: string;
  readonly value: string | number;
}) => (
  <Card data-testid={testId} size="sm">
    <CardContent className="space-y-1">
      <p className="text-muted-foreground">{label}</p>
      <p className="font-mono text-xl font-semibold tabular-nums">{value}</p>
    </CardContent>
  </Card>
);

const DashboardData = async ({
  window,
}: {
  readonly window: BronnenWindow;
}) => {
  const overview = await getOverview(window);
  const attentionSources = overview.bronnen.filter(
    (bron) => statusFor(bron).label === "Aandacht"
  );
  const attentionCount = attentionSources.length;
  const newSources = overview.bronnen.filter(
    (bron) => statusFor(bron).label === "Nieuw"
  );
  const trend = aggregateTotalTrend(overview.timeseries);
  const sparklines = sparklineByBron(overview.timeseries);

  return (
    <>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        <Kpi
          label="Runs"
          testId="bronnen-kpi-runs"
          value={numberFormatter.format(overview.total.runs)}
        />
        <Kpi
          label="Succes%"
          testId="bronnen-kpi-success"
          value={formatRate(overview.total.successRate)}
        />
        <Kpi
          label="Nieuw"
          testId="bronnen-kpi-nieuw"
          value={numberFormatter.format(overview.total.nieuw)}
        />
        <Kpi
          label="Gewijzigd"
          testId="bronnen-kpi-gewijzigd"
          value={numberFormatter.format(overview.total.gewijzigd)}
        />
        <Kpi
          label="Ongewijzigd"
          testId="bronnen-kpi-ongewijzigd"
          value={numberFormatter.format(overview.total.ongewijzigd)}
        />
        <Kpi
          label="Overgeslagen"
          testId="bronnen-kpi-overgeslagen"
          value={numberFormatter.format(overview.total.overgeslagen ?? 0)}
        />
        <Kpi
          label="Onvolledige runs"
          testId="bronnen-kpi-onvolledig"
          value={numberFormatter.format(overview.total.onvolledig ?? 0)}
        />
        <Kpi
          label="Rejected"
          testId="bronnen-kpi-rejected"
          value={numberFormatter.format(overview.total.rejected)}
        />
        <Kpi
          label="Nieuwe bronnen"
          testId="bronnen-kpi-nieuwe-bronnen"
          value={numberFormatter.format(newSources.length)}
        />
        <Kpi
          label="Bronnen met aandacht"
          testId="bronnen-kpi-aandacht"
          value={numberFormatter.format(attentionCount)}
        />
      </div>

      <BronnenTrendPanel data={trend} />

      <section aria-labelledby="bronnen-aandacht-heading" className="space-y-3">
        <div>
          <h2
            className="font-display text-xl font-semibold"
            id="bronnen-aandacht-heading"
          >
            Bronnen met aandacht
          </h2>
          <p className="text-sm text-muted-foreground">
            Alleen bronnen met een operationeel probleem.
          </p>
        </div>
        {attentionSources.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Geen bronnen met aandacht.
          </p>
        ) : (
          <ul className="space-y-2">
            {attentionSources.map((bron) => {
              const { stats } = bron;
              const signals = bron.health?.healthSignals;
              const reasons =
                signals && signals.aggregate.state !== "green"
                  ? [healthReasonLabels[signals.aggregate.reason]]
                  : attentionReasons(bron).map(
                      (reason) => attentionReasonLabels[reason]
                    );
              return (
                <li
                  className="rounded-md border border-destructive/30 p-3 text-sm"
                  key={stats.bronId ?? stats.naam}
                >
                  <p className="font-semibold">
                    {stats.naam ?? "Onbekende bron"}
                  </p>
                  <p>{reasons.join(", ")}</p>
                  <p className="text-muted-foreground">
                    Laatste run: {stats.lastRunStatus ?? "Onbekend"} ·{" "}
                    {formatDate(bron.health?.lastRunAt ?? stats.lastRunAt)}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="bronnen-heading" className="space-y-3">
        <div>
          <h2
            className="font-display text-xl font-semibold"
            id="bronnen-heading"
          >
            Bronkaarten
          </h2>
          <p className="text-sm text-muted-foreground">
            Operationele status per ingestiebron.
          </p>
        </div>

        {overview.bronnen.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              Nog geen bronnen geregistreerd.
            </CardContent>
          </Card>
        ) : (
          <BronnenSparklineHost>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {overview.bronnen.map((bron) => {
                const status = statusFor(bron);
                const { stats } = bron;

                return (
                  <Card data-bron-card key={stats.bronId ?? stats.naam}>
                    <CardHeader className="border-b">
                      <div className="flex items-start justify-between gap-3">
                        <CardTitle>{stats.naam ?? "Onbekende bron"}</CardTitle>
                        <Badge variant={status.variant}>{status.label}</Badge>
                      </div>
                    </CardHeader>
                    <CardContent className="grid gap-3 pt-4 text-xs">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <p className="text-muted-foreground">Runs</p>
                          <p className="font-mono font-semibold">
                            {numberFormatter.format(stats.runs)}
                          </p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Succes</p>
                          <p className="font-mono font-semibold">
                            {formatRate(stats.successRate)}
                          </p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Nieuw</p>
                          <p className="font-mono font-semibold">
                            {numberFormatter.format(stats.nieuw)}
                          </p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Gewijzigd</p>
                          <p className="font-mono font-semibold">
                            {numberFormatter.format(stats.gewijzigd)}
                          </p>
                        </div>
                      </div>
                      <dl className="space-y-1.5 border-t border-border pt-3">
                        <div className="flex justify-between gap-3">
                          <dt className="text-muted-foreground">Circuit</dt>
                          <dd>{bron.health?.circuitStatus ?? "Onbekend"}</dd>
                        </div>
                        <div className="flex justify-between gap-3">
                          <dt className="text-muted-foreground">Stilte</dt>
                          <dd>
                            {formatSilenceAlert(
                              bron.health?.silenceAlertOpen ?? null
                            )}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-3">
                          <dt className="text-muted-foreground">Laatste run</dt>
                          <dd className="text-right">
                            {formatDate(
                              bron.health?.lastRunAt ?? stats.lastRunAt
                            )}
                          </dd>
                        </div>
                      </dl>
                      <details className="border-t border-border pt-3">
                        <summary className="cursor-pointer font-medium focus-visible:outline-2 focus-visible:outline-offset-4">
                          Gezondheidssignalen
                        </summary>
                        <dl className="mt-3 space-y-3">
                          {healthSignalRows(
                            bron.health?.healthSignals ?? null
                          ).map((signal) => (
                            <div key={signal.label}>
                              <dt className="font-medium">{signal.label}</dt>
                              <dd>
                                <p>{signal.reason}</p>
                                <p className="text-muted-foreground">
                                  Leeftijd meting: {signal.age}
                                </p>
                                {signal.waitingAge ? (
                                  <p className="text-muted-foreground">
                                    Wacht op eerste voortgang:{" "}
                                    {signal.waitingAge}
                                  </p>
                                ) : null}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </details>
                      {stats.runs === 0 ? (
                        <p className="text-muted-foreground">Nog geen runs</p>
                      ) : null}
                      {stats.bronId ? (
                        <BronnenCardSparkline
                          bronName={stats.naam ?? "Onbekende bron"}
                          data={sparklines.get(stats.bronId) ?? []}
                        />
                      ) : null}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </BronnenSparklineHost>
        )}
      </section>

      <Card className="border-primary/30 bg-primary/5">
        <CardHeader>
          <CardTitle>Hoe lees je deze cijfers?</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            Runs zijn uitgevoerde polls binnen het gekozen venster. Nieuw,
            gewijzigd en ongewijzigd tellen de verwerkte observaties.
            Overgeslagen zijn vacatures die de bron wel toonde maar die niet
            opnieuw zijn opgehaald, omdat ze sinds de vorige run niet
            veranderden. Onvolledige runs zijn geslaagd maar zagen niet de hele
            bron, bijvoorbeeld omdat het tijdsbudget op was.
          </p>
          <p>
            Nieuw betekent dat een bron nog geen runs heeft gehad. Dat is geen
            aandacht-item.
          </p>
          <p>
            De bronstatus volgt de afzonderlijke gezondheidssignalen. Een
            lopende verwerking kan voortgang maken terwijl de laatste volledige
            verwerking ouder is. Zonder metingen blijft de gezondheid onbekend.
          </p>
        </CardContent>
      </Card>
    </>
  );
};

const LoadingState = () => (
  <div aria-label="Bronnen laden" className="space-y-5">
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
      {Array.from({ length: 7 }, (_, index) => (
        <Skeleton className="h-20" key={index} />
      ))}
    </div>
    <Skeleton className="h-64 w-full" />
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }, (_, index) => (
        <Skeleton className="h-48" key={index} />
      ))}
    </div>
  </div>
);

export default async function BronnenPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ window?: string | string[] }>;
}) {
  const session = await getServerAuthClient().getSession({
    fetchOptions: {
      headers: await headers(),
      throw: true,
    },
  });

  const parsedSession = sessionRoleSchema.safeParse(session);
  if (
    !canAccessBronnen(
      parsedSession.success ? parsedSession.data.user.role : null
    )
  ) {
    redirect("/?toast=forbidden");
  }

  const params = await searchParams;
  const window = parseBronnenWindow(params.window);

  return (
    <main
      className="mx-auto w-full max-w-[1600px] space-y-6 px-4 py-6 sm:px-6 lg:px-8"
      id="main-content"
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[10px] font-semibold tracking-[0.18em] text-primary uppercase">
            Operator monitor
          </p>
          <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight">
            Bronnen
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Gezondheid, runs en opbrengst van je ingestiebronnen.{" "}
            <Link
              className="text-primary underline-offset-2 hover:underline"
              href="/bronnen/runs"
            >
              Bekijk scrape-runs
            </Link>
          </p>
        </div>
        <nav
          aria-label="Periode"
          className="flex flex-wrap gap-1 rounded-md border border-border p-1"
        >
          {windowOptions.map((option) => (
            <Link
              aria-current={window === option.value ? "page" : undefined}
              className={`rounded px-3 py-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                window === option.value
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent"
              }`}
              href={`/bronnen?window=${option.value}`}
              key={option.value}
            >
              {option.label}
            </Link>
          ))}
        </nav>
      </div>
      <Suspense fallback={<LoadingState />}>
        <DashboardData window={window} />
      </Suspense>
      <Suspense fallback={<BronnenOverlapSkeleton />}>
        <BronnenOverlapSection />
      </Suspense>
    </main>
  );
}
