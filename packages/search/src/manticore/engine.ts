import type { BooleanNode } from "@ji/domain";
import { recordCriticalPathPhaseSync } from "@ji/performance";

import { isHybridSearchEligible } from "../ast-hash";
import { Singleflight } from "../cache/singleflight";
import {
  DEFAULT_SEARCH_SCOPE,
  documentPartition,
  otherPartition,
  partitionTable,
  SEARCH_PARTITIONS,
  scopeTables,
} from "../partition";
import type { SearchPartition, SearchScope } from "../partition";
import type {
  EngineSearchParams,
  SearchDocument,
  SearchEngine,
  SearchEngineResult,
  SearchIndexBatch,
  SearchIndexBatchResult,
  SearchIndexMutation,
  SearchMutationFailure,
} from "../types";
import {
  DEFAULT_QUERY_SCOPE,
  documentLocatie,
  mutationId,
  SEARCH_INDEX_NAME,
  SEARCH_WINDOW_LIMIT,
} from "../types";
import { ZERO_SEQUENCE } from "../version";
import type { SearchVersion, SearchVersionStore } from "../version";
import {
  ARCHIVE_COUNT_TIMEOUT_MS,
  buildManticoreCountRequest,
  buildManticoreSearchRequest,
  bulkManticore,
  deleteManticoreDocument,
  replaceManticoreDocument,
  searchManticore,
} from "./client";
import type { ManticoreHttpClient } from "./client";
import { FetchManticoreEffectClient } from "./client-effect";
import {
  buildBoolJson,
  buildKnnQueryText,
  buildQueryString,
  SEARCH_TEXT_FIELDS,
  SEARCH_TITLE_SCOPE_FIELDS,
} from "./emitter";
import type { ManticoreBoolQuery } from "./emitter";
import { hashDocumentId } from "./id-hash";
import type {
  ManticoreBulkLine,
  ManticoreFacetName,
  ManticoreIndexedDocument,
  ManticoreQueryBody,
  ManticoreSearchRequestBody,
} from "./json";

/**
 * Upper bound on one POST /bulk body (RJC-389). Manticore's default
 * max_packet_size is 128MB; 8MB keeps a single request well inside that and
 * bounds the blast radius of an all-or-nothing bulk (see
 * manticoreBulkPayloadSchema). A batch above the cap is split into
 * independent requests; each request is atomic on its own.
 */
export const MANTICORE_BULK_MAX_BYTES = 8 * 1024 * 1024;
/**
 * Isolation re-sends per chunk per drain: how many failing lines one chunk
 * may single out (re-send alone, then re-send the rest) before the remainder
 * is released unblamed to the next drain.
 */
export const MANTICORE_BULK_ISOLATION_RESENDS_PER_CHUNK = 1;

const HYBRID_FACET_NAMES = [
  "bron_id",
  "contracttype",
  "locatie",
  "locatie_land",
  "provincie",
  "skills",
  "status",
] as const satisfies readonly ManticoreFacetName[];

/**
 * 2100-01-01T00:00:00Z. Indexed under `sluitingsdatum` when a document has no
 * deadline so `ORDER BY sluitingsdatum ASC` (the closing-soon sort) lists
 * real deadlines first and missing ones last without a per-match expression.
 * Fits Manticore's 32-bit timestamp attribute (max 2106) and is far past
 * any deadline a bron will publish. Do not filter on it as a real date.
 */
export const SLUITINGSDATUM_MISSING_SENTINEL = 4_102_444_800;

/** Epoch 0: newest (desc) keeps unknown publication dates last. */
export const PUBLICATIEDATUM_MISSING_SENTINEL = 0;

/** Sorts unknown companies last under company-asc. */
export const COMPANY_MISSING_KEYWORD = "\uFFFF";

const MANTICORE_CONFLICT_MESSAGE = /\b409\b|\bconflict\b/iu;
const LIVE_REPLACE_CONFLICT_RETRIES = 2;
const LIVE_REPLACE_CONFLICT_BACKOFF_MS = 25;

const waitForManticoreRetry = async (): Promise<void> => {
  // oxlint-disable-next-line promise/avoid-new -- the retry backoff needs a timer promise
  await new Promise<void>((resolve) => {
    setTimeout(resolve, LIVE_REPLACE_CONFLICT_BACKOFF_MS);
  });
};

const epochSeconds = (value: Date): number =>
  Math.floor(value.getTime() / 1000);

const comparableTarief = (document: SearchDocument): number => {
  if (document.tariefEenheid === null) {
    return 0;
  }
  return document.tariefMax ?? document.tariefMin ?? 0;
};

/**
 * The content-bearing projection, deliberately excluding the derived
 * `projection_hash`. New CTP-493 attributes are additive for schema v10.
 */
const documentToManticoreFields = (
  document: SearchDocument,
  indexVersion: number
): Omit<ManticoreIndexedDocument, "projection_hash"> => {
  const location = documentLocatie(document);
  const countryEntries: [string, string | number][] =
    document.locatie !== null && document.locatieLand !== null
      ? [["locatie_land", document.locatieLand]]
      : [];
  const locationEntries: [string, string | number][] =
    location === undefined ? [] : [["locatie", location]];
  const company = document.opdrachtgeverNaam ?? "";
  const entries: [string, string | number | readonly string[]][] = [
    ["beschrijving", document.beschrijving],
    ["bron_id", document.bronId],
    ["comparable_tarief", comparableTarief(document)],
    ["contracttype", document.contracttype ?? ""],
    ["document_id", document.id],
    ["index_version", indexVersion],
    ["laatst_gezien_op", epochSeconds(document.laatstGezienOp)],
    ...countryEntries,
    ["opdrachtgever_naam", company],
    [
      "opdrachtgever_naam_keyword",
      document.opdrachtgeverNaam === null ? COMPANY_MISSING_KEYWORD : company,
    ],
    ["provincie", document.provincie ?? ""],
    [
      "publicatiedatum",
      document.publicatiedatum
        ? epochSeconds(document.publicatiedatum)
        : PUBLICATIEDATUM_MISSING_SENTINEL,
    ],
    [
      "sluitingsdatum",
      document.sluitingsdatum
        ? epochSeconds(document.sluitingsdatum)
        : SLUITINGSDATUM_MISSING_SENTINEL,
    ],
    ["skills", document.skills],
    ["status", document.status],
    ["tarief_eenheid", document.tariefEenheid ?? ""],
    ["tarief_max", document.tariefMax ?? 0],
    ["tarief_min", document.tariefMin ?? 0],
    ["titel", document.titel],
    ["titel_keyword", document.titel],
    ["uren_per_week_max", document.urenPerWeekMax ?? 0],
    ["uren_per_week_min", document.urenPerWeekMin ?? 0],
    ["werkvorm", document.werkvorm ?? ""],
    ...locationEntries,
  ];
  // SAFETY: entries contains every required Manticore field exactly once;
  // optional location fields are added in the canonical projection order.
  return Object.fromEntries(entries) as Omit<
    ManticoreIndexedDocument,
    "projection_hash"
  >;
};

const documentToManticore = (
  document: SearchDocument,
  indexVersion: number,
  hash: string
): ManticoreIndexedDocument => ({
  ...documentToManticoreFields(document, indexVersion),
  // This is an operator-verifiable copy of the canonical source projection,
  // not another input to it. See projectionHash below.
  projection_hash: hash,
});

/**
 * Hash of the search-relevant projection of a document (RJC-389): exactly
 * the content attributes documentToManticore indexes, minus index_version (a
 * per-batch watermark, not document content), prefixed with the partition
 * the document belongs in at `now` (RJC-383) — so a status transition that
 * moves a document between tables can never be skipped as "unchanged", and
 * the projection state row remembers which table holds the document (see
 * partitionFromProjectionHash). Two documents with equal hashes produce
 * byte-identical Manticore rows in the same table, so the projector can
 * skip the write. Pure cyrb53 under two seeds (~106 bits) — no node:crypto,
 * as apps/web type-checks this package; a collision only costs a skipped
 * reindex.
 */
export const projectionHash = (
  document: SearchDocument,
  now: Date = new Date()
): string => {
  const indexed = documentToManticoreFields(document, 0);
  const fields = Object.fromEntries(
    Object.entries(indexed).filter(([key]) => key !== "index_version")
  );
  const json = JSON.stringify(fields);
  return `${documentPartition(document, now)}:${hashDocumentId(json, 0).toString(36)}.${hashDocumentId(json, 1).toString(36)}`;
};

/** Partition recorded in a projectionHash; undefined for a pre-RJC-383 hash. */
export const partitionFromProjectionHash = (
  hash: string
): SearchPartition | undefined => {
  const prefix = hash.slice(0, hash.indexOf(":"));
  return SEARCH_PARTITIONS.find((partition) => partition === prefix);
};

/** One mutation's /bulk lines: kept together so isolation blames or releases the whole mutation. */
interface BulkEntry {
  id: string;
  lines: string[];
  sequence: bigint;
}

interface BulkChunk {
  entries: BulkEntry[];
}

const chunkLines = (chunk: BulkChunk): string[] =>
  chunk.entries.flatMap((entry) => entry.lines);

/** Index of the entry that owns 0-based line `line` of the flattened chunk. */
const entryIndexOfLine = (chunk: BulkChunk, line: number): number => {
  let seen = 0;
  for (const [index, entry] of chunk.entries.entries()) {
    seen += entry.lines.length;
    if (line < seen) {
      return index;
    }
  }
  return chunk.entries.length - 1;
};

interface ChunkOutcome {
  appliedSequences: bigint[];
  failures: SearchMutationFailure[];
  /** True when a failure could not be isolated: later chunks are not sent. */
  stop: boolean;
  unapplied: string[];
}

const encoder = new TextEncoder();

/** Splits serialized bulk entries into requests under MANTICORE_BULK_MAX_BYTES; an entry is never split. */
const chunkBulkLines = (
  entries: readonly BulkEntry[],
  maxBytes: number
): BulkChunk[] => {
  const chunks: BulkChunk[] = [];
  let current: BulkChunk = { entries: [] };
  let currentBytes = 0;
  for (const entry of entries) {
    const bytes = entry.lines.reduce(
      (sum, line) => sum + encoder.encode(line).byteLength + 1,
      0
    );
    if (current.entries.length > 0 && currentBytes + bytes > maxBytes) {
      chunks.push(current);
      current = { entries: [] };
      currentBytes = 0;
    }
    current.entries.push(entry);
    currentBytes += bytes;
  }
  if (current.entries.length > 0) {
    chunks.push(current);
  }
  return chunks;
};

const withoutEntry = (chunk: BulkChunk, at: number): BulkChunk => ({
  entries: chunk.entries.filter((_, index) => index !== at),
});

export interface ManticoreSearchEngineOptions {
  /** Synchronize the logical all-scope table used by Manticore 29 hybrid search. */
  hybridEnabled?: boolean;
  /** Retry transient table-readiness conflicts; enabled only for live hygiene. */
  retryReplaceOnConflict?: boolean;
}

export class ManticoreSearchEngine implements SearchEngine {
  private readonly client: ManticoreHttpClient;
  private readonly clock: () => Date;
  /** Logical index name; the RT tables are `<indexName>_active` / `<indexName>_archive`. */
  private readonly indexName: string;
  private readonly hybridEnabled: boolean;
  private readonly retryReplaceOnConflict: boolean;
  private readonly versionReads = new Singleflight<SearchVersion>();
  private readonly versionStore: SearchVersionStore;

  constructor(
    client: ManticoreHttpClient,
    versionStore: SearchVersionStore,
    indexName: string = SEARCH_INDEX_NAME,
    clock: () => Date = () => new Date(),
    options: ManticoreSearchEngineOptions = {}
  ) {
    this.client = client;
    this.versionStore = versionStore;
    this.indexName = indexName;
    this.clock = clock;
    this.hybridEnabled =
      options.hybridEnabled ?? process.env.SEARCH_HYBRID === "1";
    this.retryReplaceOnConflict = options.retryReplaceOnConflict ?? false;
  }

  static fromUrl(
    baseUrl: string,
    versionStore: SearchVersionStore,
    indexName: string = SEARCH_INDEX_NAME,
    clock: () => Date = () => new Date(),
    options: ManticoreSearchEngineOptions = {}
  ): ManticoreSearchEngine {
    // CTP-627: the Effect HTTP client is the only search transport.
    const client: ManticoreHttpClient = new FetchManticoreEffectClient(baseUrl);
    return new ManticoreSearchEngine(
      client,
      versionStore,
      indexName,
      clock,
      options
    );
  }

  private table(partition: SearchPartition): string {
    return partitionTable(this.indexName, partition);
  }

  private async replaceDocument(
    index: string,
    document: ManticoreIndexedDocument
  ): Promise<void> {
    const maxAttempts = this.retryReplaceOnConflict
      ? LIVE_REPLACE_CONFLICT_RETRIES + 1
      : 1;
    const replace = async (attempt: number): Promise<void> => {
      try {
        await replaceManticoreDocument(this.client, index, document);
      } catch (error) {
        const retryable =
          error instanceof Error &&
          MANTICORE_CONFLICT_MESSAGE.test(error.message) &&
          attempt < maxAttempts;
        if (!retryable) {
          throw error;
        }
        await waitForManticoreRetry();
        await replace(attempt + 1);
      }
    };
    await replace(1);
  }

  /**
   * One POST /bulk per chunk (RJC-389). Under 6.3.8 a bulk is all-or-nothing
   * per consecutive same-table run (see manticoreBulkPayloadSchema; with the
   * RJC-383 split a request can hold several runs, and runs before the
   * failing one DO land — verified live). When a chunk fails at line L the
   * mutation owning L is re-sent ALONE before anyone is blamed:
   * alone-succeeds means the failure was positional or batch-wide (no blame,
   * mutation applied); alone-fails is the only path that yields a `failure`.
   * The rest of the chunk is then re-sent without it. A mutation's lines
   * (a move is replace-then-delete across two tables) always travel
   * together, so a failing replace never lets its delete run and a document
   * can never vanish from both tables. Isolation is capped per chunk
   * (MANTICORE_BULK_ISOLATION_RESENDS_PER_CHUNK) so a poison-heavy backlog
   * still drains ≥1 row per chunk per drain; whatever cannot be isolated is
   * `unapplied` (released unblamed), as are all later chunks. Manticore
   * writes land first, the checkpoint advances second (to the batch sequence
   * when all applied, else to the highest applied sequence): a crash in
   * between re-applies the batch, which replace/delete-by-id make idempotent.
   */
  async applyBatch(batch: SearchIndexBatch): Promise<SearchIndexBatchResult> {
    const indexVersion = Number(batch.appliedSequence);
    const chunks = chunkBulkLines(
      batch.mutations.map((mutation) => ({
        id: mutationId(mutation),
        lines: this.toBulkLines(mutation, indexVersion).map((line) =>
          JSON.stringify(line)
        ),
        sequence: mutation.sequenceNumber,
      })),
      MANTICORE_BULK_MAX_BYTES
    );

    const failures: SearchMutationFailure[] = [];
    const unapplied: string[] = [];
    let appliedSequence: bigint | null = null;

    /* oxlint-disable no-await-in-loop -- chunks are sent in sequence order; an unresolved failure stops the batch */
    for (const [chunkIndex, chunk] of chunks.entries()) {
      const outcome = await this.applyChunk(chunk);
      failures.push(...outcome.failures);
      unapplied.push(...outcome.unapplied);
      for (const sequence of outcome.appliedSequences) {
        if (appliedSequence === null || sequence > appliedSequence) {
          appliedSequence = sequence;
        }
      }
      if (outcome.stop) {
        for (const later of chunks.slice(chunkIndex + 1)) {
          unapplied.push(...later.entries.map((entry) => entry.id));
        }
        break;
      }
    }
    /* oxlint-enable no-await-in-loop */

    if (failures.length === 0 && unapplied.length === 0) {
      const version = await this.versionStore.advance(batch.appliedSequence);
      return { ...version, failures, unapplied };
    }
    const version =
      appliedSequence === null
        ? await this.getAppliedVersion()
        : await this.versionStore.advance(appliedSequence);
    return { ...version, failures, unapplied };
  }

  /** One chunk with the isolation re-send policy described on applyBatch. */
  private async applyChunk(chunk: BulkChunk): Promise<ChunkOutcome> {
    const outcome: ChunkOutcome = {
      appliedSequences: [],
      failures: [],
      stop: false,
      unapplied: [],
    };
    let pending = chunk;
    let isolationsLeft = MANTICORE_BULK_ISOLATION_RESENDS_PER_CHUNK;
    /* oxlint-disable no-await-in-loop -- each round depends on the previous response */
    while (pending.entries.length > 0) {
      const result = await bulkManticore(this.client, chunkLines(pending));
      if (result.ok) {
        outcome.appliedSequences.push(
          ...pending.entries.map((entry) => entry.sequence)
        );
        return outcome;
      }
      if (result.failingLine === null) {
        throw new Error(
          `Manticore bulk failed without naming a line: ${result.error}`
        );
      }
      if (isolationsLeft === 0) {
        outcome.unapplied.push(...pending.entries.map((entry) => entry.id));
        outcome.stop = true;
        return outcome;
      }
      isolationsLeft -= 1;
      const at = entryIndexOfLine(pending, result.failingLine);
      const entry = pending.entries[at];
      const alone = await bulkManticore(this.client, entry?.lines ?? []);
      if (alone.ok) {
        outcome.appliedSequences.push(entry?.sequence ?? ZERO_SEQUENCE);
      } else {
        outcome.failures.push({ error: alone.error, id: entry?.id ?? "" });
      }
      pending = withoutEntry(pending, at);
    }
    /* oxlint-enable no-await-in-loop */
    return outcome;
  }

  /**
   * Lines for one mutation (RJC-383). An upsert is a replace into its
   * partition's table, followed — only when the previous partition is
   * different or unknown — by a delete from the other table. Replace comes
   * FIRST on purpose: 6.3.8 commits per same-table run, so if the replace
   * fails the request stops before the delete and the document is still
   * findable in its old table; if the delete fails after the replace landed
   * the document is briefly in both tables until the retry, never in
   * neither. A delete goes to the known partition, or to both.
   */
  private toBulkLines(
    mutation: SearchIndexMutation,
    indexVersion: number
  ): ManticoreBulkLine[] {
    const deleteFrom = (
      id: string,
      partition: SearchPartition
    ): ManticoreBulkLine => ({
      delete: { id: hashDocumentId(id), index: this.table(partition) },
    });
    const deleteFromBase = (id: string): ManticoreBulkLine => ({
      delete: { id: hashDocumentId(id), index: this.indexName },
    });
    if (mutation.kind === "delete") {
      const partitions =
        mutation.partition === undefined
          ? SEARCH_PARTITIONS
          : [mutation.partition];
      const lines = partitions.map((partition) =>
        deleteFrom(mutation.id, partition)
      );
      if (this.hybridEnabled) {
        lines.push(deleteFromBase(mutation.id));
      }
      return lines;
    }
    // Capture one clock value for both partition and the fallback hash. The
    // normal projector supplies its precomputed hash so the physical row is
    // byte-for-byte aligned with the state it persists after this write.
    const now = this.clock();
    const partition =
      mutation.partition ?? documentPartition(mutation.document, now);
    const hash =
      mutation.projectionHash ?? projectionHash(mutation.document, now);
    const indexedDocument = documentToManticore(
      mutation.document,
      indexVersion,
      hash
    );
    const lines: ManticoreBulkLine[] = [
      {
        replace: {
          doc: indexedDocument,
          id: hashDocumentId(mutation.document.id),
          index: this.table(partition),
        },
      },
    ];
    if (this.hybridEnabled) {
      lines.push({
        replace: {
          doc: indexedDocument,
          id: hashDocumentId(mutation.document.id),
          index: this.indexName,
        },
      });
    }
    if (mutation.previousPartition !== partition) {
      lines.push(deleteFrom(mutation.document.id, otherPartition(partition)));
    }
    return lines;
  }

  async deleteDocument(id: string): Promise<void> {
    for (const partition of SEARCH_PARTITIONS) {
      // oxlint-disable-next-line no-await-in-loop -- two tables, sequential to keep the client simple
      await deleteManticoreDocument(this.client, this.table(partition), id);
    }
    if (this.hybridEnabled) {
      await deleteManticoreDocument(this.client, this.indexName, id);
    }
  }

  /**
   * Coalesces concurrent checkpoint reads (RJC-388's singleflight, applied to
   * the version read). Every search reads the version at least twice — once
   * in SearchAdapter to build the cache key, once here — and under load N
   * concurrent searches each issued their own SELECT against the same
   * unchanging row. Sharing the in-flight read returns exactly what a
   * separate read would have: no staleness window, because nothing is
   * retained after it settles.
   */
  getAppliedVersion(): Promise<SearchVersion> {
    return this.versionReads.run(this.indexName, async () => {
      const checkpoint = await this.versionStore.read();
      return {
        appliedSequence: checkpoint.appliedSequence,
        generation: checkpoint.generation,
      };
    }).promise;
  }

  /**
   * Scope "active" reads `<index>_active`. Lexical "all" reads both partition
   * tables in one request; hybrid "all" reads the synchronized logical base
   * table because Manticore 29 rejects hybrid multi-table queries with the
   * deterministic secondary sorter and aggregations. For
   * "active" a second, aggregation-free `limit: 0` request against the
   * archive runs in parallel so the UI can report "N in archief" honestly;
   * that is the one extra round trip the split costs the default search.
   * The count is decoration and the search is the product: it runs under
   * its own, smaller budget (ARCHIVE_COUNT_TIMEOUT_MS) and any failure or
   * timeout degrades `archiveTotal` to `null` — it never rejects the search
   * and never touches `emptyReason`.
   */
  async search(params: EngineSearchParams): Promise<SearchEngineResult> {
    const scope: SearchScope = params.scope ?? DEFAULT_SEARCH_SCOPE;
    const { archiveCountRequest, facetRequests, request } =
      recordCriticalPathPhaseSync("search-serialization", () => {
        const textFields =
          (params.filters.queryScope ?? DEFAULT_QUERY_SCOPE) === "title"
            ? SEARCH_TITLE_SCOPE_FIELDS
            : SEARCH_TEXT_FIELDS;
        const queryString = buildQueryString(params.ast, textFields);
        const requestedMode = params.mode ?? "lexical";
        const mode =
          requestedMode === "hybrid" &&
          params.ast !== null &&
          isHybridSearchEligible(params.ast)
            ? "hybrid"
            : "lexical";
        const knnQueryText =
          mode === "hybrid" ? buildKnnQueryText(params.ast) : undefined;
        const queryBody: ManticoreQueryBody | null =
          queryString === null ? null : { query_string: queryString };
        const searchTable =
          mode === "hybrid" && scope === "all"
            ? this.indexName
            : scopeTables(this.indexName, scope);
        const searchRequest = buildManticoreSearchRequest(
          searchTable,
          queryBody,
          params.filters,
          params.limit,
          params.offset,
          params.sort,
          mode,
          knnQueryText ?? undefined
        );
        if (params.facets === false) {
          delete searchRequest.aggs;
        }
        let hybridFacetRequests: ManticoreSearchRequestBody[] = [];
        if (mode === "hybrid" && searchRequest.aggs) {
          hybridFacetRequests = HYBRID_FACET_NAMES.map((facetName) => ({
            ...searchRequest,
            aggs: { [facetName]: searchRequest.aggs?.[facetName] },
            limit: 0,
            offset: 0,
          }));
          for (const facetRequest of hybridFacetRequests) {
            delete facetRequest.sort;
          }
          delete searchRequest.aggs;
        }
        return {
          archiveCountRequest:
            scope === "active"
              ? buildManticoreCountRequest(
                  this.table("archive"),
                  queryBody,
                  params.filters,
                  mode,
                  knnQueryText ?? undefined
                )
              : null,
          facetRequests: hybridFacetRequests,
          request: searchRequest,
        };
      });

    // The version read is a Postgres round trip (Neon over TLS in
    // production) and the Manticore query does not depend on it — it is only
    // needed to label the result and to tell "empty index" apart from "no
    // matches". Awaiting it first put its full latency in front of every
    // uncached search; issued alongside, it costs whatever it exceeds the
    // search by, which is normally nothing.
    const [hitResponse, facetResponses, archiveTotal, version] =
      await Promise.all([
        searchManticore(this.client, request),
        Promise.all(
          facetRequests.map((facetRequest) =>
            searchManticore(this.client, facetRequest)
          )
        ),
        this.countArchive(archiveCountRequest),
        this.getAppliedVersion(),
      ]);
    const response = { ...hitResponse };
    for (const [index, facetName] of HYBRID_FACET_NAMES.entries()) {
      const facetResponse = facetResponses[index];
      if (facetResponse) {
        response.facets[facetName] = facetResponse.facets[facetName];
        response.emptyReason ??= facetResponse.emptyReason;
        response.incomplete ||= facetResponse.incomplete;
      }
    }
    // A reason Manticore itself reported (e.g. "query_timeout", RJC-380)
    // takes priority over the empty_index fallback below — an index that
    // timed out at zero hits is not the same thing as a genuinely empty
    // index, and must not be reported as one.
    const emptyReason =
      response.emptyReason ??
      (response.total === 0 && version.appliedSequence === ZERO_SEQUENCE
        ? "empty_index"
        : undefined);

    const facets = recordCriticalPathPhaseSync(
      "search-facets",
      () => response.facets
    );

    return {
      archiveTotal,
      emptyReason,
      facets,
      hits: response.hits,
      incomplete: response.incomplete,
      indexVersion: Number(version.appliedSequence),
      scope,
      total: response.total,
      windowLimit: SEARCH_WINDOW_LIMIT,
    };
  }

  /** `undefined` for scope "all" (no request); `null` when the count failed or timed out — the search itself is unaffected. */
  private async countArchive(
    request: ManticoreSearchRequestBody | null
  ): Promise<number | null | undefined> {
    if (request === null) {
      return undefined;
    }
    try {
      const counted = await searchManticore(this.client, request, {
        timeoutMs: ARCHIVE_COUNT_TIMEOUT_MS,
      });
      return counted.total;
    } catch (error) {
      // oxlint-disable-next-line no-console -- degradation must leave a trace; @ji/search has no logger dependency
      console.warn(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          event: "search.archive_count_failed",
          index: request.index,
          timeoutMs: ARCHIVE_COUNT_TIMEOUT_MS,
        })
      );
      return null;
    }
  }

  /** Replace into the document's partition, then evict it from the other table (previous partition unknown here). */
  async upsertDocument(document: SearchDocument): Promise<void> {
    const version = await this.getAppliedVersion();
    const now = this.clock();
    const partition = documentPartition(document, now);
    const indexedDocument = documentToManticore(
      document,
      Number(version.appliedSequence),
      projectionHash(document, now)
    );
    await this.replaceDocument(this.table(partition), indexedDocument);
    if (this.hybridEnabled) {
      await this.replaceDocument(this.indexName, indexedDocument);
    }
    await deleteManticoreDocument(
      this.client,
      this.table(otherPartition(partition)),
      document.id
    );
  }
}

export const buildRecordedQuery = (
  ast: BooleanNode | null,
  queryScope: "all" | "title" = DEFAULT_QUERY_SCOPE
): ManticoreBoolQuery | ManticoreQueryBody | null => {
  if (ast === null) {
    return null;
  }

  const textFields =
    queryScope === "title" ? SEARCH_TITLE_SCOPE_FIELDS : SEARCH_TEXT_FIELDS;
  const queryString = buildQueryString(ast, textFields);
  if (queryString !== null) {
    return { query_string: queryString };
  }

  return buildBoolJson(ast, textFields);
};
