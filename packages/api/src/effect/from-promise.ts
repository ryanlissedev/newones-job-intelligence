import { Effect } from "effect";

import { mapUnknownToApiFault } from "./faults";
import type { ApiFault } from "./faults";

/**
 * Lifts a native tRPC/handler Promise into an Effect (CTP-474 Slice 9).
 * Opt-in only — default procedures keep calling Promises directly.
 */
export const fromApiPromise = <A>(
  thunk: () => Promise<A>
): Effect.Effect<A, ApiFault> =>
  Effect.tryPromise({
    catch: mapUnknownToApiFault,
    try: thunk,
  });
