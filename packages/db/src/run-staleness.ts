export const runStalenessCutoff = (now: Date, olderThanMs: number): Date => {
  if (!Number.isFinite(olderThanMs) || olderThanMs <= 0) {
    throw new Error("Run staleness threshold must be a positive number");
  }
  return new Date(now.getTime() - olderThanMs);
};
