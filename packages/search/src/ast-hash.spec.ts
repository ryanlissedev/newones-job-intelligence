import { beforeAll, describe, expect, it } from "bun:test";

import { parseBooleanQuery } from "@ji/domain";
import type { BooleanNode } from "@ji/domain";

import {
  buildCacheKey,
  buildFacetCacheKey,
  canonicalizeAst,
  compareCodepoints,
  hasNegatedClause,
  hashAst,
  hashSearchAst,
  isHybridSearchEligible,
} from "./ast-hash";
import {
  assertLiveTestTablesReady,
  cleanupLiveDocuments,
  createLiveTestEngine,
  requireLiveManticoreUrl,
} from "./manticore/live-test-hygiene";
import { InMemorySearchVersionStore } from "./version";

const LIVE_TEST_INDEX_NAME = "aanvragen_test_asthash";

const parseOk = (query: string) => {
  const parsed = parseBooleanQuery(query);
  if (!parsed.ok) {
    throw new Error(`Expected parse success for: ${query}`);
  }
  return parsed.ast;
};

const version = { appliedSequence: 1n, generation: 1 };

const digestSha256 = async (input: string): Promise<string> => {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

describe("hybrid query eligibility", () => {
  it("accepts positive text and rejects any nested NOT clause", () => {
    expect(isHybridSearchEligible(parseOk("Azure platform"))).toBe(true);
    expect(isHybridSearchEligible(parseOk("Azure NOT intern"))).toBe(false);
    expect(isHybridSearchEligible(parseOk("NOT intern"))).toBe(false);
    expect(hasNegatedClause(parseOk("Azure OR (platform NOT junior)"))).toBe(
      true
    );
  });
});

// RJC-388 fix-first review: a plain stableStringifyAst sort put "not("
// ahead of "or(", "phrase:", and "term:" alphabetically, so a NOT operand
// sorted BEFORE the positive siblings it was written after — reaching
// Manticore negation-first for any NOT query. Assert the invariant
// directly, recursively, across every AND/OR in the tree: a "not" operand
// never appears before a non-"not" operand in the same operands array.
const assertNegationNeverPrecedesPositive = (node: BooleanNode): void => {
  if (node.kind === "not") {
    assertNegationNeverPrecedesPositive(node.operand);
    return;
  }
  if (node.kind !== "and" && node.kind !== "or") {
    return;
  }

  let sawPositiveAfterNegation = false;
  let sawNegation = false;
  for (const operand of node.operands) {
    if (operand.kind === "not") {
      sawNegation = true;
    } else if (sawNegation) {
      sawPositiveAfterNegation = true;
    }
    assertNegationNeverPrecedesPositive(operand);
  }
  expect(sawPositiveAfterNegation).toBe(false);
};

describe("canonicalizeAst (RJC-388)", () => {
  it("keeps delimiter-bearing sibling structures distinct (RJC-427)", async () => {
    const threeSiblings = parseOk("a AND b AND c");
    const embeddedLegacyDelimiter = parseOk("a,term:b AND c");

    expect(await hashAst(threeSiblings)).not.toBe(
      await hashAst(embeddedLegacyDelimiter)
    );
  });

  it("deduplicates only structurally identical delimiter-bearing siblings", () => {
    const canonical = canonicalizeAst(parseOk("a,term:b AND c AND a,term:b"));

    expect(canonical).toEqual(parseOk("a,term:b AND c"));
  });

  it("preserves sibling subtrees that only collided under delimiter serialization", () => {
    const canonical = canonicalizeAst(
      parseOk("(a AND b AND c) OR (a,term:b AND c)")
    );

    expect(canonical.kind).toBe("or");
    if (canonical.kind !== "or") {
      throw new Error("Expected an OR root");
    }
    expect(canonical.operands).toHaveLength(2);
  });

  it("encodes phrase punctuation, quotes, and backslashes as payload", async () => {
    const punctuated: BooleanNode = {
      kind: "phrase",
      value: 'quoted "value" \\ path, (group)',
    };
    const adjacent: BooleanNode = {
      kind: "phrase",
      value: 'quoted "value" \\ path, (group).',
    };

    expect(await hashAst(punctuated)).not.toBe(await hashAst(adjacent));
  });

  it("gives browse a hash distinct from every Boolean AST", async () => {
    expect(await hashSearchAst(null)).not.toBe(
      await hashSearchAst(parseOk("match_all"))
    );
  });

  it("shares a hash across AND operand reordering", async () => {
    const left = await hashAst(parseOk("Azure AND platform AND senior"));
    const right = await hashAst(parseOk("senior AND Azure AND platform"));
    expect(left).toBe(right);
  });

  it("shares a hash across OR operand reordering", async () => {
    const left = await hashAst(parseOk("Azure OR platform OR senior"));
    const right = await hashAst(parseOk("senior OR Azure OR platform"));
    expect(left).toBe(right);
  });

  it("dedups identical siblings in AND/OR", async () => {
    const deduped = await hashAst(parseOk("Azure AND platform"));
    const repeated = await hashAst(parseOk("platform AND Azure AND platform"));
    expect(deduped).toBe(repeated);
  });

  it("shares a hash across plain-term casing", async () => {
    const lower = await hashAst(parseOk("azure AND platform"));
    const upper = await hashAst(parseOk("AZURE AND PLATFORM"));
    expect(lower).toBe(upper);
  });

  it("does NOT normalize phrase text casing", async () => {
    const lower = await hashAst(parseOk('"platform engineer"'));
    const upper = await hashAst(parseOk('"PLATFORM ENGINEER"'));
    expect(lower).not.toBe(upper);
  });

  it("does NOT reorder a NOT's operand structure into something else", async () => {
    const withNot = await hashAst(parseOk("Azure NOT intern"));
    const bareAnd = await hashAst(parseOk("Azure AND intern"));
    expect(withNot).not.toBe(bareAnd);
  });

  it("is idempotent: canonicalizing twice matches canonicalizing once", () => {
    const ast = parseOk("senior AND (Azure OR Platform) AND senior");
    const once = canonicalizeAst(ast);
    const twice = canonicalizeAst(canonicalizeAst(ast));
    expect(twice).toEqual(once);
  });

  it("never sorts a NOT operand before a positive sibling in any AND/OR", () => {
    const queries = [
      '(Azure OR "platform engineer") NOT intern',
      "senior NOT junior AND azure",
      "NOT junior AND senior AND platform",
      "(a NOT b) AND (NOT c OR d)",
      "azure AND platform NOT intern NOT stagiair",
    ];

    for (const query of queries) {
      const canonical = canonicalizeAst(parseOk(query));
      assertNegationNeverPrecedesPositive(canonical);
    }
  });
});

// RJC-396: `String.localeCompare` without an explicit locale argument
// collates via the process's ICU default locale, so the same two strings
// can sort in opposite order on different processes/environments. That
// used to feed dedupeSortedOperands and stableStringifyFilters, both on
// the path to a SHARED Redis key — a silent cross-process cache miss, not
// a wrong result. These pairs are confirmed (via a throwaway localeCompare
// probe under the en-US ICU default) to sort in the OPPOSITE order under
// locale-aware collation vs plain codepoint order; compareCodepoints must
// still produce the fixed, codepoint-only answer for every one of them.
describe("compareCodepoints (RJC-396)", () => {
  it("sorts punctuation by codepoint, not locale-aware collation weight", () => {
    // "(" (0x28) < ":" (0x3A) by codepoint; localeCompare("(", ":") is
    // positive under en-US ICU collation (punctuation is weighted low).
    expect(compareCodepoints("(", ":")).toBe(-1);
    // ":" (0x3A) > '"' (0x22) by codepoint; localeCompare(":", '"') is
    // negative under en-US ICU collation.
    expect(compareCodepoints(":", '"')).toBe(1);
  });

  it("sorts case by codepoint (uppercase before lowercase), not locale case-folding", () => {
    // "A" (0x41) < "a" (0x61) by codepoint; localeCompare("a", "A") is
    // negative under en-US ICU collation (lowercase sorts first there).
    expect(compareCodepoints("a", "A")).toBe(1);
  });

  it("sorts accented characters by codepoint, not diacritic-aware collation", () => {
    // "é" (U+00E9) > "f" (0x66) by codepoint; localeCompare("é", "f") is
    // negative under en-US ICU collation (é collates near "e").
    expect(compareCodepoints("é", "f")).toBe(1);
  });

  it("is a total order: equal strings compare equal, and it's antisymmetric", () => {
    expect(compareCodepoints("term:azure", "term:azure")).toBe(0);
    expect(compareCodepoints("term:a", "term:b")).toBe(-1);
    expect(compareCodepoints("term:b", "term:a")).toBe(1);
  });
});

describe("cache key prefixes (RJC-388)", () => {
  it("retires result v7 and facet v4 entries after the AST encoding change (RJC-427)", async () => {
    const astHash = await hashAst(parseOk("Azure"));
    const resultKey = await buildCacheKey(
      astHash,
      version,
      {},
      {
        limit: 20,
        mode: "lexical",
        offset: 0,
        scope: "active",
        sort: "relevance",
      }
    );
    const facetKey = await buildFacetCacheKey(
      astHash,
      version,
      {},
      "active",
      "lexical"
    );
    const previousResultInput = `search:v7:${astHash}:${version.generation}:${version.appliedSequence}:{}:lexical:active:relevance:0:20`;
    const previousFacetInput = `search:facets:v4:${astHash}:${version.generation}:${version.appliedSequence}:{}:lexical:active`;
    expect(resultKey).not.toBe(await digestSha256(previousResultInput));
    expect(facetKey).not.toBe(await digestSha256(previousFacetInput));
  });

  it("buildCacheKey produces a stable opaque key for a given astHash+page", async () => {
    const astHash = await hashAst(parseOk("Azure"));
    const key = await buildCacheKey(
      astHash,
      version,
      {},
      {
        limit: 20,
        mode: "lexical",
        offset: 0,
        scope: "active",
        sort: "relevance",
      }
    );
    expect(key).toHaveLength(64);
    // Canonicalization changed what astHash resolves to for a given query
    // text vs the pre-RJC-388 v3 scheme, so v4 must not collide with a
    // hand-built v3-formatted key for the same inputs.
    const hash = await hashAst(parseOk("Azure"));
    const v3Input = `search:v3:${hash}:${version.generation}:${version.appliedSequence}:{}:relevance:0:20`;
    const v3Digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(v3Input)
    );
    const v3FormattedKey = [...new Uint8Array(v3Digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    expect(key).not.toBe(v3FormattedKey);
  });

  it("buildFacetCacheKey omits page, so identical query+filters share it across pages", async () => {
    const astHash = await hashAst(parseOk("Azure"));
    const pageOne = await buildFacetCacheKey(
      astHash,
      version,
      {},
      "active",
      "lexical"
    );
    const another = await buildFacetCacheKey(
      astHash,
      version,
      {},
      "active",
      "lexical"
    );
    expect(pageOne).toBe(another);
  });

  it("keys differ per scope (RJC-383): an active-scope entry never serves an all-scope request", async () => {
    const astHash = await hashAst(parseOk("Azure"));
    const page = { limit: 20, offset: 0, sort: "relevance" as const };
    const active = await buildCacheKey(
      astHash,
      version,
      {},
      {
        ...page,
        mode: "lexical",
        scope: "active",
      }
    );
    const all = await buildCacheKey(
      astHash,
      version,
      {},
      {
        ...page,
        mode: "lexical",
        scope: "all",
      }
    );
    expect(active).not.toBe(all);
    expect(
      await buildFacetCacheKey(astHash, version, {}, "active", "lexical")
    ).not.toBe(
      await buildFacetCacheKey(astHash, version, {}, "all", "lexical")
    );
  });

  it("buildFacetCacheKey differs from buildCacheKey for the same inputs", async () => {
    const astHash = await hashAst(parseOk("Azure"));
    const facetKey = await buildFacetCacheKey(
      astHash,
      version,
      {},
      "active",
      "lexical"
    );
    const resultKey = await buildCacheKey(
      astHash,
      version,
      {},
      {
        limit: 20,
        mode: "lexical",
        offset: 0,
        scope: "active",
        sort: "relevance",
      }
    );
    expect(facetKey).not.toBe(resultKey);
  });

  it("separates lexical and hybrid result and facet entries", async () => {
    const astHash = await hashAst(parseOk("Azure"));
    const page = {
      limit: 20,
      offset: 0,
      scope: "active" as const,
      sort: "relevance" as const,
    };
    expect(
      await buildCacheKey(astHash, version, {}, { ...page, mode: "lexical" })
    ).not.toBe(
      await buildCacheKey(astHash, version, {}, { ...page, mode: "hybrid" })
    );
    expect(
      await buildFacetCacheKey(astHash, version, {}, "active", "lexical")
    ).not.toBe(
      await buildFacetCacheKey(astHash, version, {}, "active", "hybrid")
    );
  });
});

// Live check for the case-insensitivity claim canonicalizeAst relies on to
// lowercase plain terms. Skipped unless MANTICORE_URL is set — same
// convention as manticore/live.spec.ts — so `bun run gate` stays mock-only.
const manticoreLiveUrl = requireLiveManticoreUrl(
  process.env.MANTICORE_URL,
  process.env.MANTICORE_REQUIRE_LIVE === "1"
);

describe.skipIf(!manticoreLiveUrl)(
  "Manticore query_string case-insensitivity (live, RJC-388)",
  () => {
    beforeAll(() =>
      assertLiveTestTablesReady(manticoreLiveUrl, LIVE_TEST_INDEX_NAME)
    );
    it("matches a mixed-case document with a lowercase term and vice versa", async () => {
      if (!manticoreLiveUrl) {
        throw new Error("Live test was not skipped without MANTICORE_URL");
      }

      const engine = createLiveTestEngine(
        manticoreLiveUrl,
        new InMemorySearchVersionStore(),
        LIVE_TEST_INDEX_NAME
      );
      const runToken = `casecheck${crypto.randomUUID().replaceAll("-", "")}`;
      const documentId = `case-doc-${crypto.randomUUID()}`;
      try {
        await engine.upsertDocument({
          beschrijving: `Mixed CaSe token ${runToken}`,
          bronId: "bron-live",
          contracttype: "detachering",
          eindklantNaam: null,
          id: documentId,
          laatstGezienOp: new Date("2026-08-01T00:00:00.000Z"),
          locatieLand: "NL",
          opdrachtgeverNaam: null,
          provincie: null,
          publicatiedatum: null,
          skills: [],
          status: "active",
          tariefEenheid: null,
          tariefMax: 120,
          tariefMin: 80,
          titel: "Case sensitivity check",
          urenPerWeekMax: null,
          urenPerWeekMin: null,
          werkvorm: null,
        });
        await engine.applyBatch({ appliedSequence: 1n, mutations: [] });

        const lowerAst = parseOk(runToken.toLowerCase());
        const upperAst = parseOk(runToken.toUpperCase());
        const lowerResult = await engine.search({
          ast: lowerAst,
          filters: {},
          limit: 10,
          offset: 0,
        });
        const upperResult = await engine.search({
          ast: upperAst,
          filters: {},
          limit: 10,
          offset: 0,
        });

        expect(lowerResult.total).toBeGreaterThanOrEqual(1);
        expect(upperResult.total).toBeGreaterThanOrEqual(1);
      } finally {
        await cleanupLiveDocuments(engine, [documentId]);
      }
    });
  }
);
