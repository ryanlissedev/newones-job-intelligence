/** Percentile helpers for homogeneous success samples (ADR-0001). */

export const roundMs = (value: number): number =>
  Math.round(value * 1000) / 1000;

export const percentile = (
  sortedAscending: readonly number[],
  p: number
): number | null => {
  if (sortedAscending.length === 0) {
    return null;
  }
  if (p <= 0) {
    return sortedAscending[0] ?? null;
  }
  if (p >= 100) {
    return sortedAscending.at(-1) ?? null;
  }
  const rank = (p / 100) * (sortedAscending.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const weight = rank - lower;
  const low = sortedAscending[lower] ?? 0;
  const high = sortedAscending[upper] ?? low;
  return low + (high - low) * weight;
};

export interface LatencySummary {
  failures: number;
  n: number;
  p50: number | null;
  p95: number | null;
}

export const summarizeLatencies = (
  samplesMs: readonly number[],
  failures: number
): LatencySummary => {
  const sorted = samplesMs.toSorted((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  return {
    failures,
    n: sorted.length,
    p50: p50 === null ? null : roundMs(p50),
    p95: p95 === null ? null : roundMs(p95),
  };
};
