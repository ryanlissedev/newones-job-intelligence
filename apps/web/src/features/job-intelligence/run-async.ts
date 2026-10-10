export const runAsync = (task: () => Promise<void>): void => {
  (async () => {
    try {
      await task();
    } catch {
      // UI mutations are fire-and-forget; errors surface via local status text.
    }
  })();
};
