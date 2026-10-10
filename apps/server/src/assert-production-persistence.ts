import type { SliceAStores } from "@ji/application/registry";

/**
 * Stores allowed to stay in-memory (and therefore lost on restart) in
 * production because no Postgres-backed implementation exists yet.
 *
 * Adding an entry here is a deliberate, dated act — grep this file to see
 * the full list. Remove an entry in the same change that wires its
 * Postgres implementation: `assertProductionPersistence` fails the build
 * if a listed entry is no longer actually volatile, so the allowlist can
 * only shrink, never rot upward silently.
 */
export const VOLATILE_STORE_ALLOWLIST: ReadonlySet<keyof SliceAStores> =
  new Set<keyof SliceAStores>([
    // 2026-08-31 RJC-390: no Postgres OperatorRunStore yet
    "operatorRuns",
  ]);

export interface AssertProductionPersistenceInput {
  /** The fully-composed stores production actually wired. */
  readonly stores: SliceAStores;
  /** The plain in-memory factory output, used as the volatility oracle: a
   * key still pointing at the exact same instance was never overridden. */
  readonly memoryStores: SliceAStores;
  readonly nodeEnv: string;
  readonly allowlist?: ReadonlySet<keyof SliceAStores>;
}

/**
 * Fails production startup loudly when any Slice A store is still the
 * process-local memory implementation. Permitted (no-op) outside
 * production so test/development composition is unaffected.
 *
 * Detection is reference-identity, not a hardcoded name list: a store key
 * still pointing at the same object `createMemorySliceAStores()` produced
 * was never overridden with a durable implementation. That means a
 * newly-added SliceAStores key nobody wires to Postgres is caught
 * automatically, with no list to keep in sync.
 */
export const assertProductionPersistence = (
  input: AssertProductionPersistenceInput
): void => {
  if (input.nodeEnv !== "production") {
    return;
  }

  const allowlist = input.allowlist ?? VOLATILE_STORE_ALLOWLIST;
  // SAFETY: input.stores is typed as SliceAStores, so Object.keys can only
  // return that interface's own property names.
  const storeKeys = Object.keys(input.stores) as (keyof SliceAStores)[];
  const volatileKeys = storeKeys.filter(
    (key) => input.stores[key] === input.memoryStores[key]
  );

  const unexpectedVolatile = volatileKeys.filter((key) => !allowlist.has(key));
  if (unexpectedVolatile.length > 0) {
    throw new Error(
      "Production startup refused: volatile in-memory store(s) wired " +
        `with no Postgres implementation and not allowlisted: ${unexpectedVolatile.join(", ")}. ` +
        "Wire a Postgres-backed implementation, or add a dated entry to " +
        "VOLATILE_STORE_ALLOWLIST in apps/server/src/assert-production-persistence.ts."
    );
  }

  const staleAllowlistEntries = [...allowlist].filter(
    (key) => !volatileKeys.includes(key)
  );
  if (staleAllowlistEntries.length > 0) {
    throw new Error(
      "Production startup refused: VOLATILE_STORE_ALLOWLIST lists store(s) " +
        `that are no longer volatile (a Postgres implementation is wired): ${staleAllowlistEntries.join(", ")}. ` +
        "Remove the entry from apps/server/src/assert-production-persistence.ts."
    );
  }
};
