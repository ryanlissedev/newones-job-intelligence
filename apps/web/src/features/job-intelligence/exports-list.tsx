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
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { authClient } from "@/lib/auth-client";

import type { ListedSnapshotView } from "./contracts";
import { fixtureListSnapshots } from "./fixtures";
import { createRestJobIntelligence } from "./rest-job-data-adapter";

type ListSnapshots = (input?: {
  readonly cursor?: string;
  readonly limit?: number;
}) => Promise<{
  readonly items: readonly ListedSnapshotView[];
  readonly nextCursor: string | null;
}>;

const dateTimeFormatter = new Intl.DateTimeFormat("nl-NL", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Amsterdam",
});

const formatDateTime = (value: string): string =>
  dateTimeFormatter.format(new Date(value));

const truncateQuery = (query: string | null): string => {
  if (query === null || query.trim() === "") {
    return "—";
  }
  const trimmed = query.trim();
  return trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed;
};

const STATUS_BADGES = {
  approved: { label: "Goedgekeurd", variant: "secondary" },
  committed: { label: "Geëxporteerd", variant: "default" },
  failed: { label: "Mislukt", variant: "destructive" },
  pending: { label: "In afwachting", variant: "outline" },
} satisfies Record<
  ListedSnapshotView["status"],
  {
    readonly label: string;
    readonly variant: "default" | "destructive" | "outline" | "secondary";
  }
>;

export const ExportsTable = ({
  items,
}: {
  readonly items: readonly ListedSnapshotView[];
}) => (
  <div className="overflow-x-auto rounded-lg border border-border">
    <table className="w-full text-left text-sm">
      <thead className="border-b border-border bg-muted/40 text-muted-foreground text-xs uppercase tracking-wide">
        <tr>
          <th className="px-3 py-2 font-medium">Aangemaakt</th>
          <th className="px-3 py-2 font-medium">Resultaten</th>
          <th className="px-3 py-2 font-medium">Query</th>
          <th className="px-3 py-2 font-medium">Status</th>
          <th className="px-3 py-2 font-medium">Goedkeuring</th>
          <th className="px-3 py-2 font-medium">Export</th>
          <th className="px-3 py-2 font-medium"> </th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => {
          const badge = STATUS_BADGES[item.status];
          return (
            <tr className="border-b border-border last:border-0" key={item.id}>
              <td className="px-3 py-2 whitespace-nowrap">
                {formatDateTime(item.createdAt)}
              </td>
              <td className="px-3 py-2 font-mono tabular-nums">
                {item.resultCount}
              </td>
              <td className="max-w-64 truncate px-3 py-2 font-mono text-xs">
                {truncateQuery(item.query)}
              </td>
              <td className="px-3 py-2">
                <Badge variant={badge.variant}>{badge.label}</Badge>
              </td>
              <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                {item.approval ? formatDateTime(item.approval.expiresAt) : "—"}
              </td>
              <td className="px-3 py-2 text-muted-foreground">
                {item.export
                  ? `${item.export.status} · ${item.export.externalIdCount} id's`
                  : "—"}
              </td>
              <td className="px-3 py-2 text-right">
                <Link
                  className="text-primary text-xs underline-offset-2 hover:underline"
                  href={`/snapshots/${item.id}`}
                >
                  Bekijk
                </Link>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
);

export const ExportsView = ({
  error,
  items,
  loading,
  nextCursor,
  onLoadMore,
}: {
  readonly error: string | null;
  readonly items: readonly ListedSnapshotView[];
  readonly loading: boolean;
  readonly nextCursor: string | null;
  readonly onLoadMore: (cursor: string) => void;
}) => {
  if (error) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-destructive">
          {error}
        </CardContent>
      </Card>
    );
  }

  if (!loading && items.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Nog geen snapshots
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <ExportsTable items={items} />
      {loading ? (
        <p className="text-muted-foreground text-sm">Snapshots laden…</p>
      ) : null}
      {nextCursor ? (
        <Button
          disabled={loading}
          onClick={() => onLoadMore(nextCursor)}
          variant="outline"
        >
          Meer laden
        </Button>
      ) : null}
    </div>
  );
};

export const ExportsList = ({
  listSnapshots,
}: {
  readonly listSnapshots: ListSnapshots;
}) => {
  const [items, setItems] = useState<readonly ListedSnapshotView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadPage = useCallback(
    async (cursor?: string) => {
      setLoading(true);
      setLoadError(null);
      try {
        const page = await listSnapshots({ cursor });
        setItems((current) =>
          cursor ? [...current, ...page.items] : page.items
        );
        setNextCursor(page.nextCursor);
      } catch (error) {
        setLoadError(
          error instanceof Error ? error.message : "Snapshots laden is mislukt."
        );
      } finally {
        setLoading(false);
      }
    },
    [listSnapshots]
  );

  useEffect(() => {
    void loadPage();
  }, [loadPage]);

  return (
    <ExportsView
      error={loadError}
      items={items}
      loading={loading}
      nextCursor={nextCursor}
      onLoadMore={loadPage}
    />
  );
};

const ExportsShellFrame = ({ children }: { readonly children: ReactNode }) => (
  <main
    className="mx-auto w-full max-w-[1600px] space-y-6 px-4 py-6 sm:px-6 lg:px-8"
    id="main-content"
  >
    <div>
      <p className="font-mono text-[10px] font-semibold tracking-[0.18em] text-primary uppercase">
        Snapshots
      </p>
      <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight">
        Exports
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Vastgelegde zoeksnapshots met hun goedkeuring- en exportstatus.
      </p>
    </div>
    <Card>
      <CardHeader>
        <CardTitle>Snapshots</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  </main>
);

export const ExportsPageShell = () => {
  const { data: session, isPending } = authClient.useSession();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const actions = useMemo(
    () =>
      fixturesEnabled || !session ? null : createRestJobIntelligence().actions,
    [session]
  );

  if (fixturesEnabled) {
    return (
      <ExportsShellFrame>
        <ExportsList listSnapshots={fixtureListSnapshots} />
      </ExportsShellFrame>
    );
  }

  if (!mounted || isPending) {
    return (
      <ExportsShellFrame>
        <p className="text-muted-foreground text-sm">Snapshots laden…</p>
      </ExportsShellFrame>
    );
  }

  if (!session || !actions) {
    return (
      <ExportsShellFrame>
        <Card>
          <CardContent className="space-y-4 py-8 text-center">
            <p className="text-sm text-muted-foreground">
              Log in om snapshots en exports te bekijken.
            </p>
            <Button render={<Link href="/login" />} nativeButton={false}>
              Inloggen
            </Button>
          </CardContent>
        </Card>
      </ExportsShellFrame>
    );
  }

  return (
    <ExportsShellFrame>
      <ExportsList listSnapshots={actions.listSnapshots} />
    </ExportsShellFrame>
  );
};
