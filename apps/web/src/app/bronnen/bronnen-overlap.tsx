import { getInternalServerUrl } from "@ji/env/web";
import { Badge } from "@ji/ui/components/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@ji/ui/components/card";
import { Skeleton } from "@ji/ui/components/skeleton";
import { headers } from "next/headers";

import { createCapabilityClient } from "@/features/job-intelligence/rest/capability-client";

interface OverlapGroup {
  readonly aanvraagCount: number;
  readonly bronCount: number;
  readonly bronIds: readonly string[];
  readonly bronNamen: readonly string[];
  readonly groepId: string;
}

interface BronShare {
  readonly bronId: string;
  readonly naam: string;
  readonly overlappingAanvragen: number;
  readonly share: number | null;
  readonly totalAanvragen: number;
}

interface BronOverlap {
  readonly overlapGroepCount: number;
  readonly perBron: readonly BronShare[];
  readonly topGroups: readonly OverlapGroup[];
}

const numberFormatter = new Intl.NumberFormat("nl-NL");

const formatShare = (share: number | null): string =>
  share === null ? "—" : `${Math.round(share * 100)}%`;

const getOverlap = async (): Promise<BronOverlap> => {
  const client = createCapabilityClient({
    baseUrl: getInternalServerUrl(),
  });
  return client.get<BronOverlap>("/v1/bronnen/overlap", {
    headers: await headers(),
  });
};

export const BronnenOverlapSkeleton = () => (
  <div aria-label="Overlap laden" className="space-y-3">
    <Skeleton className="h-24 w-full" />
    <Skeleton className="h-48 w-full" />
  </div>
);

export const BronnenOverlapSection = async () => {
  const overlap = await getOverlap();
  const sharesWithOverlap = overlap.perBron.filter(
    (row) => row.overlappingAanvragen > 0
  );

  return (
    <section aria-labelledby="bronnen-overlap-heading" className="space-y-3">
      <div>
        <h2
          className="font-display text-xl font-semibold"
          id="bronnen-overlap-heading"
        >
          Overlap tussen bronnen
        </h2>
        <p className="text-sm text-muted-foreground">
          Dedup-groepen met aanvragen op meerdere bronnen (
          <span className="font-mono">curated.dedup_groep</span>
          ). Geen tweede matching-heuristiek.
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <Card data-testid="bronnen-overlap-count">
          <CardContent className="space-y-1 pt-4">
            <p className="text-muted-foreground">Dedup-groepen ≥2 bronnen</p>
            <p className="font-mono text-2xl font-semibold tabular-nums">
              {numberFormatter.format(overlap.overlapGroepCount)}
            </p>
          </CardContent>
        </Card>
        <Card className="md:col-span-2">
          <CardContent className="space-y-1 pt-4 text-sm text-muted-foreground">
            <p>
              Bronnen per groep komen uit{" "}
              <span className="font-mono">aanvraag.bron_id</span> en{" "}
              <span className="font-mono">aanvraag_bron_link</span> — DEC-003,
              niet Motians 5 overlap-strategieën.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Top-10 overlapgroepen</CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          {overlap.topGroups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Geen dedup-groepen met meerdere bronnen.
            </p>
          ) : (
            <ul className="space-y-3">
              {overlap.topGroups.map((group) => (
                <li
                  className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3 last:border-0 last:pb-0"
                  data-overlap-groep={group.groepId}
                  key={group.groepId}
                >
                  <div className="space-y-1">
                    <p className="font-mono text-xs text-muted-foreground">
                      {group.groepId}
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {group.bronNamen.map((naam) => (
                        <Badge key={naam} variant="outline">
                          {naam}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    <dt className="text-muted-foreground">Bronnen</dt>
                    <dd className="font-mono text-right">{group.bronCount}</dd>
                    <dt className="text-muted-foreground">Aanvragen</dt>
                    <dd className="font-mono text-right">
                      {group.aanvraagCount}
                    </dd>
                  </dl>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Aandeel ook elders</CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          {sharesWithOverlap.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Geen bron heeft aanvragen die ook in een multi-bron dedup-groep
              staan.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr>
                    <th className="pb-2 font-medium">Bron</th>
                    <th className="pb-2 text-right font-medium">Totaal</th>
                    <th className="pb-2 text-right font-medium">Ook elders</th>
                    <th className="pb-2 text-right font-medium">Aandeel</th>
                  </tr>
                </thead>
                <tbody>
                  {overlap.perBron.map((row) => (
                    <tr
                      className="border-t border-border"
                      data-bron-overlap={row.bronId}
                      key={row.bronId}
                    >
                      <td className="py-2">{row.naam}</td>
                      <td className="py-2 text-right font-mono">
                        {numberFormatter.format(row.totalAanvragen)}
                      </td>
                      <td className="py-2 text-right font-mono">
                        {numberFormatter.format(row.overlappingAanvragen)}
                      </td>
                      <td className="py-2 text-right font-mono">
                        {formatShare(row.share)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
};
