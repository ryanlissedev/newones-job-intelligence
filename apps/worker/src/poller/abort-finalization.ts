/** On abort, run the fenced finalizer for whatever error ended the operation. */
export const withAbortFinalization = async <A>(
  signal: AbortSignal | undefined,
  finalize: () => Promise<void>,
  operation: () => Promise<A>
): Promise<A> => {
  try {
    signal?.throwIfAborted();
    const result = await operation();
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    if (signal?.aborted) {
      await finalize();
    }
    throw error;
  }
};
