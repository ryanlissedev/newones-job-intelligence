import { getInternalServerUrl } from "@ji/env/web";
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
import { Skeleton } from "@ji/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@ji/ui/components/table";
import type { Metadata, Route } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import {
  canAccessBronnen,
  sessionRoleSchema,
} from "@/app/bronnen/bronnen-window";
import type { RunsQuery } from "@/app/bronnen/runs/runs-query";
import {
  DEFAULT_RUN_KIND,
  RUN_KINDS,
  RUN_STATUSES,
  parseRunsQuery,
  runsHref,
  toScrapeRunsApiQuery,
} from "@/app/bronnen/runs/runs-query";
import {
  CapabilityRequestError,
  createCapabilityClient,
} from "@/features/job-intelligence/rest/capability-client";
import { getServerAuthClient } from "@/lib/auth-server";

export const metadata: Metadata = {
  description: "Filterbare scrape-runs voor operators.",
  title: "Scrape-runs · Bronnen · Newones",
};

interface PublicBronView {
  readonly bronId: string;
  readonly naam: string;
}

interface ObservationDistribution {
  readonly created: number;
  readonly rejected: number;
  readonly unchanged: number;
  readonly updated: number;
}

interface ScrapeRunListItem {
  readonly aantalGevonden: number;
  readonly bronId: string;
  readonly failureCode: string | null;
  readonly fouten: number;
  readonly geindigd: string | null;
  readonly gestart: string;
  readonly gewijzigd: number;
  readonly id: string;
  readonly nieuw: number;
  readonly observationDistribution: ObservationDistribution;
  readonly rejected: number;
  readonly runKind: string;
  readonly status: string;
}

interface ScrapeRunListResponse {
  readonly items: readonly ScrapeRunListItem[];
  readonly nextCursor: string | null;
}

const numberFormatter = new Intl.NumberFormat("nl-NL");

const dateTimeFormatter = new Intl.DateTimeFormat("nl-NL", {
  dateStyle: "short",
  timeStyle: "medium",
  timeZone: "Europe/Amsterdam",
});

const formatDateTime = (value: string): string =>
  dateTimeFormatter.format(new Date(value));

const formatDuration = (gestart: string, geindigd: string | null): string => {
  if (!geindigd) {
    return "—";
  }
  const ms = new Date(geindigd).getTime() - new Date(gestart).getTime();
  if (!Number.isFinite(ms) || ms < 0) {
    return "—";
  }
  if (ms < 1000) {
    return `${ms} ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)} s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
};

const statusVariant = (
  status: string
): "destructive" | "outline" | "secondary" => {
  if (status === "failed") {
    return "destructive";
  }
  if (status === "succeeded") {
    return "secondary";
  }
  return "outline";
};

const requireOperator = async (): Promise<void> => {
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
};

interface DashboardBronStats {
  readonly bronId: string | null;
  readonly naam: string | null;
}

interface DashboardOverviewForFilter {
  readonly bronnen: readonly {
    readonly stats: DashboardBronStats;
  }[];
}

/**
 * Operators cannot call GET /v1/bronnen (ROLE_RECRUITER). Reuse the operator
 * dashboard overview (same as D5) and project bronId/naam for the filter.
 */
const loadBronnen = async (): Promise<readonly PublicBronView[]> => {
  const client = createCapabilityClient({
    baseUrl: getInternalServerUrl(),
  });
  try {
    const overview = await client.get<DashboardOverviewForFilter>(
      "/v1/dashboard?window=7d",
      {
        headers: await headers(),
      }
    );
    const seen = new Set<string>();
    const items: PublicBronView[] = [];
    for (const bron of overview.bronnen) {
      const { bronId } = bron.stats;
      const { naam } = bron.stats;
      if (!bronId || !naam || seen.has(bronId)) {
        continue;
      }
      seen.add(bronId);
      items.push({ bronId, naam });
    }
    return items.toSorted((left, right) =>
      left.naam.localeCompare(right.naam, "nl")
    );
  } catch (error) {
    if (error instanceof CapabilityRequestError) {
      return [];
    }
    throw error;
  }
};

const loadRuns = async (query: RunsQuery): Promise<ScrapeRunListResponse> => {
  const client = createCapabilityClient({
    baseUrl: getInternalServerUrl(),
  });
  const qs = toScrapeRunsApiQuery(query);
  return client.get<ScrapeRunListResponse>(`/v1/scrape-runs?${qs}`, {
    headers: await headers(),
  });
};

const FilterBar = ({
  bronnen,
  query,
}: {
  readonly bronnen: readonly PublicBronView[];
  readonly query: RunsQuery;
}) => (
  <Card>
    <CardHeader className="border-b">
      <CardTitle>Filters</CardTitle>
    </CardHeader>
    <CardContent className="pt-4">
      <form
        action="/bronnen/runs"
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
        method="get"
      >
        <div className="space-y-1.5">
          <Label htmlFor="bronId">Bron</Label>
          <select
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
            defaultValue={query.bronId ?? ""}
            id="bronId"
            name="bronId"
          >
            <option value="">Alle bronnen</option>
            {bronnen.map((bron) => (
              <option key={bron.bronId} value={bron.bronId}>
                {bron.naam}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="status">Status</Label>
          <select
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
            defaultValue={query.status ?? ""}
            id="status"
            name="status"
          >
            <option value="">Alle statussen</option>
            {RUN_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="runKind">Run kind</Label>
          <select
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
            defaultValue={query.runKind}
            id="runKind"
            name="runKind"
          >
            {RUN_KINDS.map((kind) => {
              let label: string = kind;
              if (kind === "poll") {
                label = "poll (standaard)";
              } else if (kind === "all") {
                label = "all (incl. backfill)";
              }
              return (
                <option key={kind} value={kind}>
                  {label}
                </option>
              );
            })}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="failureCode">Faalcode</Label>
          <Input
            defaultValue={query.failureCode ?? ""}
            id="failureCode"
            name="failureCode"
            placeholder="bijv. FETCH_FAILED"
          />
        </div>
        <div className="flex items-end gap-2">
          <Button type="submit">Toepassen</Button>
          <Button
            nativeButton={false}
            render={
              // SAFETY: runsHref always builds /bronnen/runs (+ known query keys); typedRoutes cannot express runtime search strings.
              <Link href={runsHref({ runKind: DEFAULT_RUN_KIND }) as Route} />
            }
            variant="outline"
          >
            Reset
          </Button>
        </div>
      </form>
    </CardContent>
  </Card>
);

const RunsTable = async ({
  bronNameById,
  query,
}: {
  readonly bronNameById: ReadonlyMap<string, string>;
  readonly query: RunsQuery;
}) => {
  let listed: ScrapeRunListResponse;
  try {
    listed = await loadRuns(query);
  } catch (error) {
    if (error instanceof CapabilityRequestError) {
      return (
        <Card>
          <CardContent className="py-8 text-center text-sm text-destructive">
            Runs laden mislukt: {error.message}
          </CardContent>
        </Card>
      );
    }
    throw error;
  }

  if (listed.items.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Geen scrape-runs voor deze filters.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tijd</TableHead>
              <TableHead>Bron</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Gevonden</TableHead>
              <TableHead className="text-right">Nieuw</TableHead>
              <TableHead className="text-right">Gew.</TableHead>
              <TableHead className="text-right">Ongew.</TableHead>
              <TableHead className="text-right">Rej.</TableHead>
              <TableHead className="text-right">Fouten</TableHead>
              <TableHead className="text-right">Duur</TableHead>
              <TableHead>Faalcode</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {listed.items.map((run) => (
              <TableRow key={run.id}>
                <TableCell>
                  <Link
                    className="font-mono text-xs text-primary underline-offset-2 hover:underline"
                    href={`/bronnen/runs/${run.id}`}
                  >
                    {formatDateTime(run.gestart)}
                  </Link>
                </TableCell>
                <TableCell>
                  {bronNameById.get(run.bronId) ?? run.bronId.slice(0, 8)}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {run.runKind}
                </TableCell>
                <TableCell>
                  <Badge variant={statusVariant(run.status)}>
                    {run.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {numberFormatter.format(run.aantalGevonden)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {numberFormatter.format(run.nieuw)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {numberFormatter.format(run.gewijzigd)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {numberFormatter.format(
                    run.observationDistribution.unchanged
                  )}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {numberFormatter.format(run.rejected)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {numberFormatter.format(run.fouten)}
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">
                  {formatDuration(run.gestart, run.geindigd)}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {run.failureCode ?? "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {listed.items.length} rijen · runKind={query.runKind}
        </p>
        <div className="flex gap-2">
          {query.cursor ? (
            <Button
              nativeButton={false}
              render={
                // SAFETY: runsHref always builds /bronnen/runs (+ known query keys); typedRoutes cannot express runtime search strings.
                <Link href={runsHref(query, { cursor: undefined }) as Route} />
              }
              size="sm"
              variant="outline"
            >
              Eerste pagina
            </Button>
          ) : null}
          {listed.nextCursor ? (
            <Button
              nativeButton={false}
              render={
                // SAFETY: runsHref always builds /bronnen/runs (+ known query keys); typedRoutes cannot express runtime search strings.
                <Link
                  href={runsHref(query, { cursor: listed.nextCursor }) as Route}
                />
              }
              size="sm"
            >
              Volgende
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
};

const LoadingState = () => (
  <div aria-label="Runs laden" className="space-y-3">
    <Skeleton className="h-40 w-full" />
    <Skeleton className="h-64 w-full" />
  </div>
);

const RunsData = async ({ query }: { readonly query: RunsQuery }) => {
  const bronnen = await loadBronnen();
  const bronNameById = new Map(
    bronnen.map((bron) => [bron.bronId, bron.naam] as const)
  );
  return (
    <>
      <FilterBar bronnen={bronnen} query={query} />
      <RunsTable bronNameById={bronNameById} query={query} />
    </>
  );
};

export default async function BronnenRunsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    bronId?: string | string[];
    cursor?: string | string[];
    failureCode?: string | string[];
    runKind?: string | string[];
    status?: string | string[];
  }>;
}) {
  await requireOperator();
  const params = await searchParams;
  const query = parseRunsQuery(params);

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
            Scrape-runs
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Filter op bron, status, kind en faalcode. Backfill staat standaard
            uit (<span className="font-mono">runKind=poll</span>).
          </p>
        </div>
        <Button
          nativeButton={false}
          render={<Link href="/bronnen" />}
          variant="outline"
        >
          Terug naar bronnen
        </Button>
      </div>
      <Suspense fallback={<LoadingState />}>
        <RunsData query={query} />
      </Suspense>
    </main>
  );
}
