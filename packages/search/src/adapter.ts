import {
  BOOLEAN_PARSER_VERSION,
  DEFAULT_SEARCH_PAGE_SIZE,
  parseBooleanQuery,
} from "@ji/domain";
import type { BooleanNode, BooleanParseResult } from "@ji/domain";
import {
  createCriticalPathSession,
  digestQueryset,
  digestSearchResult,
  isCriticalPathEnabled,
  recordCriticalPathPhaseSync,
  resolveRunKind,
  buildWorkloadMetadata,
  monotonicNowMs,
  timeCriticalPathPhase,
  withCriticalPathSession,
} from "@ji/performance";
import type { QuerysetFilterValue } from "@ji/performance/digest";

import {
  buildCacheKey,
  buildFacetCacheKey,
  canonicalizeAst,
  hashSearchAst,
  isHybridSearchEligible,
} from "./ast-hash";
import { MemoryFacetCache } from "./cache/facets-cache";
import type { FacetCache } from "./cache/facets-cache";
import { ParserLruCache } from "./cache/parser-cache";
import { Singleflight } from "./cache/singleflight";
import { SearchVersionPin } from "./cache/version-pin";
import { DEFAULT_SEARCH_SCOPE } from "./partition";
import type { SearchScope } from "./partition";
import type {
  QueryScope,
  ResultCache,
  SearchAdapterInput,
  SearchAdapterResult,
  SearchAdapterSuccess,
  SearchEngine,
  SearchFilters,
  SearchMode,
  SearchSort,
} from "./types";
import { DEFAULT_QUERY_SCOPE } from "./types";
import type { SearchVersion } from "./version";

const DEFAULT_OFFSET = 0;
const DEFAULT_SORT = "relevance";
const DEFAULT_CACHE_TTL_SECONDS = 120;
const FACETS_CACHE_TTL_SECONDS = 120;

const normalizeQueryScope = (value: QueryScope | undefined): QueryScope =>
  value === "title" || value === "all" ? value : DEFAULT_QUERY_SCOPE;

const normalizePublicationFilter = (
  value: string | undefined
): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  return Number.isNaN(Date.parse(value)) ? undefined : value;
};

/** Omitted scope defaults to all (CTP-508); publication bounds stay ISO strings. */
export const normalizeSearchFilters = (
  filters: SearchFilters | undefined
): SearchFilters => {
  const source = filters ?? {};
  return {
    ...source,
    publicatiedatumTot: normalizePublicationFilter(source.publicatiedatumTot),
    publicatiedatumVanaf: normalizePublicationFilter(
      source.publicatiedatumVanaf
    ),
    queryScope: normalizeQueryScope(source.queryScope),
  };
};

const normalizeFilters = (filters: SearchFilters | undefined): SearchFilters =>
  normalizeSearchFilters(filters);

export interface SearchAdapterOptions {
  cache?: ResultCache;
  cacheTtlSeconds?: number;
  engine: SearchEngine;
  /** Overrides SEARCH_HYBRID for isolated evaluation runs and focused tests. */
  hybridEnabled?: boolean;
  /**
   * Cache-key version pinning (see `SearchVersionPin`). Defaults: re-read
   * the durable version every 5 s in the background, re-pin a newer
   * sequence at most once per 60 s.
   */
  versionPin?: {
    minPinMs?: number;
    now?: () => number;
    refreshMs?: number;
  };
}

export const isSearchHybridEnabled = (
  value: string | undefined = undefined
): boolean => value === "1";

export class SearchAdapter {
  private readonly cache?: ResultCache;
  private readonly cacheTtlSeconds: number;
  private readonly engine: SearchEngine;
  private readonly hybridEnabled: boolean;
  private readonly facetsCache: FacetCache = new MemoryFacetCache();
  private readonly parserCache = new ParserLruCache();
  private readonly singleflight = new Singleflight<SearchAdapterResult>();
  private readonly versionPin: SearchVersionPin;

  constructor(options: SearchAdapterOptions) {
    this.engine = options.engine;
    this.hybridEnabled =
      options.hybridEnabled ?? isSearchHybridEnabled(process.env.SEARCH_HYBRID);
    this.cache = options.cache;
    this.cacheTtlSeconds = options.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS;
    this.versionPin = new SearchVersionPin({
      ...options.versionPin,
      read: () => this.engine.getAppliedVersion(),
    });
  }

  /**
   * Query text -> AST via the in-process parser cache (RJC-388). Keyed by
   * the raw query string, never by search version — a parse doesn't change
   * when the index does.
   */
  private parseWithCache(query: string): BooleanParseResult {
    const cached = this.parserCache.get(query);
    if (cached) {
      return cached;
    }
    const parsed = recordCriticalPathPhaseSync("search-parser", () =>
      parseBooleanQuery(query)
    );
    this.parserCache.set(query, parsed);
    return parsed;
  }

  /**
   * Durable index version passthrough (RJC-384). Consumers that persist a
   * point-in-time reference (query snapshots, RJC-385) record this full
   * version, not the legacy scalar.
   */
  getAppliedVersion(): Promise<SearchVersion> {
    return this.engine.getAppliedVersion();
  }

  /** Isolated from search() so the singleflight task closure stays small. */
  private async computeAndCache(
    ast: BooleanNode | null,
    astHash: string,
    parserVersion: number,
    filters: SearchFilters,
    mode: SearchMode,
    cacheKey: string,
    facetKey: string,
    page: {
      limit: number;
      offset: number;
      scope: SearchScope;
      sort: SearchSort;
    }
  ): Promise<SearchAdapterSuccess> {
    const cachedFacets = await this.facetsCache.get(facetKey);

    const engineResult = await timeCriticalPathPhase("search-engine", () =>
      this.engine.search({
        ast,
        // A facet cache hit means the aggregations would be thrown away, so
        // the engine skips them; they are most of a match-all search's cost.
        facets: cachedFacets === null,
        filters,
        limit: page.limit,
        mode,
        offset: page.offset,
        scope: page.scope,
        sort: page.sort,
      })
    );

    const facets = cachedFacets ?? engineResult.facets;
    if (!(cachedFacets || engineResult.incomplete)) {
      await this.facetsCache.set(
        facetKey,
        engineResult.facets,
        FACETS_CACHE_TTL_SECONDS
      );
    }

    const success: SearchAdapterSuccess = {
      archiveTotal: engineResult.archiveTotal,
      astHash,
      emptyReason: engineResult.emptyReason,
      facets,
      hits: engineResult.hits,
      incomplete: engineResult.incomplete,
      indexVersion: engineResult.indexVersion,
      ok: true,
      parserVersion,
      scope: engineResult.scope,
      total: engineResult.total,
      windowLimit: engineResult.windowLimit,
    };

    if (this.cache && !engineResult.incomplete) {
      await this.cache.set(
        cacheKey,
        {
          archiveTotal: engineResult.archiveTotal,
          astHash,
          emptyReason: engineResult.emptyReason,
          facets,
          filters,
          hits: engineResult.hits,
          indexVersion: engineResult.indexVersion,
          scope: engineResult.scope,
          total: engineResult.total,
          windowLimit: engineResult.windowLimit,
        },
        this.cacheTtlSeconds
      );
    }

    return success;
  }

  async search(input: SearchAdapterInput): Promise<SearchAdapterResult> {
    const execute = (): Promise<SearchAdapterResult> => {
      const browse = input.query.trim().length === 0;
      let ast: BooleanNode | null = null;
      let parserVersion = BOOLEAN_PARSER_VERSION;
      if (!browse) {
        const parsed = this.parseWithCache(input.query);
        if (!parsed.ok) {
          return Promise.resolve({
            error: parsed.error,
            ok: false,
          });
        }
        const { ast: parsedAst, version: parsedVersion } = parsed;
        ast = parsedAst;
        parserVersion = parsedVersion;
      }

      const filters = normalizeFilters(input.filters);
      const limit = input.limit ?? DEFAULT_SEARCH_PAGE_SIZE;
      const offset = input.offset ?? DEFAULT_OFFSET;
      const sort = input.sort ?? DEFAULT_SORT;
      const scope = input.scope ?? DEFAULT_SEARCH_SCOPE;
      const mode: SearchMode =
        ast !== null && this.hybridEnabled && isHybridSearchEligible(ast)
          ? "hybrid"
          : "lexical";

      return timeCriticalPathPhase("search-adapter", async () => {
        // The pinned version comes from memory (refreshed in the background)
        // and moves at most once a minute while the projector ingests, so
        // a search no longer waits on Postgres before the cache lookup.
        const [astHash, version] = await Promise.all([
          hashSearchAst(ast),
          this.versionPin.current(),
        ]);
        const cacheKey = await buildCacheKey(astHash, version, filters, {
          limit,
          mode,
          offset,
          scope,
          sort,
        });

        if (this.cache) {
          const cached = await this.cache.get(cacheKey);
          if (cached) {
            const success: SearchAdapterSuccess = {
              archiveTotal: cached.archiveTotal,
              astHash,
              cache: "hit",
              emptyReason: cached.emptyReason,
              facets: cached.facets,
              hits: cached.hits,
              incomplete: false,
              indexVersion: cached.indexVersion,
              ok: true,
              parserVersion,
              scope: cached.scope,
              total: cached.total,
              windowLimit: cached.windowLimit,
            };
            return success;
          }
        }

        const facetKey = await buildFacetCacheKey(
          astHash,
          version,
          filters,
          scope,
          mode
        );
        const { coalesced, promise } = this.singleflight.run(cacheKey, () =>
          this.computeAndCache(
            ast === null ? null : canonicalizeAst(ast),
            astHash,
            parserVersion,
            filters,
            mode,
            cacheKey,
            facetKey,
            { limit, offset, scope, sort }
          )
        );
        const result = await promise;
        return { ...result, cache: coalesced ? "coalesced" : "miss" };
      });
    };

    if (!isCriticalPathEnabled()) {
      return execute();
    }

    const session = createCriticalPathSession({
      metadata: {
        ...buildWorkloadMetadata(),
        "queryset-digest": digestQueryset({
          // SAFETY: digestQueryset JSON-serializes filters; SearchFilters values match QuerysetFilterValue.
          filters: input.filters as
            | Readonly<Record<string, QuerysetFilterValue>>
            | undefined,
          limit: input.limit,
          offset: input.offset,
          query: input.query,
        }),
      },
      runKind: resolveRunKind(),
    });

    try {
      const result = await withCriticalPathSession(session, execute);
      if (result.ok) {
        session.mergeMetadata({
          "result-digest": digestSearchResult({
            emptyReason: result.emptyReason,
            facets: result.facets,
            indexVersion: result.indexVersion,
            total: result.total,
          }),
        });
      }
      const flushStarted = monotonicNowMs();
      await session.flush();
      const overheadMs = Math.round(monotonicNowMs() - flushStarted);
      const overheadSession = createCriticalPathSession({
        metadata: {
          "instrumentation-overhead-ms": String(overheadMs),
        },
      });
      // One clock read: two separate `new Date()` calls evaluated in key order
      // (endedAt before startedAt) could straddle a millisecond tick and make
      // endedAt precede startedAt, which scripts/performance/report.ts rejects
      // and fails CI. startedAt is derived from the measured overhead instead.
      const overheadEndedAt = new Date();
      const overheadStartedAt = new Date(
        overheadEndedAt.getTime() - overheadMs
      );
      overheadSession.recordSample({
        durationMs: overheadMs,
        endedAt: overheadEndedAt.toISOString(),
        label: "instrumentation-overhead",
        startedAt: overheadStartedAt.toISOString(),
        success: true,
      });
      await overheadSession.flush();
      return result;
    } catch (error) {
      await session.flush();
      throw error;
    }
  }
}

export const evaluateBooleanAst = (
  ast: BooleanNode,
  titel: string,
  beschrijving: string
): boolean => {
  const haystack = `${titel} ${beschrijving}`.toLowerCase();

  const containsTerm = (term: string): boolean =>
    haystack.includes(term.toLowerCase());

  const containsPhrase = (phrase: string): boolean =>
    haystack.includes(phrase.toLowerCase());

  const evalNode = (node: BooleanNode): boolean => {
    switch (node.kind) {
      case "term": {
        return containsTerm(node.value);
      }
      case "phrase": {
        return containsPhrase(node.value);
      }
      case "not": {
        return !evalNode(node.operand);
      }
      case "and": {
        return node.operands.every((operand) => evalNode(operand));
      }
      case "or": {
        return node.operands.some((operand) => evalNode(operand));
      }
      default: {
        const _exhaustive: never = node;
        throw new Error(`Unsupported boolean node: ${String(_exhaustive)}`);
      }
    }
  };

  return evalNode(ast);
};
