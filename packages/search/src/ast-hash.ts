import type { BooleanNode } from "@ji/domain";

import type { SearchScope } from "./partition";
import type { SearchFilters, SearchMode, SearchSort } from "./types";
import type { SearchVersion } from "./version";

type CanonicalAstEncoding =
  | readonly ["and" | "or", readonly CanonicalAstEncoding[]]
  | readonly ["not", CanonicalAstEncoding]
  | readonly ["phrase" | "term", string];

const encodeAst = (node: BooleanNode): CanonicalAstEncoding => {
  switch (node.kind) {
    case "term": {
      return ["term", node.value];
    }
    case "phrase": {
      return ["phrase", node.value];
    }
    case "not": {
      return ["not", encodeAst(node.operand)];
    }
    case "and": {
      return ["and", node.operands.map(encodeAst)];
    }
    case "or": {
      return ["or", node.operands.map(encodeAst)];
    }
    default: {
      const _exhaustive: never = node;
      throw new Error(`Unsupported boolean node: ${String(_exhaustive)}`);
    }
  }
};

const stableStringifyAst = (node: BooleanNode): string =>
  JSON.stringify(encodeAst(node));

/**
 * Deterministic codepoint-order comparison (RJC-396): `String.localeCompare`
 * without an explicit locale argument collates via the process's ICU
 * default locale, which varies punctuation/digit ordering across
 * processes/environments. That fed a SHARED Redis key, so two servers
 * under different default locales could hash the same query to different
 * keys — a silent cache miss, not a wrong result. This never varies: it's
 * plain UTF-16 code unit order, same as the default `Array.prototype.sort`.
 */
export const compareCodepoints = (left: string, right: string): -1 | 0 | 1 => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

const stableStringifyFilters = (filters: SearchFilters): string => {
  const entries = Object.entries(filters).toSorted(([left], [right]) =>
    compareCodepoints(left, right)
  );
  return JSON.stringify(Object.fromEntries(entries));
};

const hashString = async (input: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

/**
 * Sorts commutative AND/OR operands into a stable order and drops exact
 * duplicate siblings, so `a AND b` and `b AND a AND b` share a hash. Lowers
 * plain term text (Manticore's query_string matching is case-insensitive
 * under the current morphology config — see ast-hash.spec.ts for a live
 * check gated on MANTICORE_URL), but deliberately leaves phrase text
 * untouched and never reorders a NOT's single operand: those aren't proven
 * case- or order-insensitive the way plain-term AND/OR commutativity is.
 * Pure and idempotent — canonicalizeAst(canonicalizeAst(x)) is a no-op.
 *
 * dedupeSortedOperands works on already-canonicalized operands (it never
 * calls canonicalizeAst), so it can sit above canonicalizeAst as a plain
 * const without a mutual-recursion ordering problem.
 *
 * Sort key is (kind rank, stable string) — NOT operands always sort last,
 * after every positive (term/phrase/and/or) sibling. A plain string sort
 * would put "not(" before "or(", "phrase:", and "term:", which reorders a
 * negation ahead of the positive terms it was written after — changing
 * what Manticore's default ranker (proximity_bm25, sensitive to term/clause
 * order via its LCS factor) actually sees, even though nothing here
 * reorders NOT relative to the positive terms in an EQUIVALENT query. See
 * ast-hash.spec.ts and the live adapter test for a NOT-permutation case.
 */
const NEGATION_SORT_RANK = 1;
const POSITIVE_SORT_RANK = 0;

const operandSortRank = (node: BooleanNode): 0 | 1 =>
  node.kind === "not" ? NEGATION_SORT_RANK : POSITIVE_SORT_RANK;

const dedupeSortedOperands = (
  canonicalizedOperands: BooleanNode[]
): BooleanNode[] => {
  const sorted = canonicalizedOperands.toSorted((left, right) => {
    const rankDelta = operandSortRank(left) - operandSortRank(right);
    if (rankDelta !== 0) {
      return rankDelta;
    }
    return compareCodepoints(
      stableStringifyAst(left),
      stableStringifyAst(right)
    );
  });

  const deduped: BooleanNode[] = [];
  let previousKey: string | null = null;
  for (const operand of sorted) {
    const key = stableStringifyAst(operand);
    if (key !== previousKey) {
      deduped.push(operand);
      previousKey = key;
    }
  }
  return deduped;
};

export const canonicalizeAst = (node: BooleanNode): BooleanNode => {
  switch (node.kind) {
    case "term": {
      return { kind: "term", value: node.value.toLowerCase() };
    }
    case "phrase": {
      return node;
    }
    case "not": {
      return { kind: "not", operand: canonicalizeAst(node.operand) };
    }
    case "and": {
      return {
        kind: "and",
        operands: dedupeSortedOperands(node.operands.map(canonicalizeAst)),
      };
    }
    case "or": {
      return {
        kind: "or",
        operands: dedupeSortedOperands(node.operands.map(canonicalizeAst)),
      };
    }
    default: {
      const _exhaustive: never = node;
      throw new Error(`Unsupported boolean node: ${String(_exhaustive)}`);
    }
  }
};

export const hashAst = (ast: BooleanNode): Promise<string> =>
  hashString(stableStringifyAst(canonicalizeAst(ast)));

/** A browse request is structurally distinct from every valid Boolean AST. */
export const hashSearchAst = (ast: BooleanNode | null): Promise<string> =>
  ast === null ? hashString(JSON.stringify(["match_all"])) : hashAst(ast);

/** True when the AST contains text outside a NOT subtree. */
export const hasPositiveFreeText = (node: BooleanNode): boolean => {
  switch (node.kind) {
    case "term":
    case "phrase": {
      return node.value.trim().length > 0;
    }
    case "not": {
      return false;
    }
    case "and":
    case "or": {
      return node.operands.some(hasPositiveFreeText);
    }
    default: {
      const _exhaustive: never = node;
      throw new Error(`Unsupported boolean node: ${String(_exhaustive)}`);
    }
  }
};

/** True when any subtree is negated, including negation nested under AND/OR. */
export const hasNegatedClause = (node: BooleanNode): boolean => {
  switch (node.kind) {
    case "term":
    case "phrase": {
      return false;
    }
    case "not": {
      return true;
    }
    case "and":
    case "or": {
      return node.operands.some(hasNegatedClause);
    }
    default: {
      const _exhaustive: never = node;
      throw new Error(`Unsupported boolean node: ${String(_exhaustive)}`);
    }
  }
};

/** RRF can reintroduce KNN hits excluded by MATCH, so negated queries stay lexical. */
export const isHybridSearchEligible = (node: BooleanNode): boolean =>
  hasPositiveFreeText(node) && !hasNegatedClause(node);

export interface CacheKeyPage {
  limit: number;
  mode: SearchMode;
  offset: number;
  /** Partitions read (RJC-383); an active-scope page must never serve an all-scope request. */
  scope: SearchScope;
  sort: SearchSort;
}

/**
 * Hits are page-specific once the engine paginates (RJC-378), so the key
 * carries sort/offset/limit. `v4` retires every v3 entry: canonicalizeAst
 * changes what `astHash` resolves to for the same query text (RJC-388), so
 * a v3 key could otherwise resolve to a now-stale hash for the same page.
 * `v5` adds the scope (RJC-383): the same page under "active" and "all"
 * are different result sets. `v6` retires every v5 entry (RJC-396):
 * dedupeSortedOperands/stableStringifyFilters switched from
 * `localeCompare` to a codepoint comparator, so a v5 key built under a
 * different ICU default locale could disagree with a v6 key for the same
 * query text — old keys become unreachable, which is the point.
 * `v7` separates lexical and hybrid result pages.
 * `v8` retires delimiter-ambiguous AST hashes (RJC-427).
 */
const RESULT_CACHE_KEY_PREFIX = "search:v9";
const FACET_CACHE_KEY_PREFIX = "search:facets:v6";

export const buildCacheKey = (
  astHash: string,
  version: SearchVersion,
  filters: SearchFilters,
  page: CacheKeyPage
): Promise<string> =>
  hashString(
    `${RESULT_CACHE_KEY_PREFIX}:${astHash}:${version.generation}:${version.appliedSequence}:${stableStringifyFilters(filters)}:${page.mode}:${page.scope}:${page.sort}:${page.offset}:${page.limit}`
  );

/**
 * Page-independent companion to buildCacheKey (RJC-388): omits sort/offset/
 * limit so every page of the same query+filters shares one facets entry —
 * page 2 doesn't force a fresh facet computation. `v3` retires every v2
 * entry for the same reason RESULT_CACHE_KEY_PREFIX bumped to v6 (RJC-396).
 * `v4` separates lexical and hybrid facets.
 * `v5` retires delimiter-ambiguous AST hashes (RJC-427).
 */
export const buildFacetCacheKey = (
  astHash: string,
  version: SearchVersion,
  filters: SearchFilters,
  scope: SearchScope,
  mode: SearchMode
): Promise<string> =>
  hashString(
    `${FACET_CACHE_KEY_PREFIX}:${astHash}:${version.generation}:${version.appliedSequence}:${stableStringifyFilters(filters)}:${mode}:${scope}`
  );
