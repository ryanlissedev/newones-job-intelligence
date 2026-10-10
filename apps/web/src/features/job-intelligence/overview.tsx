"use client";

import { fixturesEnabled } from "@ji/env/web";
import { Button } from "@ji/ui/components/button";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { authClient } from "@/lib/auth-client";

import { fixtureJobDataAdapter } from "./fixtures";
import {
  buildOverviewSearchRequest,
  createOverviewSnapshot,
  getOverviewStatus,
} from "./overview-contract";
import type { OverviewSnapshot, OverviewStatus } from "./overview-contract";
import {
  contractLabels,
  searchStatusLabels,
  sourceLabel,
} from "./presentation";
import { createRestJobIntelligence } from "./rest-job-data-adapter";
import type { FacetCount, JobDataAdapter } from "./types";

const numberFormatter = new Intl.NumberFormat("nl-NL");

export type OverviewHeadingLevel = "h1" | "h2";

const OverviewHeading = ({
  children,
  className,
  level,
}: {
  readonly children: React.ReactNode;
  readonly className: string;
  readonly level: OverviewHeadingLevel;
}) => {
  if (level === "h2") {
    return <h2 className={className}>{children}</h2>;
  }
  return <h1 className={className}>{children}</h1>;
};

interface PanelProps {
  readonly children: React.ReactNode;
  readonly className?: string;
  readonly subtitle?: string;
  readonly title: string;
}

const Panel = ({ children, className = "", subtitle, title }: PanelProps) => (
  <section
    className={`rounded-lg border border-border bg-card p-4 ${className}`}
  >
    <div className="mb-3">
      <h2 className="font-display text-sm font-semibold">{title}</h2>
      {subtitle ? (
        <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
      ) : null}
    </div>
    {children}
  </section>
);

const Metric = ({
  label,
  note,
  value,
}: {
  readonly label: string;
  readonly note: string;
  readonly value: string;
}) => (
  <div className="rounded-lg border border-border bg-card p-4">
    <p className="text-xs text-muted-foreground">{label}</p>
    <p className="mt-1 font-mono text-2xl font-semibold tabular-nums">
      {value}
    </p>
    <p className="mt-1 text-[11px] text-muted-foreground">{note}</p>
  </div>
);

const FacetLinkList = ({
  emptyLabel,
  facets,
  hrefKey,
  labels,
  linkListLabel,
}: {
  readonly emptyLabel: string;
  readonly facets: readonly FacetCount[];
  readonly hrefKey: "contract" | "location" | "source" | "status";
  readonly labels?: ReadonlyMap<string, string>;
  readonly linkListLabel: string;
}) => {
  if (facets.length === 0) {
    return <p className="text-xs text-muted-foreground">{emptyLabel}</p>;
  }

  return (
    <ul aria-label={linkListLabel} className="divide-y divide-border">
      {facets.map(({ count, value }) => {
        const label = labels?.get(value) ?? sourceLabel(value);
        return (
          <li key={value}>
            <Link
              href={{ pathname: "/jobs", query: { [hrefKey]: value } }}
              className="flex min-h-11 items-center gap-3 rounded-md px-2 text-xs outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <span className="min-w-0 flex-1 truncate">{label}</span>
              <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                {numberFormatter.format(count)}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
};

const PublicLanding = () => (
  <main
    id="main-content"
    className="mx-auto flex w-full max-w-[1600px] flex-1 items-center px-4 py-12 sm:px-6 lg:px-8"
  >
    <div className="w-full max-w-3xl">
      <p className="font-mono text-[10px] font-semibold tracking-[0.18em] text-primary uppercase">
        Recruiter workspace
      </p>
      <h1 className="mt-2 max-w-3xl font-display text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
        Vind de juiste opdracht vóór de rest.
      </h1>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        Log in om actuele opdrachten uit de zoekindex te bekijken, te filteren
        en naar de bron terug te volgen.
      </p>
      <div className="mt-6 flex flex-wrap gap-2">
        <Button render={<Link href="/login" />} nativeButton={false}>
          Inloggen
        </Button>
        <Button
          render={<Link href="/jobs" />}
          nativeButton={false}
          variant="outline"
        >
          Open job search
        </Button>
      </div>
      <p className="mt-8 max-w-xl border-l-2 border-border pl-3 text-xs leading-relaxed text-muted-foreground">
        Na het inloggen tonen we actuele aantallen zodra de gegevens beschikbaar
        zijn.
      </p>
    </div>
  </main>
);

const OverviewLoading = ({
  headingLevel,
}: {
  readonly headingLevel: OverviewHeadingLevel;
}) => (
  <main
    id="main-content"
    aria-busy="true"
    className="mx-auto w-full max-w-[1600px] space-y-6 px-4 py-6 sm:px-6 lg:px-8"
  >
    <div className="space-y-2">
      <p className="font-mono text-[10px] font-semibold tracking-[0.18em] text-primary uppercase">
        Overzicht
      </p>
      <OverviewHeading
        className="max-w-3xl font-display text-3xl font-semibold tracking-tight text-balance sm:text-4xl"
        level={headingLevel}
      >
        Vind de juiste opdracht vóór de rest.
      </OverviewHeading>
      <div className="h-4 w-full max-w-2xl animate-pulse rounded bg-muted" />
    </div>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: 4 }, (_, index) => (
        <div
          className="h-24 animate-pulse rounded-lg border border-border bg-card"
          key={index}
        />
      ))}
    </div>
    <div className="grid gap-4 lg:grid-cols-3">
      {Array.from({ length: 3 }, (_, index) => (
        <div
          className="h-64 animate-pulse rounded-lg border border-border bg-card"
          key={index}
        />
      ))}
    </div>
  </main>
);

const OverviewError = ({
  headingLevel,
  message,
  onRetry,
}: {
  readonly headingLevel: OverviewHeadingLevel;
  readonly message: string;
  readonly onRetry: () => void;
}) => (
  <main
    id="main-content"
    className="mx-auto flex w-full max-w-[1600px] flex-1 items-center px-4 py-12 sm:px-6 lg:px-8"
  >
    <section
      role="alert"
      className="w-full max-w-2xl rounded-lg border border-destructive/40 bg-card p-6"
    >
      <p className="font-mono text-[10px] font-semibold tracking-[0.18em] text-destructive uppercase">
        Live overzicht niet beschikbaar
      </p>
      <OverviewHeading
        className="mt-2 font-display text-2xl font-semibold tracking-tight"
        level={headingLevel}
      >
        De actuele aantallen konden niet worden geladen.
      </OverviewHeading>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {message}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-5 min-h-11 rounded-md border border-input bg-background px-4 text-sm font-medium outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        Opnieuw proberen
      </button>
    </section>
  </main>
);

const OverviewEmpty = ({
  headingLevel,
}: {
  readonly headingLevel: OverviewHeadingLevel;
}) => (
  <main
    id="main-content"
    className="mx-auto flex w-full max-w-[1600px] flex-1 items-center px-4 py-12 sm:px-6 lg:px-8"
  >
    <section className="w-full max-w-2xl rounded-lg border border-border bg-card p-6">
      <p className="font-mono text-[10px] font-semibold tracking-[0.18em] text-primary uppercase">
        Live overzicht
      </p>
      <OverviewHeading
        className="mt-2 font-display text-2xl font-semibold tracking-tight"
        level={headingLevel}
      >
        Geen beschikbare opdrachten gevonden.
      </OverviewHeading>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        De zoekindex antwoordde succesvol, maar bevat op dit moment geen actieve
        opdrachten.
      </p>
      <Button
        render={<Link href="/jobs" />}
        nativeButton={false}
        className="mt-5"
      >
        Open job search
      </Button>
    </section>
  </main>
);

const OverviewDashboard = ({
  demo,
  headingLevel,
  onRetry,
  snapshot,
}: {
  readonly demo: boolean;
  readonly headingLevel: OverviewHeadingLevel;
  readonly onRetry: () => void;
  readonly snapshot: OverviewSnapshot;
}) => {
  const sourceLabels = useMemo(
    () => new Map(snapshot.sources.map(({ label, value }) => [value, label])),
    [snapshot.sources]
  );
  const sourceFacetCount = snapshot.facets.sources.filter(
    ({ count }) => count > 0
  ).length;
  const locationFacetCount = snapshot.facets.locations.filter(
    ({ count }) => count > 0
  ).length;

  return (
    <main
      id="main-content"
      className="mx-auto w-full max-w-[1600px] space-y-6 px-4 py-6 sm:px-6 lg:px-8"
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="font-mono text-[10px] font-semibold tracking-[0.18em] text-primary uppercase">
            {demo ? "Demo overzicht" : "Live overzicht"}
          </p>
          <OverviewHeading
            className="mt-2 max-w-3xl font-display text-3xl font-semibold tracking-tight text-balance sm:text-4xl"
            level={headingLevel}
          >
            Vind de juiste opdracht vóór de rest.
          </OverviewHeading>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Aantallen en filters komen rechtstreeks uit de{" "}
            {demo ? "demogegevens." : "actieve zoekindex."}
          </p>
          {demo ? (
            <p className="mt-2 inline-flex items-center gap-2 rounded-full border border-chart-2/40 bg-chart-2/10 px-2.5 py-1 font-mono text-[10px] text-chart-2">
              Demogegevens
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button render={<Link href="/jobs" />} nativeButton={false}>
            Open job search
          </Button>
          <Button
            render={<Link href="/jobs?q=Azure&freshness=30d" />}
            nativeButton={false}
            variant="outline"
          >
            Bekijk een zoekvoorbeeld
          </Button>
          <button
            type="button"
            onClick={onRetry}
            className="min-h-11 rounded-md border border-input bg-background px-3 text-xs font-medium outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            Vernieuwen
          </button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          label="Beschikbare opdrachten"
          note="actieve zoekindex"
          value={numberFormatter.format(snapshot.total)}
        />
        <Metric
          label="In archief"
          note={
            snapshot.archiveTotal === null
              ? "Archieftelling niet beschikbaar"
              : "zelfde zoekvraag, archief"
          }
          value={
            snapshot.archiveTotal === null
              ? "—"
              : numberFormatter.format(snapshot.archiveTotal)
          }
        />
        <Metric
          label="Bronnen met opdrachten"
          note="positieve bronfacetten uit deze zoekopdracht"
          value={numberFormatter.format(sourceFacetCount)}
        />
        <Metric
          label="Beschikbare locatiefilters"
          note="locatiefacetten uit deze zoekopdracht"
          value={numberFormatter.format(locationFacetCount)}
        />
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-2 xl:grid-cols-4">
        <Panel
          title="Opdrachten per bron"
          subtitle="Open een bronfilter in Zoeken"
        >
          <FacetLinkList
            emptyLabel="Geen bronfacetten beschikbaar."
            facets={snapshot.facets.sources}
            hrefKey="source"
            labels={sourceLabels}
            linkListLabel="Filter Zoeken op bron"
          />
        </Panel>
        <Panel
          title="Opdrachten per locatie"
          subtitle="Open een locatiefilter in Zoeken"
        >
          <FacetLinkList
            emptyLabel="Geen locatiefacetten beschikbaar."
            facets={snapshot.facets.locations}
            hrefKey="location"
            linkListLabel="Filter Zoeken op locatie"
          />
        </Panel>
        <Panel
          title="Contractvorm"
          subtitle="Open een contractfilter in Zoeken"
        >
          <FacetLinkList
            emptyLabel="Geen contractfacetten beschikbaar."
            facets={snapshot.facets.contractTypes}
            hrefKey="contract"
            labels={new Map(Object.entries(contractLabels))}
            linkListLabel="Filter Zoeken op contractvorm"
          />
        </Panel>
        <Panel title="Status" subtitle="Open een statusfilter in Zoeken">
          <FacetLinkList
            emptyLabel="Geen statusfacetten beschikbaar."
            facets={snapshot.facets.status}
            hrefKey="status"
            labels={new Map(Object.entries(searchStatusLabels))}
            linkListLabel="Filter Zoeken op status"
          />
        </Panel>
      </div>

      <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-secondary/40 px-4 py-3">
        <div>
          <h2 className="font-display text-sm font-semibold">
            Zoek verder in de actuele resultaten
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            De zoekpagina gebruikt dezelfde serverfilters en toont de herkomst
            per opdracht.
          </p>
        </div>
        <Button
          render={<Link href="/jobs" />}
          nativeButton={false}
          variant="outline"
        >
          Naar Zoeken
        </Button>
      </section>
    </main>
  );
};

const OverviewData = ({
  adapter,
  demo,
  headingLevel,
}: {
  readonly adapter: JobDataAdapter;
  readonly demo: boolean;
  readonly headingLevel: OverviewHeadingLevel;
}) => {
  const [status, setStatus] = useState<OverviewStatus>("loading");
  const [snapshot, setSnapshot] = useState<OverviewSnapshot | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>(
    "Probeer het opnieuw over een moment."
  );
  const [retryNonce, setRetryNonce] = useState(0);

  const retry = useCallback(() => {
    setStatus("loading");
    setSnapshot(null);
    setRetryNonce((current) => current + 1);
  }, []);

  useEffect(() => {
    let current = true;
    const request = buildOverviewSearchRequest();

    const load = async () => {
      try {
        const [response, sources] = await Promise.all([
          adapter.search(request),
          adapter.listSources(),
        ]);
        if (!current) {
          return;
        }
        const nextStatus = getOverviewStatus(response);
        const nextSnapshot = createOverviewSnapshot(response, sources);
        setStatus(nextStatus);
        setSnapshot(nextSnapshot);
        setErrorMessage(
          response.message ?? "Probeer het opnieuw over een moment."
        );
      } catch {
        if (!current) {
          return;
        }
        setStatus("error");
        setSnapshot(null);
        setErrorMessage("De live API reageert niet. Probeer het opnieuw.");
      }
    };

    void load();
    return () => {
      current = false;
    };
  }, [adapter, retryNonce]);

  if (status === "loading") {
    return <OverviewLoading headingLevel={headingLevel} />;
  }
  if (status === "error" || !snapshot) {
    return (
      <OverviewError
        headingLevel={headingLevel}
        message={errorMessage}
        onRetry={retry}
      />
    );
  }
  if (status === "empty") {
    return <OverviewEmpty headingLevel={headingLevel} />;
  }
  return (
    <OverviewDashboard
      demo={demo}
      headingLevel={headingLevel}
      onRetry={retry}
      snapshot={snapshot}
    />
  );
};

export const OverviewShell = ({
  headingLevel = "h1",
  serverAuthenticated = false,
}: {
  readonly headingLevel?: OverviewHeadingLevel;
  readonly serverAuthenticated?: boolean;
} = {}) => {
  const { data: session, isPending } = authClient.useSession();
  const isAuthenticated = serverAuthenticated || Boolean(session?.user.id);
  const restWiring = useMemo(
    () =>
      isAuthenticated && !fixturesEnabled ? createRestJobIntelligence() : null,
    [isAuthenticated]
  );

  if (isPending && !serverAuthenticated) {
    return <OverviewLoading headingLevel={headingLevel} />;
  }
  if (!isAuthenticated) {
    return <PublicLanding />;
  }
  if (fixturesEnabled) {
    return (
      <OverviewData
        adapter={fixtureJobDataAdapter}
        demo
        headingLevel={headingLevel}
      />
    );
  }
  if (!restWiring) {
    return <OverviewLoading headingLevel={headingLevel} />;
  }
  return (
    <OverviewData
      adapter={restWiring.adapter}
      demo={false}
      headingLevel={headingLevel}
    />
  );
};
