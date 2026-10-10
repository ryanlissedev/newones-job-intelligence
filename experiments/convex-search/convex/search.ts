import { v } from "convex/values";

import { query } from "./_generated/server";

/**
 * Approximation of our Manticore search surface
 * (packages/search/src/manticore/client.ts) in Convex query functions.
 *
 * Known impedance mismatches, built the way Convex forces and reported
 * honestly in the measurement:
 * - One searchField per index: titel+beschrijving are denormalised into
 *   `zoektekst` (schema.ts).
 * - No boolean operators in `.search()`: multi-term search is "match any
 *   term, ranked" — AND/NOT must be post-filtered in JS over at most 1024
 *   candidates.
 * - No aggregations: facet counts require materialising every matching
 *   document into the function and counting in JS. Search-scoped facets cap
 *   at the 1024-scanned-results ceiling; unfiltered facets require a full
 *   table scan.
 */

const filtersValidator = {
  bronIds: v.optional(v.array(v.string())),
  contracttype: v.optional(v.array(v.string())),
  locatieLand: v.optional(v.array(v.string())),
  status: v.optional(v.array(v.string())),
};

interface FilterArgs {
  bronIds?: string[];
  contracttype?: string[];
  locatieLand?: string[];
  status?: string[];
}

interface AanvraagDocument {
  beschrijving: string;
  bronId: string;
  contracttype: string;
  documentId: string;
  locatieLand: string;
  status: string;
  titel: string;
  zoektekst: string;
}

const SEARCH_SCAN_CEILING = 1024;

const toBuckets = (map: Map<string, number>) =>
  [...map.entries()].map(([value, count]) => ({ count, value }));

const matchesFilters = (doc: AanvraagDocument, filters: FilterArgs): boolean =>
  (!filters.bronIds || filters.bronIds.includes(doc.bronId)) &&
  (!filters.status || filters.status.includes(doc.status)) &&
  (!filters.locatieLand || filters.locatieLand.includes(doc.locatieLand)) &&
  (!filters.contracttype || filters.contracttype.includes(doc.contracttype));

const countFacets = (docs: AanvraagDocument[]) => {
  const bronId = new Map<string, number>();
  const status = new Map<string, number>();
  const locatieLand = new Map<string, number>();
  const contracttype = new Map<string, number>();
  for (const doc of docs) {
    bronId.set(doc.bronId, (bronId.get(doc.bronId) ?? 0) + 1);
    status.set(doc.status, (status.get(doc.status) ?? 0) + 1);
    locatieLand.set(
      doc.locatieLand,
      (locatieLand.get(doc.locatieLand) ?? 0) + 1
    );
    contracttype.set(
      doc.contracttype,
      (contracttype.get(doc.contracttype) ?? 0) + 1
    );
  }
  return {
    bron_id: toBuckets(bronId),
    contracttype: toBuckets(contracttype),
    locatie_land: toBuckets(locatieLand),
    status: toBuckets(status),
  };
};

/**
 * Plain text search with offset/limit pagination, exact-total attempt and
 * facet counts — the closest single-query equivalent of one Manticore
 * /search call. Total and facets are computed over at most 1024 scanned
 * results; `ceilingHit` reports when that truncated the answer.
 */
export const searchPage = query({
  args: {
    limit: v.number(),
    offset: v.number(),
    term: v.string(),
    ...filtersValidator,
  },
  handler: async (ctx, args) => {
    const candidates = await ctx.db
      .query("aanvragen")
      .withSearchIndex("search_zoektekst", (q) =>
        q.search("zoektekst", args.term)
      )
      .take(SEARCH_SCAN_CEILING);
    const filtered = candidates.filter((doc) => matchesFilters(doc, args));
    const hits = filtered
      .slice(args.offset, args.offset + args.limit)
      .map((doc) => ({ id: doc.documentId }));
    return {
      ceilingHit: candidates.length === SEARCH_SCAN_CEILING,
      facets: countFacets(filtered),
      hits,
      scanned: candidates.length,
      total: filtered.length,
    };
  },
});

/**
 * Boolean semantics `(A OR B) AND C -D` approximated the only way Convex
 * allows: feed all positive terms to `.search()` (match-any, ranked), then
 * post-filter in JS with substring predicates over titel+beschrijving.
 * Correctness caveat measured in the report: any document matching the AND/
 * NOT predicate but ranked below the 1024th candidate for the positive terms
 * is silently lost.
 */
export const booleanSearch = query({
  args: {
    limit: v.number(),
    mustTerms: v.array(v.string()),
    notTerms: v.array(v.string()),
    offset: v.number(),
    orTerms: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const positive = [...args.orTerms, ...args.mustTerms].join(" ");
    const candidates = await ctx.db
      .query("aanvragen")
      .withSearchIndex("search_zoektekst", (q) =>
        q.search("zoektekst", positive)
      )
      .take(SEARCH_SCAN_CEILING);
    const matches = candidates.filter((doc) => {
      const text = doc.zoektekst.toLowerCase();
      const orOk =
        args.orTerms.length === 0 ||
        args.orTerms.some((term) => text.includes(term.toLowerCase()));
      const mustOk = args.mustTerms.every((term) =>
        text.includes(term.toLowerCase())
      );
      const notOk = !args.notTerms.some((term) =>
        text.includes(term.toLowerCase())
      );
      return orOk && mustOk && notOk;
    });
    return {
      ceilingHit: candidates.length === SEARCH_SCAN_CEILING,
      hits: matches
        .slice(args.offset, args.offset + args.limit)
        .map((doc) => ({ id: doc.documentId })),
      scanned: candidates.length,
      total: matches.length,
    };
  },
});

/**
 * Facets with no search term (the browse page): Convex has no aggregation,
 * so this is a literal full table scan into the function, counted in JS.
 * The measured cost of this scan at corpus size is the basis for the 7.5M
 * extrapolation in the report.
 */
export const fullScanFacets = query({
  args: { ...filtersValidator },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("aanvragen").collect();
    const filtered = rows.filter((doc) => matchesFilters(doc, args));
    return {
      facets: countFacets(filtered),
      scanned: rows.length,
      total: filtered.length,
    };
  },
});
