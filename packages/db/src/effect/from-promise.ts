import { Effect } from "effect";

import { mapUnknownToDbStoreFault } from "./faults";
import type { DbStoreFault } from "./faults";

/**
 * Lifts a native store Promise call into an Effect (CTP-473 Slice 8).
 * Opt-in only — native stores keep calling the Promise directly.
 */
export const fromStorePromise = <A>(
  thunk: () => Promise<A>
): Effect.Effect<A, DbStoreFault> =>
  Effect.tryPromise({
    catch: mapUnknownToDbStoreFault,
    try: thunk,
  });
