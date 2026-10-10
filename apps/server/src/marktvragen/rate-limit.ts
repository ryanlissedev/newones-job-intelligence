/**
 * Per-user sliding-window turn limiter for the marktvragen chat. The endpoint
 * is a plain on-box streamText route — unlike the previous Trigger.dev runs
 * there is no platform-side budget cap, so this bounds LLM spend per user.
 * In-memory is deliberate: a restart resets counters, which errs towards
 * allowing, and a multi-instance deployment can swap this for a Redis bucket.
 */
export interface TurnRateLimiter {
  readonly check: (subjectId: string) => boolean;
}

const WINDOW_MS = 3_600_000;
const MAX_TRACKED_SUBJECTS = 10_000;

export const createTurnRateLimiter = ({
  maxPerWindow,
  now = () => Date.now(),
}: {
  readonly maxPerWindow: number;
  readonly now?: () => number;
}): TurnRateLimiter => {
  const buckets = new Map<string, number[]>();
  return {
    check: (subjectId) => {
      const cutoff = now() - WINDOW_MS;
      const hits = (buckets.get(subjectId) ?? []).filter(
        (timestamp) => timestamp > cutoff
      );
      if (hits.length >= maxPerWindow) {
        buckets.set(subjectId, hits);
        return false;
      }
      if (buckets.size >= MAX_TRACKED_SUBJECTS && !buckets.has(subjectId)) {
        return false;
      }
      hits.push(now());
      buckets.set(subjectId, hits);
      return true;
    },
  };
};
