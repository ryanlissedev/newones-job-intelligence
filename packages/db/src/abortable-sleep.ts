/** Resolves early if `signal` aborts mid-sleep instead of waiting out `ms`. */
export const abortableSleep = (
  ms: number,
  signal: AbortSignal
): Promise<void> => {
  if (signal.aborted) {
    return Promise.resolve();
  }
  // oxlint-disable-next-line promise/avoid-new -- bridges the abort event and the timer into one promise; neither has a promise API of its own
  return new Promise((resolve) => {
    // SAFETY: widens the literal `undefined` to the handle's eventual type;
    // `current` is always set before `onAbort` can read it, since the
    // listener is added synchronously after this initializer runs.
    const timerHandle = {
      current: undefined as ReturnType<typeof setTimeout> | undefined,
    };
    const onAbort = (): void => {
      clearTimeout(timerHandle.current);
      resolve();
    };
    timerHandle.current = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
};
