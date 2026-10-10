import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { curatedSchema } from "./schemas";

export const bron = curatedSchema.table(
  "bron",
  {
    actief: boolean("actief").default(false).notNull(),
    categorie: text("categorie").notNull(),
    configRef: text("config_ref"),
    crawlDelayMs: integer("crawl_delay_ms").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    id: uuid("id").defaultRandom().primaryKey(),
    ingestieType: text("ingestie_type").default("json-api").notNull(),
    interval: text("interval").default("0 * * * *").notNull(),
    loginVereist: boolean("login_vereist").default(false).notNull(),
    mappingRef: text("mapping_ref"),
    naam: text("naam").notNull(),
    rateLimitPerMinute: integer("rate_limit_per_minute").default(1).notNull(),
    retentionDays: integer("retention_days").default(90).notNull(),
    schedule: text("schedule"),
    secretRef: text("secret_ref"),
    status: text("status").default("deferred").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    voorwaardenStatus: text("voorwaarden_status")
      .default("te_toetsen")
      .notNull(),
    website: text("website"),
  },
  (table) => [
    index("bron_status_idx").on(table.status),
    index("bron_categorie_idx").on(table.categorie),
    uniqueIndex("bron_naam_lower_uidx").on(sql`lower(${table.naam})`),
    check(
      "bron_status_check",
      sql`${table.status} IN ('ready', 'blocked', 'deferred')`
    ),
    check(
      "bron_voorwaarden_status_check",
      sql`${table.voorwaardenStatus} IN ('toegestaan', 'verboden', 'te_toetsen')`
    ),
    check("bron_rate_limit_check", sql`${table.rateLimitPerMinute} > 0`),
    check("bron_crawl_delay_check", sql`${table.crawlDelayMs} >= 0`),
    check("bron_retention_days_check", sql`${table.retentionDays} > 0`),
    check(
      "bron_secret_ref_check",
      sql`${table.secretRef} IS NULL OR ${table.secretRef} ~ '^(op|vault|trigger)://[^[:space:]/]+(/[^[:space:]]*)?$'`
    ),
    check(
      "bron_ready_policy_check",
      sql`${table.status} <> 'ready' OR ${table.voorwaardenStatus} = 'toegestaan'`
    ),
    check(
      "bron_active_policy_check",
      sql`${table.actief} = false OR (${table.status} = 'ready' AND ${table.voorwaardenStatus} = 'toegestaan')`
    ),
  ]
);

export const scrapeRun = curatedSchema.table(
  "scrape_run",
  {
    aantalGevonden: integer("aantal_gevonden").default(0).notNull(),
    bronId: uuid("bron_id")
      .notNull()
      .references(() => bron.id, { onDelete: "cascade" }),
    checkpoint: jsonb("checkpoint"),
    circuitStatus: text("circuit_status").default("closed").notNull(),
    /** How a succeeded run ended (complete/budget_exhausted/...); see `RUN_COMPLETIONS`. */
    completion: text("completion"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    failureClass: text("failure_class"),
    failureCode: text("failure_code"),
    /** What kind of trouble failed the run (blocked/timeout/...); see `RUN_FAILURE_KINDS`. */
    failureKind: text("failure_kind"),
    failureMessage: text("failure_message"),
    failurePhase: text("failure_phase"),
    fenceToken: bigint("fence_token", { mode: "number" }).default(0).notNull(),
    fouten: integer("fouten").default(0).notNull(),
    geindigd: timestamp("geindigd", { withTimezone: true }),
    gesloten: integer("gesloten").default(0).notNull(),
    gestart: timestamp("gestart", { withTimezone: true })
      .defaultNow()
      .notNull(),
    gewijzigd: integer("gewijzigd").default(0).notNull(),
    id: uuid("id").defaultRandom().primaryKey(),
    nieuw: integer("nieuw").default(0).notNull(),
    ongewijzigd: integer("ongewijzigd").default(0).notNull(),
    /** Per-outcome item counters (skipped_known, rejected_<kind>); see `RunOutcomeCounts`. */
    outcomeCounts: jsonb("outcome_counts").default({}).notNull(),
    rejected: integer("rejected").default(0).notNull(),
    runKind: text("run_kind").default("poll").notNull(),
    status: text("status").default("running").notNull(),
    versieAdapter: text("versie_adapter"),
  },
  (table) => [
    index("scrape_run_bron_id_idx").on(table.bronId),
    index("scrape_run_gestart_idx").on(table.gestart),
    // 0031: newest run per bron within a stats window.
    index("scrape_run_bron_gestart_idx").on(table.bronId, table.gestart.desc()),
    check(
      "scrape_run_status_check",
      sql`${table.status} IN ('running', 'succeeded', 'failed', 'cancelled')`
    ),
    check(
      "scrape_run_kind_check",
      sql`${table.runKind} IN ('test', 'poll', 'backfill')`
    ),
    check(
      "scrape_run_metrics_nonnegative_check",
      sql`${table.aantalGevonden} >= 0 AND ${table.nieuw} >= 0 AND ${table.gewijzigd} >= 0 AND ${table.rejected} >= 0 AND ${table.gesloten} >= 0 AND ${table.fouten} >= 0`
    ),
    check(
      "scrape_run_completion_check",
      sql`(${table.status} = 'running' AND ${table.geindigd} IS NULL) OR (${table.status} <> 'running' AND ${table.geindigd} IS NOT NULL)`
    ),
    check(
      "scrape_run_fence_token_check",
      sql`${table.fenceToken} >= 0 AND ${table.fenceToken} <= 9007199254740991`
    ),
    check(
      "scrape_run_failure_kind_check",
      sql`${table.failureKind} IS NULL OR (${table.status} = 'failed' AND ${table.failureKind} IN ('blocked', 'rate_limited', 'timeout', 'http_5xx', 'http_4xx', 'not_found', 'network', 'internal'))`
    ),
    check(
      "scrape_run_completion_kind_check",
      sql`${table.completion} IS NULL OR (${table.status} = 'succeeded' AND ${table.completion} IN ('complete', 'budget_exhausted', 'aborted', 'truncated', 'resumed', 'empty'))`
    ),
    check("scrape_run_ongewijzigd_check", sql`${table.ongewijzigd} >= 0`),
    check(
      "scrape_run_outcome_counts_object_check",
      sql`jsonb_typeof(${table.outcomeCounts}) = 'object'`
    ),
    check(
      "scrape_run_failure_envelope_check",
      sql`(
        ${table.status} = 'failed'
        AND ${table.failurePhase} IS NOT NULL
        AND ${table.failureClass} IS NOT NULL
        AND ${table.failureCode} IS NOT NULL
        AND ${table.failureMessage} IS NOT NULL
      ) OR (
        ${table.status} <> 'failed'
        AND ${table.failurePhase} IS NULL
        AND ${table.failureClass} IS NULL
        AND ${table.failureCode} IS NULL
        AND ${table.failureMessage} IS NULL
      )`
    ),
    check(
      "scrape_run_failure_tuple_check",
      sql`(${table.failurePhase}, ${table.failureClass}, ${table.failureCode}, ${table.failureMessage}) IN (
        ('discover', 'connector', 'DISCOVER_FAILED', 'Connector discovery failed'),
        ('fetch', 'connector', 'FETCH_FAILED', 'Connector fetch failed'),
        ('raw-store', 'storage', 'RAW_STORE_WRITE_FAILED', 'Raw object persistence failed'),
        ('observation', 'persistence', 'OBSERVATION_WRITE_FAILED', 'Observation persistence failed'),
        ('checkpoint', 'persistence', 'CHECKPOINT_WRITE_FAILED', 'Run checkpoint persistence failed'),
        ('complete', 'persistence', 'COMPLETE_WRITE_FAILED', 'Run completion persistence failed'),
        ('unknown', 'internal', 'UNEXPECTED_FAILURE', 'Connector run failed'),
        ('unknown', 'internal', 'LEGACY_FAILURE', 'Legacy run failed' || chr(59) || ' details unavailable')
      ) OR (
        ${table.failurePhase} IS NULL
        AND ${table.failureClass} IS NULL
        AND ${table.failureCode} IS NULL
        AND ${table.failureMessage} IS NULL
      )`
    ),
  ]
);

export const dedupGroep = curatedSchema.table(
  "dedup_groep",
  {
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /**
     * Canonical dedup key from `buildDedupKey` (normalised titel,
     * opdrachtgever, startDatum joined by U+001F). One group per key is
     * enforced by `dedup_groep_dedup_key_uidx`; the curate store relies on
     * that index (insert ... on conflict do nothing, then re-select) so two
     * concurrent imports of the same key converge on one group.
     */
    dedupKey: text("dedup_key"),
    handmatigBevestigd: boolean("handmatig_bevestigd").default(false).notNull(),
    id: uuid("id").defaultRandom().primaryKey(),
    /** Legacy: held the dedup key before migration 0015 moved it to `dedup_key`. */
    methode: text("methode"),
    primaireAanvraagId: uuid("primaire_aanvraag_id"),
    similariteit: numeric("similariteit"),
    status: text("status").default("reviewable").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("dedup_groep_status_idx").on(table.status),
    uniqueIndex("dedup_groep_dedup_key_uidx")
      .on(table.dedupKey)
      .where(sql`${table.dedupKey} IS NOT NULL`),
  ]
);

export const aanvraag = curatedSchema.table(
  "aanvraag",
  {
    beschrijving: text("beschrijving").notNull(),
    bronId: uuid("bron_id")
      .notNull()
      .references(() => bron.id, { onDelete: "restrict" }),
    bronReferentie: text("bron_referentie").notNull(),
    bronSpecifiek: jsonb("bron_specifiek").default({}).notNull(),
    bronUrl: text("bron_url"),
    compleetheidScore: numeric("compleetheid_score"),
    contactpersonen: jsonb("contactpersonen").default([]).notNull(),
    contentHash: text("content_hash").notNull(),
    contracttype: text("contracttype"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    dedupGroepId: uuid("dedup_groep_id").references(() => dedupGroep.id, {
      onDelete: "set null",
    }),
    eersteGezienOp: timestamp("eerste_gezien_op", {
      withTimezone: true,
    }).notNull(),
    eindDatum: text("eind_datum"),
    extractieMethode: text("extractie_methode").notNull(),
    functiegroep: text("functiegroep").default("overig").notNull(),
    id: uuid("id").defaultRandom().primaryKey(),
    laatstGezienOp: timestamp("laatst_gezien_op", {
      withTimezone: true,
    }).notNull(),
    locatieLand: text("locatie_land").default("NL").notNull(),
    locatieTekst: text("locatie_tekst"),
    opdrachtgeverNaam: text("opdrachtgever_naam"),
    publicatiedatum: text("publicatiedatum"),
    rawPayloadRef: text("raw_payload_ref").notNull(),
    scrapeRunId: uuid("scrape_run_id")
      .notNull()
      .references(() => scrapeRun.id, { onDelete: "restrict" }),
    sluitingsdatum: timestamp("sluitingsdatum", { withTimezone: true }),
    startDatum: text("start_datum"),
    status: text("status").default("unknown").notNull(),
    // 0033: mark-not-delete for duplicate identities. A superseded row keeps
    // its id, referentie and FKs; superseded_by points at the kept row.
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededBy: uuid("superseded_by"),
    supersededReason: text("superseded_reason"),
    taal: text("taal").default("nl").notNull(),
    tariefEenheid: text("tarief_eenheid"),
    tariefMax: numeric("tarief_max"),
    tariefMin: numeric("tarief_min"),
    tariefValuta: text("tarief_valuta").default("EUR").notNull(),
    titel: text("titel").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    urenPerWeek: text("uren_per_week"),
    v1Id: text("v1_id"),
    versie: integer("versie").default(1).notNull(),
    werkvorm: text("werkvorm"),
  },
  (table) => [
    uniqueIndex("aanvraag_bron_referentie_uidx").on(
      table.bronId,
      table.bronReferentie
    ),
    uniqueIndex("aanvraag_v1_id_uidx")
      .on(table.v1Id)
      .where(sql`${table.v1Id} IS NOT NULL`),
    index("aanvraag_dedup_groep_id_idx").on(table.dedupGroepId),
    index("aanvraag_status_idx").on(table.status),
    // 0031: per-bron status counts and the overlap endpoint's group-by.
    index("aanvraag_bron_status_idx").on(table.bronId, table.status),
    index("aanvraag_dedup_groep_bron_idx").on(table.dedupGroepId, table.bronId),
    // 0034: one live row per normalized identity. Built in prod by
    // tools/postgres/unique-key/04-unique-index-concurrently.sql.
    uniqueIndex("aanvraag_bron_referentie_live_uidx")
      .on(table.bronId, sql`lower(btrim(${table.bronReferentie}))`)
      .where(sql`${table.supersededBy} IS NULL`),
  ]
);

/**
 * 0033: append-only audit of every aanvraag marked superseded by
 * tools/postgres/unique-key/03-mark-superseded.sql. Rows are never deleted
 * from curated.aanvraag; this snapshot makes a mark auditable and undoable.
 */
export const aanvraagDupArchive = curatedSchema.table(
  "aanvraag_dup_archive",
  {
    aanvraagId: uuid("aanvraag_id").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    archivedBy: text("archived_by")
      .default(sql`current_user`)
      .notNull(),
    bronId: uuid("bron_id").notNull(),
    bronReferentie: text("bron_referentie").notNull(),
    id: uuid("id").defaultRandom().primaryKey(),
    keptAanvraagId: uuid("kept_aanvraag_id").notNull(),
    normalizedReferentie: text("normalized_referentie").notNull(),
    reason: text("reason").notNull(),
    restoredAt: timestamp("restored_at", { withTimezone: true }),
    rowSnapshot: jsonb("row_snapshot").notNull(),
  },
  (table) => [
    index("aanvraag_dup_archive_aanvraag_idx").on(table.aanvraagId),
    index("aanvraag_dup_archive_reason_idx").on(table.reason, table.archivedAt),
  ]
);

export const aanvraagVersie = curatedSchema.table(
  "aanvraag_versie",
  {
    aanvraagId: uuid("aanvraag_id")
      .notNull()
      .references(() => aanvraag.id, { onDelete: "cascade" }),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    geldigTot: timestamp("geldig_tot", { withTimezone: true }),
    geldigVan: timestamp("geldig_van", { withTimezone: true })
      .defaultNow()
      .notNull(),
    id: uuid("id").defaultRandom().primaryKey(),
    rawPayloadRef: text("raw_payload_ref").notNull(),
    scrapeRunId: uuid("scrape_run_id")
      .notNull()
      .references(() => scrapeRun.id, { onDelete: "restrict" }),
    snapshot: jsonb("snapshot").notNull(),
    versie: integer("versie").notNull(),
  },
  (table) => [
    uniqueIndex("aanvraag_versie_aanvraag_versie_uidx").on(
      table.aanvraagId,
      table.versie
    ),
    index("aanvraag_versie_open_idx")
      .on(table.aanvraagId)
      .where(sql`${table.geldigTot} IS NULL`),
  ]
);

export const aanvraagBronLink = curatedSchema.table(
  "aanvraag_bron_link",
  {
    aanvraagId: uuid("aanvraag_id")
      .notNull()
      .references(() => aanvraag.id, { onDelete: "cascade" }),
    bronId: uuid("bron_id")
      .notNull()
      .references(() => bron.id, { onDelete: "cascade" }),
    bronReferentie: text("bron_referentie").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    id: uuid("id").defaultRandom().primaryKey(),
    isPrimary: boolean("is_primary").default(false).notNull(),
  },
  (table) => [
    uniqueIndex("aanvraag_bron_link_aanvraag_bron_uidx").on(
      table.aanvraagId,
      table.bronId
    ),
  ]
);

export const savedSearch = curatedSchema.table(
  "saved_search",
  {
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    filters: jsonb("filters").default({}).notNull(),
    id: uuid("id").defaultRandom().primaryKey(),
    naam: text("naam").notNull(),
    parserVersion: text("parser_version").notNull(),
    queryText: text("query_text").notNull(),
    schemaVersion: text("schema_version").notNull(),
    scopeId: text("scope_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => [
    index("saved_search_user_id_idx").on(table.userId),
    index("saved_search_scope_user_idx").on(table.scopeId, table.userId),
    check(
      "saved_search_scope_id_check",
      sql`length(trim(${table.scopeId})) > 0`
    ),
  ]
);

export const aanvraagEnrichment = curatedSchema.table(
  "aanvraag_enrichment",
  {
    aanvraagId: uuid("aanvraag_id")
      .notNull()
      .references(() => aanvraag.id, { onDelete: "cascade" }),
    confidence: numeric("confidence").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    field: text("field").notNull(),
    id: uuid("id").defaultRandom().primaryKey(),
    rawRefs: jsonb("raw_refs").default([]).notNull(),
    source: text("source").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    value: jsonb("value").notNull(),
  },
  (table) => [
    uniqueIndex("aanvraag_enrichment_aanvraag_field_uidx").on(
      table.aanvraagId,
      table.field
    ),
    index("aanvraag_enrichment_aanvraag_id_idx").on(table.aanvraagId),
    check(
      "aanvraag_enrichment_field_check",
      sql`${table.field} IN ('locatie', 'tarief', 'contract', 'remote', 'publicatiedatum', 'beschrijving', 'uren', 'opleiding', 'startdatum', 'einddatum', 'sluitingsdatum', 'organisatie')`
    ),
    check(
      "aanvraag_enrichment_source_check",
      sql`${table.source} IN ('deterministic', 'llm')`
    ),
    check(
      "aanvraag_enrichment_confidence_check",
      sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`
    ),
  ]
);

export const aanvraagMarkering = curatedSchema.table(
  "aanvraag_markering",
  {
    aanvraagId: uuid("aanvraag_id")
      .notNull()
      .references(() => aanvraag.id, { onDelete: "cascade" }),
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    id: uuid("id").defaultRandom().primaryKey(),
    reden: text("reden"),
    revision: integer("revision").default(1).notNull(),
    scopeId: text("scope_id").notNull(),
    status: text("status").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => [
    uniqueIndex("aanvraag_markering_user_aanvraag_uidx").on(
      table.scopeId,
      table.userId,
      table.aanvraagId
    ),
    index("aanvraag_markering_scope_user_idx").on(table.scopeId, table.userId),
    index("aanvraag_markering_aanvraag_id_idx").on(table.aanvraagId),
    index("aanvraag_markering_user_id_idx").on(table.userId),
    check(
      "aanvraag_markering_status_check",
      sql`${table.status} IN ('relevant', 'niet_relevant', 'gevolgd')`
    ),
    check("aanvraag_markering_revision_check", sql`${table.revision} >= 1`),
    check(
      "aanvraag_markering_scope_id_check",
      sql`length(trim(${table.scopeId})) > 0`
    ),
  ]
);

export const querySnapshot = curatedSchema.table(
  "query_snapshot",
  {
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    filters: jsonb("filters").default({}).notNull(),
    id: uuid("id").defaultRandom().primaryKey(),
    // bigint in the DB since 0007 so the legacy mirror of appliedSequence
    // never caps at 2^31; mode "number" keeps existing readers' JS type.
    indexVersion: bigint("index_version", { mode: "number" }),
    parserVersion: text("parser_version").notNull(),
    queryText: text("query_text").notNull(),
    resultIds: jsonb("result_ids").default([]).notNull(),
    savedSearchId: uuid("saved_search_id").references(() => savedSearch.id, {
      onDelete: "set null",
    }),
    schemaVersion: text("schema_version").notNull(),
    scopeId: text("scope_id").notNull(),
    searchAppliedSequence: bigint("search_applied_sequence", {
      mode: "bigint",
    }).notNull(),
    searchGeneration: integer("search_generation").notNull(),
    /** Search scope the selection was made under (RJC-383): 'active' or 'all'. */
    searchScope: text("search_scope").default("active").notNull(),
    userId: text("user_id").notNull(),
  },
  (table) => [
    index("query_snapshot_scope_id_idx").on(table.scopeId),
    index("query_snapshot_user_id_idx").on(table.userId),
    check(
      "query_snapshot_search_scope_check",
      sql`${table.searchScope} IN ('active', 'all')`
    ),
    check(
      "query_snapshot_search_generation_check",
      sql`${table.searchGeneration} >= 1`
    ),
    check(
      "query_snapshot_search_applied_sequence_check",
      sql`${table.searchAppliedSequence} >= 0`
    ),
    check(
      "query_snapshot_scope_id_check",
      sql`length(trim(${table.scopeId})) > 0`
    ),
  ]
);

export const auditEvent = curatedSchema.table(
  "audit_event",
  {
    action: text("action").notNull(),
    actorId: text("actor_id"),
    actorType: text("actor_type").default("system").notNull(),
    auditClass: text("audit_class").default("none").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    entityId: text("entity_id").notNull(),
    entityType: text("entity_type").notNull(),
    id: uuid("id").defaultRandom().primaryKey(),
    metadata: jsonb("metadata").default({}).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    scopeId: text("scope_id").notNull(),
  },
  (table) => [
    index("audit_event_scope_actor_idx").on(table.scopeId, table.actorId),
    index("audit_event_entity_idx").on(table.entityType, table.entityId),
    index("audit_event_occurred_at_idx").on(table.occurredAt),
    check(
      "audit_event_actor_type_check",
      sql`${table.actorType} IN ('user', 'agent', 'service', 'system')`
    ),
    check(
      "audit_event_audit_class_check",
      sql`${table.auditClass} IN ('access', 'effect', 'none')`
    ),
    check(
      "audit_event_scope_id_check",
      sql`length(trim(${table.scopeId})) > 0`
    ),
  ]
);

/**
 * Search outbox (RJC-389). Rows are claimed per row (`claimed_until` lease,
 * `FOR UPDATE SKIP LOCKED`), retried per row (`retry_count`, `last_error`)
 * and parked per row (`dead_lettered_at`); `processed_at` is the ack. The
 * projector's checkpoint is a pure watermark and never selects rows.
 */
export const outboxEvent = curatedSchema.table(
  "outbox_event",
  {
    aggregateId: uuid("aggregate_id").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    /** Fencing token of the drain holding the lease: every ack/blame/release is `WHERE claim_token = mine`. */
    claimToken: uuid("claim_token"),
    /** Lease held by the drain that claimed this row; expired leases are reclaimable. */
    claimedUntil: timestamp("claimed_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** Set once retry_count reaches the drain's maxAttempts; excluded from claims until requeued. */
    deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }),
    eventType: text("event_type").notNull(),
    id: uuid("id").defaultRandom().primaryKey(),
    // bigint since 0008: mirrors the bigint sequence_number (same class of
    // fix as query_snapshot.index_version in 0007); mode "number" keeps the
    // JS type of existing readers.
    indexVersion: bigint("index_version", { mode: "number" }),
    lastError: text("last_error"),
    payload: jsonb("payload").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    retryCount: integer("retry_count").default(0).notNull(),
    sequenceNumber: bigint("sequence_number", { mode: "bigint" })
      .notNull()
      .generatedAlwaysAsIdentity(),
  },
  (table) => [
    index("outbox_event_unprocessed_idx")
      .on(table.createdAt)
      .where(sql`${table.processedAt} IS NULL`),
    // Claim scan: unprocessed, not dead-lettered, lowest sequence first.
    index("outbox_event_claimable_idx")
      .on(table.sequenceNumber)
      .where(
        sql`${table.processedAt} IS NULL AND ${table.deadLetteredAt} IS NULL`
      ),
    // Claim-time aggregate serialisation: "does this aggregate have another
    // open row under a live claim?"
    index("outbox_event_aggregate_open_idx")
      .on(table.aggregateId)
      .where(sql`${table.processedAt} IS NULL`),
    uniqueIndex("outbox_event_sequence_number_uidx").on(table.sequenceNumber),
    // 0031: the prune's `processed_at < cutoff` range scan (was a full seq scan per tick).
    index("outbox_event_processed_at_idx")
      .on(table.processedAt)
      .where(sql`${table.processedAt} IS NOT NULL`),
    check("outbox_event_retry_count_check", sql`${table.retryCount} >= 0`),
  ]
);

/**
 * Last search projection applied per aggregate (RJC-389): the hash of the
 * search-relevant fields (see projectionHash in @ji/search) plus the
 * generation it was written under. The drain skips the Manticore write when
 * the hash is unchanged within the same generation, so curated edits that do
 * not touch indexed fields never reindex. A new generation (rebuild) starts
 * with an empty index, hence the generation guard rather than a table wipe.
 */
export const searchProjectionState = curatedSchema.table(
  "search_projection_state",
  {
    aggregateId: uuid("aggregate_id").primaryKey(),
    appliedSequence: bigint("applied_sequence", { mode: "bigint" }).notNull(),
    generation: integer("generation").notNull(),
    projectionHash: text("projection_hash").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  }
);

/**
 * Durable search projection checkpoint (RJC-384): one row per search index,
 * carrying the generation and the highest applied outbox sequence.
 */
export const searchProjectionCheckpoint = curatedSchema.table(
  "search_projection_checkpoint",
  {
    appliedSequence: bigint("applied_sequence", { mode: "bigint" }).notNull(),
    generation: integer("generation").notNull(),
    indexName: text("index_name").primaryKey(),
    schemaHash: text("schema_hash").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  }
);

/**
 * Live identity of the running projector, so a deploy can read back which
 * container and which release SHA is actually draining the index. The
 * projector has no HTTP surface of its own, so the database is the only
 * medium it and the API server already share. One row per index name: the
 * advisory-lock holder's self report, overwritten by whichever container
 * currently holds the lock.
 */
export const searchProjectorRuntime = curatedSchema.table(
  "search_projector_runtime",
  {
    containerId: text("container_id").notNull(),
    cycle: bigint("cycle", { mode: "number" }).notNull(),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull(),
    indexName: text("index_name").primaryKey(),
    releaseSha: text("release_sha"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  }
);

export const agentContext = curatedSchema.table(
  "agent_context",
  {
    context: jsonb("context").default({}).notNull(),
    entityId: text("entity_id").notNull(),
    entityType: text("entity_type").notNull(),
    id: uuid("id").defaultRandom().primaryKey(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("agent_context_entity_uidx").on(
      table.entityType,
      table.entityId
    ),
  ]
);

export const bronHealth = curatedSchema.table(
  "bron_health",
  {
    activeRunId: uuid("active_run_id").references(() => scrapeRun.id, {
      onDelete: "set null",
    }),
    bronId: uuid("bron_id")
      .primaryKey()
      .references(() => bron.id, { onDelete: "cascade" }),
    circuitStatus: text("circuit_status").default("closed").notNull(),
    lastCompletionOutcome: text("last_completion_outcome"),
    lastFullySuccessfulAt: timestamp("last_fully_successful_at", {
      withTimezone: true,
    }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastRunStatus: text("last_run_status"),
    phaseStartedAt: timestamp("phase_started_at", { withTimezone: true }),
    progressAt: timestamp("progress_at", { withTimezone: true }),
    progressPhase: text("progress_phase"),
    silenceAlertOpen: boolean("silence_alert_open").default(false).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    check(
      "bron_health_circuit_status_check",
      sql`length(trim(${table.circuitStatus})) > 0`
    ),
    check(
      "bron_health_progress_phase_check",
      sql`${table.progressPhase} IS NULL OR ${table.progressPhase} IN ('fetch', 'persist', 'curation')`
    ),
    check(
      "bron_health_completion_outcome_check",
      sql`${table.lastCompletionOutcome} IS NULL OR ${table.lastCompletionOutcome} IN ('complete', 'incomplete', 'backlogged', 'parked', 'failed', 'quarantined', 'unknown')`
    ),
  ]
);

/**
 * Singleton identity for the process that currently owns the poller
 * advisory lock. Claiming this row is deliberately separate from acquiring
 * that lock: the worker may call `claim` only after the lock handle says it
 * acquired the session lock.
 */
export const pollerRuntime = curatedSchema.table(
  "poller_runtime",
  {
    advisoryLockMaxAgeMs: bigint("advisory_lock_max_age_ms", {
      mode: "number",
    }),
    component: text("component").primaryKey().default("poller"),
    curationBudgetMs: bigint("curation_budget_ms", { mode: "number" }),
    fenceToken: bigint("fence_token", { mode: "number" }).notNull(),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull(),
    heartbeatMaxAgeMs: bigint("heartbeat_max_age_ms", { mode: "number" }),
    instanceId: text("instance_id").notNull(),
    lastLockCheckAt: timestamp("last_lock_check_at", {
      withTimezone: true,
    }).notNull(),
    ownerToken: uuid("owner_token").notNull(),
    releaseSha: text("release_sha"),
    runBudgetMs: bigint("run_budget_ms", { mode: "number" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    status: text("status").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check(
      "poller_runtime_advisory_lock_max_age_ms_check",
      sql`${table.advisoryLockMaxAgeMs} IS NULL OR (${table.advisoryLockMaxAgeMs} > 0 AND ${table.advisoryLockMaxAgeMs} <= 9007199254740991)`
    ),
    check(
      "poller_runtime_curation_budget_ms_check",
      sql`${table.curationBudgetMs} IS NULL OR (${table.curationBudgetMs} > 0 AND ${table.curationBudgetMs} <= 9007199254740991)`
    ),
    check(
      "poller_runtime_heartbeat_max_age_ms_check",
      sql`${table.heartbeatMaxAgeMs} IS NULL OR (${table.heartbeatMaxAgeMs} > 0 AND ${table.heartbeatMaxAgeMs} <= 9007199254740991)`
    ),
    check(
      "poller_runtime_run_budget_ms_check",
      sql`${table.runBudgetMs} IS NULL OR (${table.runBudgetMs} > 0 AND ${table.runBudgetMs} <= 9007199254740991)`
    ),

    check("poller_runtime_component_check", sql`${table.component} = 'poller'`),
    check(
      "poller_runtime_fence_token_check",
      sql`${table.fenceToken} > 0 AND ${table.fenceToken} <= 9007199254740991`
    ),
    check(
      "poller_runtime_status_check",
      sql`${table.status} IN ('running', 'lock_lost', 'stopped')`
    ),
    check(
      "poller_runtime_instance_id_check",
      sql`length(trim(${table.instanceId})) > 0`
    ),
  ]
);

/**
 * Durable bron-ingest jobs (CTP-622): the SQL backing table for the worker's
 * `PersistedQueue`. `id` is the stable job identity (the run's scrapeRunId);
 * `completed` is the ack. A claimed row keeps `acquired_by`/`acquired_at` as
 * its lease — a crashed worker's claim goes stale and is re-claimed, while
 * `durable_job_open_bron_uidx` keeps a second offer of the same bron from
 * ever becoming a second domain run.
 */
export const durableJob = curatedSchema.table(
  "durable_job",
  {
    acquiredAt: timestamp("acquired_at", { withTimezone: true }),
    acquiredBy: uuid("acquired_by"),
    attempts: integer("attempts").default(0).notNull(),
    completed: boolean("completed").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    element: jsonb("element").notNull(),
    id: text("id").notNull(),
    lastFailure: text("last_failure"),
    queueName: text("queue_name").notNull(),
    sequence: bigint("sequence", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("durable_job_id_queue_uidx").on(table.id, table.queueName),
    index("durable_job_take_idx").on(
      table.queueName,
      table.completed,
      table.attempts,
      table.acquiredAt
    ),
    uniqueIndex("durable_job_open_bron_uidx")
      .on(table.queueName, sql`("element" ->> 'bronId')`)
      .where(sql`${table.completed} = false`),
    index("durable_job_acquired_idx").on(table.acquiredBy, table.acquiredAt),
    check("durable_job_attempts_check", sql`${table.attempts} >= 0`),
    check("durable_job_id_nonempty_check", sql`length(btrim(${table.id})) > 0`),
    check(
      "durable_job_queue_name_nonempty_check",
      sql`length(btrim(${table.queueName})) > 0`
    ),
  ]
);

export const alert = curatedSchema.table(
  "alert",
  {
    ackedAt: timestamp("acked_at", { withTimezone: true }),
    ackedBy: text("acked_by"),
    bronId: uuid("bron_id")
      .notNull()
      .references(() => bron.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    evidence: jsonb("evidence").default({}).notNull(),
    id: uuid("id").defaultRandom().primaryKey(),
    kind: text("kind").notNull(),
    message: text("message").notNull(),
  },
  (table) => [
    index("alert_bron_id_idx").on(table.bronId),
    index("alert_dedupe_key_idx").on(table.dedupeKey),
    index("alert_open_idx")
      .on(table.dedupeKey)
      .where(sql`${table.ackedAt} IS NULL`),
    check("alert_dedupe_key_check", sql`length(trim(${table.dedupeKey})) > 0`),
    check("alert_kind_check", sql`length(trim(${table.kind})) > 0`),
    check("alert_message_check", sql`length(trim(${table.message})) > 0`),
    check(
      "alert_acked_consistency_check",
      sql`(${table.ackedAt} IS NULL AND ${table.ackedBy} IS NULL) OR (${table.ackedAt} IS NOT NULL AND ${table.ackedBy} IS NOT NULL)`
    ),
  ]
);

export const bronHealthRelations = relations(bronHealth, ({ one }) => ({
  bron: one(bron, {
    fields: [bronHealth.bronId],
    references: [bron.id],
  }),
}));

export const alertRelations = relations(alert, ({ one }) => ({
  bron: one(bron, {
    fields: [alert.bronId],
    references: [bron.id],
  }),
}));

export const bronRelations = relations(bron, ({ many, one }) => ({
  aanvragen: many(aanvraag),
  alerts: many(alert),
  health: one(bronHealth, {
    fields: [bron.id],
    references: [bronHealth.bronId],
  }),
  scrapeRuns: many(scrapeRun),
}));

export const scrapeRunRelations = relations(scrapeRun, ({ one, many }) => ({
  aanvragen: many(aanvraag),
  bron: one(bron, {
    fields: [scrapeRun.bronId],
    references: [bron.id],
  }),
  versies: many(aanvraagVersie),
}));

export const dedupGroepRelations = relations(dedupGroep, ({ many }) => ({
  aanvragen: many(aanvraag),
}));

export const aanvraagRelations = relations(aanvraag, ({ one, many }) => ({
  bron: one(bron, {
    fields: [aanvraag.bronId],
    references: [bron.id],
  }),
  bronLinks: many(aanvraagBronLink),
  dedupGroep: one(dedupGroep, {
    fields: [aanvraag.dedupGroepId],
    references: [dedupGroep.id],
  }),
  enrichments: many(aanvraagEnrichment),
  scrapeRun: one(scrapeRun, {
    fields: [aanvraag.scrapeRunId],
    references: [scrapeRun.id],
  }),
  versies: many(aanvraagVersie),
}));

export const aanvraagVersieRelations = relations(aanvraagVersie, ({ one }) => ({
  aanvraag: one(aanvraag, {
    fields: [aanvraagVersie.aanvraagId],
    references: [aanvraag.id],
  }),
  scrapeRun: one(scrapeRun, {
    fields: [aanvraagVersie.scrapeRunId],
    references: [scrapeRun.id],
  }),
}));

export const aanvraagBronLinkRelations = relations(
  aanvraagBronLink,
  ({ one }) => ({
    aanvraag: one(aanvraag, {
      fields: [aanvraagBronLink.aanvraagId],
      references: [aanvraag.id],
    }),
    bron: one(bron, {
      fields: [aanvraagBronLink.bronId],
      references: [bron.id],
    }),
  })
);

export const savedSearchRelations = relations(savedSearch, ({ many }) => ({
  snapshots: many(querySnapshot),
}));

export const aanvraagMarkeringRelations = relations(
  aanvraagMarkering,
  ({ one }) => ({
    aanvraag: one(aanvraag, {
      fields: [aanvraagMarkering.aanvraagId],
      references: [aanvraag.id],
    }),
  })
);

export const aanvraagEnrichmentRelations = relations(
  aanvraagEnrichment,
  ({ one }) => ({
    aanvraag: one(aanvraag, {
      fields: [aanvraagEnrichment.aanvraagId],
      references: [aanvraag.id],
    }),
  })
);

export const approvalRecord = curatedSchema.table(
  "approval_record",
  {
    actorId: text("actor_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    id: uuid("id").defaultRandom().primaryKey(),
    motivatie: text("motivatie").notNull(),
    resultIds: jsonb("result_ids").default([]).notNull(),
    scopeId: text("scope_id").notNull(),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => querySnapshot.id, { onDelete: "restrict" }),
  },
  (table) => [
    index("approval_record_scope_snapshot_idx").on(
      table.scopeId,
      table.snapshotId
    ),
    index("approval_record_snapshot_id_idx").on(table.snapshotId),
    uniqueIndex("approval_record_snapshot_uidx").on(table.snapshotId),
    check(
      "approval_record_motivatie_check",
      sql`length(trim(${table.motivatie})) > 0`
    ),
    check(
      "approval_record_expires_after_created_check",
      sql`${table.expiresAt} > ${table.createdAt}`
    ),
    check(
      "approval_record_scope_id_check",
      sql`length(trim(${table.scopeId})) > 0`
    ),
  ]
);

export const querySnapshotRelations = relations(
  querySnapshot,
  ({ one, many }) => ({
    approvals: many(approvalRecord),
    savedSearch: one(savedSearch, {
      fields: [querySnapshot.savedSearchId],
      references: [savedSearch.id],
    }),
  })
);

export const approvalRecordRelations = relations(approvalRecord, ({ one }) => ({
  snapshot: one(querySnapshot, {
    fields: [approvalRecord.snapshotId],
    references: [querySnapshot.id],
  }),
}));

export const externalIdCrosswalk = curatedSchema.table(
  "external_id_crosswalk",
  {
    actionType: text("action_type").notNull(),
    canonicalVacancyId: uuid("canonical_vacancy_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    externalId: text("external_id").notNull(),
    id: uuid("id").defaultRandom().primaryKey(),
    scopeId: text("scope_id").notNull(),
    target: text("target").notNull(),
  },
  (table) => [
    uniqueIndex("external_id_crosswalk_idempotency_uidx").on(
      table.scopeId,
      table.target,
      table.canonicalVacancyId,
      table.actionType
    ),
    check(
      "external_id_crosswalk_action_type_check",
      sql`${table.actionType} IN ('create')`
    ),
    check(
      "external_id_crosswalk_target_check",
      sql`${table.target} IN ('spott')`
    ),
    check(
      "external_id_crosswalk_external_id_check",
      sql`length(trim(${table.externalId})) > 0`
    ),
    check(
      "external_id_crosswalk_scope_id_check",
      sql`length(trim(${table.scopeId})) > 0`
    ),
  ]
);

export const exportEffect = curatedSchema.table(
  "export_effect",
  {
    actionType: text("action_type").notNull(),
    canonicalVacancyId: uuid("canonical_vacancy_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    externalId: text("external_id"),
    externalIdSource: text("external_id_source"),
    id: uuid("id").defaultRandom().primaryKey(),
    scopeId: text("scope_id").notNull(),
    status: text("status").default("reserved").notNull(),
    target: text("target").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("export_effect_key_uidx").on(
      table.scopeId,
      table.target,
      table.canonicalVacancyId,
      table.actionType
    ),
    check(
      "export_effect_action_type_check",
      sql`${table.actionType} IN ('create')`
    ),
    check("export_effect_target_check", sql`${table.target} IN ('spott')`),
    check(
      "export_effect_status_check",
      sql`${table.status} IN ('reserved', 'external_id_acquired', 'confirmed')`
    ),
    check(
      "export_effect_external_id_source_check",
      sql`${table.externalIdSource} IS NULL OR ${table.externalIdSource} IN ('provider_response', 'manual_evidence')`
    ),
    check(
      "export_effect_evidence_check",
      sql`(
        ${table.status} = 'reserved'
        AND ${table.externalId} IS NULL
        AND ${table.externalIdSource} IS NULL
      ) OR (
        ${table.status} IN ('external_id_acquired', 'confirmed')
        AND ${table.externalId} IS NOT NULL
        AND length(trim(${table.externalId})) > 0
        AND ${table.externalIdSource} IS NOT NULL
      )`
    ),
    check(
      "export_effect_scope_id_check",
      sql`length(trim(${table.scopeId})) > 0`
    ),
  ]
);

export const exportAttempt = curatedSchema.table(
  "export_attempt",
  {
    actionType: text("action_type").notNull(),
    approvalId: uuid("approval_id")
      .notNull()
      .references(() => approvalRecord.id, { onDelete: "restrict" }),
    canonicalVacancyId: uuid("canonical_vacancy_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    errorMessage: text("error_message"),
    externalId: text("external_id"),
    id: uuid("id").defaultRandom().primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(),
    scopeId: text("scope_id").notNull(),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => querySnapshot.id, { onDelete: "restrict" }),
    status: text("status").notNull(),
    target: text("target").notNull(),
  },
  (table) => [
    index("export_attempt_snapshot_id_idx").on(table.snapshotId),
    index("export_attempt_idempotency_key_idx").on(table.idempotencyKey),
    check(
      "export_attempt_status_check",
      sql`${table.status} IN ('created', 'skipped', 'failed')`
    ),
    check(
      "export_attempt_action_type_check",
      sql`${table.actionType} IN ('create')`
    ),
    check("export_attempt_target_check", sql`${table.target} IN ('spott')`),
    check(
      "export_attempt_scope_id_check",
      sql`length(trim(${table.scopeId})) > 0`
    ),
  ]
);

export const externalReceipt = curatedSchema.table(
  "external_receipt",
  {
    canonicalVacancyId: uuid("canonical_vacancy_id").notNull(),
    confirmedEffect: boolean("confirmed_effect").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    exportAttemptId: uuid("export_attempt_id")
      .notNull()
      .references(() => exportAttempt.id, { onDelete: "restrict" }),
    id: uuid("id").defaultRandom().primaryKey(),
    responseHash: text("response_hash").notNull(),
    scopeId: text("scope_id").notNull(),
    spottVacancyId: text("spott_vacancy_id"),
  },
  (table) => [
    uniqueIndex("external_receipt_export_attempt_uidx").on(
      table.exportAttemptId
    ),
    index("external_receipt_canonical_vacancy_id_idx").on(
      table.canonicalVacancyId
    ),
    check(
      "external_receipt_response_hash_check",
      sql`length(trim(${table.responseHash})) > 0`
    ),
    check(
      "external_receipt_confirmed_spott_id_check",
      sql`(${table.confirmedEffect} = false) OR (${table.spottVacancyId} IS NOT NULL AND length(trim(${table.spottVacancyId})) > 0)`
    ),
    check(
      "external_receipt_scope_id_check",
      sql`length(trim(${table.scopeId})) > 0`
    ),
  ]
);
