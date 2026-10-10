import { Effect } from "effect";

import { mapUnknownToTransportFault } from "./faults";
import type { TransportFault } from "./faults";

/**
 * Lifts a native transport Promise call into an Effect (CTP-474 Slice 9).
 * Opt-in only — default REST/MCP/tRPC handlers keep calling Promises directly.
 */
export const fromTransportPromise = <A>(
  thunk: () => Promise<A>
): Effect.Effect<A, TransportFault> =>
  Effect.tryPromise({
    catch: mapUnknownToTransportFault,
    try: thunk,
  });
