import { getInternalServerUrl } from "@ji/env/web";
import { Badge } from "@ji/ui/components/badge";
import { Button } from "@ji/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@ji/ui/components/card";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import {
  canAccessBronnen,
  sessionRoleSchema,
} from "@/app/bronnen/bronnen-window";
import { UUID_RE } from "@/app/bronnen/runs/runs-query";
import {
  CapabilityRequestError,
  createCapabilityClient,
} from "@/features/job-intelligence/rest/capability-client";
import { getServerAuthClient } from "@/lib/auth-server";

export const metadata: Metadata = {
  description: "Detail van één scrape-run.",
  title: "Run-detail · Bronnen · Newones",
};

interface ScrapeRunDetail {
  readonly aantalGevonden: number;
  readonly bronId: string;
  readonly checkpoint: {
    readonly cursor?: number | string;
    readonly hasMore?: boolean;
    readonly offset?: number;
    readonly page?: number;
  } | null;
  readonly circuitStatus: string;
  readonly createdAt: string;
  readonly failureClass: string | null;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly failurePhase: string | null;
  readonly fouten: number;
  readonly geindigd: string | null;
  readonly gesloten: number;
  readonly gestart: string;
  readonly gewijzigd: number;
  readonly id: string;
  readonly lifecycleSummary: {
    readonly incremented: number;
    readonly reopened: number;
    readonly reset: number;
    readonly staled: number;
  };
  readonly nieuw: number;
  readonly observationDistribution: {
    readonly created: number;
    readonly rejected: number;
    readonly unchanged: number;
    readonly updated: number;
  };
  readonly rejected: number;
  readonly runKind: string;
  readonly status: string;
  readonly versionAdapter: string | null;
}

const numberFormatter = new Intl.NumberFormat("nl-NL");

const dateTimeFormatter = new Intl.DateTimeFormat("nl-NL", {
  dateStyle: "medium",
  timeStyle: "medium",
  timeZone: "Europe/Amsterdam",
});

const formatDateTime = (value: string | null): string =>
  value ? dateTimeFormatter.format(new Date(value)) : "—";

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

const loadRun = async (id: string): Promise<ScrapeRunDetail> => {
  if (!UUID_RE.test(id)) {
    notFound();
  }
  const client = createCapabilityClient({
    baseUrl: getInternalServerUrl(),
  });
  try {
    return await client.get<ScrapeRunDetail>(`/v1/scrape-runs/${id}`, {
      headers: await headers(),
    });
  } catch (error) {
    if (
      error instanceof CapabilityRequestError &&
      (error.status === 404 || error.status === 400)
    ) {
      notFound();
    }
    throw error;
  }
};

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

export default async function BronnenRunDetailPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}) {
  await requireOperator();
  const { id } = await params;
  const run = await loadRun(id);

  return (
    <main
      className="mx-auto w-full max-w-[1100px] space-y-6 px-4 py-6 sm:px-6 lg:px-8"
      id="main-content"
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-[10px] font-semibold tracking-[0.18em] text-primary uppercase">
            Run-detail
          </p>
          <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight">
            Scrape-run
          </h1>
          <p className="mt-2 font-mono text-xs text-muted-foreground">
            {run.id}
          </p>
        </div>
        <Button
          nativeButton={false}
          render={<Link href="/bronnen/runs" />}
          variant="outline"
        >
          Terug naar runs
        </Button>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 border-b">
          <CardTitle>Envelope</CardTitle>
          <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
        </CardHeader>
        <CardContent className="grid gap-4 pt-4 sm:grid-cols-2 lg:grid-cols-3">
          <Stat label="Bron" value={run.bronId} />
          <Stat label="Kind" value={run.runKind} />
          <Stat label="Circuit" value={run.circuitStatus} />
          <Stat label="Gestart" value={formatDateTime(run.gestart)} />
          <Stat label="Geëindigd" value={formatDateTime(run.geindigd)} />
          <Stat label="Adapter" value={run.versionAdapter ?? "—"} />
          <Stat label="Failure phase" value={run.failurePhase ?? "—"} />
          <Stat label="Failure class" value={run.failureClass ?? "—"} />
          <Stat label="Failure code" value={run.failureCode ?? "—"} />
          <div className="sm:col-span-2 lg:col-span-3">
            <p className="text-muted-foreground">Failure message</p>
            <p className="text-sm">{run.failureMessage ?? "—"}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Tellers</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 pt-4 sm:grid-cols-3 lg:grid-cols-6">
          <Stat
            label="Gevonden"
            value={numberFormatter.format(run.aantalGevonden)}
          />
          <Stat label="Nieuw" value={numberFormatter.format(run.nieuw)} />
          <Stat
            label="Gewijzigd"
            value={numberFormatter.format(run.gewijzigd)}
          />
          <Stat label="Rejected" value={numberFormatter.format(run.rejected)} />
          <Stat label="Gesloten" value={numberFormatter.format(run.gesloten)} />
          <Stat label="Fouten" value={numberFormatter.format(run.fouten)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Observaties</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 pt-4 sm:grid-cols-4">
          <Stat
            label="Created"
            value={numberFormatter.format(run.observationDistribution.created)}
          />
          <Stat
            label="Updated"
            value={numberFormatter.format(run.observationDistribution.updated)}
          />
          <Stat
            label="Unchanged"
            value={numberFormatter.format(
              run.observationDistribution.unchanged
            )}
          />
          <Stat
            label="Rejected"
            value={numberFormatter.format(run.observationDistribution.rejected)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Checkpoint</CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          {run.checkpoint ? (
            <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
              {JSON.stringify(run.checkpoint, null, 2)}
            </pre>
          ) : (
            <p className="text-sm text-muted-foreground">Geen checkpoint.</p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
