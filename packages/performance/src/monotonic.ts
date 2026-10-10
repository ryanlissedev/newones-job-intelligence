/** Cross-runtime monotone clock in milliseconds (ADR-0001). */
export const monotonicNowMs = (): number => performance.now();

export const readBunVersion = (): string => {
  try {
    // SAFETY: Bun exposes optional `process.versions.bun`; absent in Node/browser runtimes.
    const bunVersion = (process.versions as { bun?: string }).bun;
    return bunVersion ?? "unknown";
  } catch {
    return "unknown";
  }
};
