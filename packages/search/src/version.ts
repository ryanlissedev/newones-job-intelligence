/* oxlint-disable max-classes-per-file -- the mismatch error and the in-memory store are one cohesive version module */
/**
 * Durable search version (RJC-384). The authoritative copy lives in
 * `curated.search_projection_checkpoint`; process memory only echoes it.
 */
/**
 * apps/web type-checks this package at target ES2018, where bigint literals
 * are a syntax error, while the linter rejects inline `BigInt(...)` calls.
 * One pinned constant keeps both gates green.
 */
// oxlint-disable-next-line unicorn/prefer-bigint-literals -- see above
export const ZERO_SEQUENCE = BigInt(0);

export interface SearchVersion {
  /** Highest DB-generated outbox sequence applied to the index. */
  readonly appliedSequence: bigint;
  /** Bumps on a new index, schema change, or full rebuild. */
  readonly generation: number;
}

export interface SearchVersionCheckpoint extends SearchVersion {
  readonly schemaHash: string;
}

/** Orders versions: generation first, then appliedSequence. */
export const compareSearchVersions = (
  left: SearchVersion,
  right: SearchVersion
): -1 | 0 | 1 => {
  if (left.generation !== right.generation) {
    return left.generation < right.generation ? -1 : 1;
  }
  if (left.appliedSequence !== right.appliedSequence) {
    return left.appliedSequence < right.appliedSequence ? -1 : 1;
  }
  return 0;
};

/**
 * True when `candidate` is older than `current` — the check the cache and
 * cursor work (later RJC-384 steps) uses to detect stale snapshots.
 *
 * Equal versions do not mean equal index contents (RJC-389): the watermark
 * can sit above unprocessed or retrying outbox rows, and a row re-applied
 * below it does not bump the version. Treat "not stale" as "no newer
 * batch has landed", and bound cache freshness by TTL.
 */
export const isStaleSearchVersion = (
  candidate: SearchVersion,
  current: SearchVersion
): boolean => compareSearchVersions(candidate, current) < 0;

/**
 * Identifies the indexed document mapping AND table layout. Update this
 * string whenever the Manticore column mapping (`documentToManticore`) or
 * the set of tables it writes to changes; a checkpoint carrying a different
 * hash means the index was built for another schema and requires a full
 * rebuild (new generation), never a silent reindex. v3 (RJC-383): the same
 * columns, now split over `aanvragen_active` + `aanvragen_archive`. v4 added
 * an inspectable canonical `projection_hash` attribute to each RT row. v6
 * records that `locatie` is omitted when the source location is unknown. v8
 * also omits `locatie_land` for those rows. The v7 hybrid mapping adds an
 * auto-embedding vector and the measured Dutch wordforms; v9 carries the
 * same unknown-location mapping and is a distinct generation only when
 * SEARCH_HYBRID=1. v12 adds the source-published skills JSON array as a
 * filterable/faceted attribute; v13 is its hybrid successor.
 */
// ponytail: hand-maintained constant; runtime hashing of the mapping buys
// nothing until the mapping itself is data-driven.
export const SEARCH_SCHEMA_HASH_V6 =
  "aanvragen-v6[active|archive]:beschrijving,bron_id,contracttype,document_id,index_version,laatst_gezien_op,locatie,locatie_land,sluitingsdatum,status,tarief_max,tarief_min,titel,projection_hash;locatie=nullable-omitted";

/** Previous mapping: unknown locations omit both location attributes. */
export const SEARCH_SCHEMA_HASH_V8 =
  "aanvragen-v8[active|archive]:beschrijving,bron_id,contracttype,document_id,index_version,laatst_gezien_op,locatie,locatie_land,sluitingsdatum,status,tarief_max,tarief_min,titel,projection_hash;locatie=nullable-omitted;locatie_land=nullable-omitted";

/**
 * CTP-493 parity mapping before skills indexing: company, publication date,
 * workform, hours, rate period, and province. Kept as the previous lexical
 * generation. Activate schema changes only through the pending-generation/
 * replay protocol — never mutate production Manticore ad hoc in the same
 * change that introduces this hash.
 */
export const SEARCH_SCHEMA_HASH_V10 =
  "aanvragen-v10[active|archive]:beschrijving,bron_id,contracttype,document_id,index_version,laatst_gezien_op,locatie,locatie_land,opdrachtgever_naam,provincie,publicatiedatum,sluitingsdatum,status,tarief_eenheid,tarief_max,tarief_min,titel,uren_per_week_max,uren_per_week_min,werkvorm,projection_hash;locatie=nullable-omitted;locatie_land=nullable-omitted;eindklant=null;skills=empty-default";

/** Current lexical mapping with skills as a string JSON array. */
export const SEARCH_SCHEMA_HASH_V12 =
  "aanvragen-v12[active|archive]:beschrijving,bron_id,contracttype,document_id,index_version,laatst_gezien_op,locatie,locatie_land,opdrachtgever_naam,provincie,publicatiedatum,sluitingsdatum,skills,status,tarief_eenheid,tarief_max,tarief_min,titel,uren_per_week_max,uren_per_week_min,werkvorm,projection_hash;locatie=nullable-omitted;locatie_land=nullable-omitted;eindklant=null;skills=json-array";

/** Previous mapping, where every indexed document supplied `locatie`. */
export const SEARCH_SCHEMA_HASH_V4 =
  "aanvragen-v4[active|archive]:beschrijving,bron_id,contracttype,document_id,index_version,laatst_gezien_op,locatie,locatie_land,sluitingsdatum,status,tarief_max,tarief_min,titel,projection_hash";

/** Previous hybrid mapping, before country omission for unknown locations. */
export const SEARCH_SCHEMA_HASH_HYBRID_V7 =
  "aanvragen-v7[all|active|archive]:beschrijving,bron_id,contracttype,document_id,embedding,index_version,laatst_gezien_op,locatie,locatie_land,sluitingsdatum,status,tarief_max,tarief_min,titel,projection_hash;locatie=nullable-omitted;embedding=hnsw/cosine/Xenova/paraphrase-multilingual-MiniLM-L12-v2/from:titel+beschrijving;wordforms=gemeenten>gemeent,duurzame>duurzaam";

/** Previous hybrid mapping before CTP-493 parity attributes. */
export const SEARCH_SCHEMA_HASH_HYBRID_V9 =
  "aanvragen-v9[all|active|archive]:beschrijving,bron_id,contracttype,document_id,embedding,index_version,laatst_gezien_op,locatie,locatie_land,sluitingsdatum,status,tarief_max,tarief_min,titel,projection_hash;locatie=nullable-omitted;locatie_land=nullable-omitted;embedding=hnsw/cosine/Xenova/paraphrase-multilingual-MiniLM-L12-v2/from:titel+beschrijving;wordforms=gemeenten>gemeent,duurzame>duurzaam";

/** Previous hybrid mapping with CTP-493 parity attributes but no skills field. */
export const SEARCH_SCHEMA_HASH_HYBRID_V11 =
  "aanvragen-v11[all|active|archive]:beschrijving,bron_id,contracttype,document_id,embedding,index_version,laatst_gezien_op,locatie,locatie_land,opdrachtgever_naam,provincie,publicatiedatum,sluitingsdatum,status,tarief_eenheid,tarief_max,tarief_min,titel,uren_per_week_max,uren_per_week_min,werkvorm,projection_hash;locatie=nullable-omitted;locatie_land=nullable-omitted;eindklant=null;skills=empty-default;embedding=hnsw/cosine/Xenova/paraphrase-multilingual-MiniLM-L12-v2/from:titel+beschrijving;wordforms=gemeenten>gemeent,duurzame>duurzaam";

/** Current hybrid successor to v11 with skills as a string JSON array. */
export const SEARCH_SCHEMA_HASH_HYBRID =
  "aanvragen-v13[all|active|archive]:beschrijving,bron_id,contracttype,document_id,embedding,index_version,laatst_gezien_op,locatie,locatie_land,opdrachtgever_naam,provincie,publicatiedatum,sluitingsdatum,skills,status,tarief_eenheid,tarief_max,tarief_min,titel,uren_per_week_max,uren_per_week_min,werkvorm,projection_hash;locatie=nullable-omitted;locatie_land=nullable-omitted;eindklant=null;skills=json-array;embedding=hnsw/cosine/Xenova/paraphrase-multilingual-MiniLM-L12-v2/from:titel+beschrijving;wordforms=gemeenten>gemeent,duurzame>duurzaam";

/** Resolves the checkpoint schema without enabling the candidate by default. */
export const resolveSearchSchemaHash = (
  searchHybrid: string | undefined = undefined
): string =>
  searchHybrid === "1" ? SEARCH_SCHEMA_HASH_HYBRID : SEARCH_SCHEMA_HASH_V12;

export const SEARCH_SCHEMA_HASH = resolveSearchSchemaHash(
  process.env.SEARCH_HYBRID
);

/**
 * The single-table mapping before RJC-383 split the index. Kept only so
 * version.spec.ts can prove a checkpoint stamped with it is rejected.
 */
export const SEARCH_SCHEMA_HASH_V2 =
  "aanvragen-v2:beschrijving,bron_id,contracttype,document_id,index_version,laatst_gezien_op,locatie,locatie_land,sluitingsdatum,status,tarief_max,tarief_min,titel";

/**
 * The mapping before RJC-378 added `locatie` and `sluitingsdatum`. Kept only
 * so version.spec.ts can prove a checkpoint stamped with it is rejected.
 */
export const SEARCH_SCHEMA_HASH_V1 =
  "aanvragen-v1:beschrijving,bron_id,contracttype,document_id,index_version,laatst_gezien_op,locatie_land,status,tarief_max,tarief_min,titel";

export interface SearchVersionStore {
  /** Monotonic: never moves the checkpoint backwards. */
  advance: (appliedSequence: bigint) => Promise<SearchVersion>;
  /** Reads the durable checkpoint, initializing it if absent. */
  read: () => Promise<SearchVersionCheckpoint>;
  /** Full rebuild: bumps generation and resets appliedSequence to 0. */
  startNewGeneration: (schemaHash: string) => Promise<SearchVersion>;
}

export interface StartSearchGenerationResult {
  /** Null when the checkpoint already carries `schemaHash` and force was off. */
  readonly next: SearchVersion | null;
  readonly previous: SearchVersionCheckpoint;
}

/**
 * Operator entry point for a schema bump (tools/manticore/
 * start-search-generation.ts). Refuses to re-run for a hash the checkpoint
 * already has — a second generation without a reindex only loses data —
 * unless `force` is set.
 */
export const startSearchGeneration = async (
  store: SearchVersionStore,
  schemaHash: string,
  options: { readonly force?: boolean } = {}
): Promise<StartSearchGenerationResult> => {
  const previous = await store.read();
  if (previous.schemaHash === schemaHash && options.force !== true) {
    return { next: null, previous };
  }
  const next = await store.startNewGeneration(schemaHash);
  return { next, previous };
};

export class SearchIndexSchemaMismatchError extends Error {
  readonly expectedSchemaHash: string;
  readonly storedSchemaHash: string;

  constructor(storedSchemaHash: string, expectedSchemaHash: string) {
    super(
      `Search index schema hash mismatch: checkpoint has "${storedSchemaHash}", code expects "${expectedSchemaHash}". ` +
        "Full rebuild required — start a new generation via SearchVersionStore.startNewGeneration and reindex; do not reindex silently."
    );
    this.name = "SearchIndexSchemaMismatchError";
    this.expectedSchemaHash = expectedSchemaHash;
    this.storedSchemaHash = storedSchemaHash;
  }
}

/** Process-local store for tests, benchmarks, and the in-memory engine. */
export class InMemorySearchVersionStore implements SearchVersionStore {
  private checkpoint: SearchVersionCheckpoint;

  constructor(schemaHash: string = SEARCH_SCHEMA_HASH) {
    this.checkpoint = {
      appliedSequence: ZERO_SEQUENCE,
      generation: 1,
      schemaHash,
    };
  }

  advance(appliedSequence: bigint): Promise<SearchVersion> {
    if (appliedSequence > this.checkpoint.appliedSequence) {
      this.checkpoint = { ...this.checkpoint, appliedSequence };
    }
    return Promise.resolve({
      appliedSequence: this.checkpoint.appliedSequence,
      generation: this.checkpoint.generation,
    });
  }

  read(): Promise<SearchVersionCheckpoint> {
    return Promise.resolve(this.checkpoint);
  }

  startNewGeneration(schemaHash: string): Promise<SearchVersion> {
    this.checkpoint = {
      appliedSequence: ZERO_SEQUENCE,
      generation: this.checkpoint.generation + 1,
      schemaHash,
    };
    return Promise.resolve({
      appliedSequence: ZERO_SEQUENCE,
      generation: this.checkpoint.generation,
    });
  }
}
