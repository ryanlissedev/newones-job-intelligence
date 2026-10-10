export interface BronTimeseriesPoint {
  readonly aantalGevonden: number;
  readonly avgDurationMs: number | null;
  readonly bronId: string;
  readonly bucket: string;
  readonly failed: number;
  readonly fouten: number;
  readonly gewijzigd: number;
  readonly nieuw: number;
  readonly ongewijzigd: number;
  readonly rejected: number;
  readonly runs: number;
  readonly succeeded: number;
}

export interface BronTrendBucket {
  readonly bucket: string;
  readonly failed: number;
  readonly gewijzigd: number;
  readonly nieuw: number;
  readonly rejected: number;
}

export interface BronSparkPoint {
  readonly bucket: string;
  readonly nieuw: number;
}

const byBucketAsc = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

/**
 * Collapse per-bron day buckets into a single total series for the trend chart.
 * Buckets missing a bron contribute zero for that bron (no synthetic fill).
 */
export const aggregateTotalTrend = (
  points: readonly BronTimeseriesPoint[]
): readonly BronTrendBucket[] => {
  const totals = new Map<
    string,
    { failed: number; gewijzigd: number; nieuw: number; rejected: number }
  >();

  for (const point of points) {
    const current = totals.get(point.bucket) ?? {
      failed: 0,
      gewijzigd: 0,
      nieuw: 0,
      rejected: 0,
    };
    totals.set(point.bucket, {
      failed: current.failed + point.failed,
      gewijzigd: current.gewijzigd + point.gewijzigd,
      nieuw: current.nieuw + point.nieuw,
      rejected: current.rejected + point.rejected,
    });
  }

  return [...totals.entries()]
    .toSorted(([left], [right]) => byBucketAsc(left, right))
    .map(([bucket, counts]) => ({ bucket, ...counts }));
};

/** Per-bron sparkline series keyed by bronId, sorted by bucket ascending. */
export const sparklineByBron = (
  points: readonly BronTimeseriesPoint[]
): ReadonlyMap<string, readonly BronSparkPoint[]> => {
  const grouped = new Map<string, BronSparkPoint[]>();

  for (const point of points) {
    const series = grouped.get(point.bronId) ?? [];
    series.push({ bucket: point.bucket, nieuw: point.nieuw });
    grouped.set(point.bronId, series);
  }

  for (const [bronId, series] of grouped) {
    grouped.set(
      bronId,
      series.toSorted((left, right) => byBucketAsc(left.bucket, right.bucket))
    );
  }

  return grouped;
};
