import { relations, sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { bron, scrapeRun } from "./curated";
import { stagingSchema } from "./schemas";

export const sourceRecord = stagingSchema.table(
  "source_record",
  {
    bronId: uuid("bron_id")
      .notNull()
      .references(() => bron.id, { onDelete: "cascade" }),
    bronReferentie: text("bron_referentie").notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    id: uuid("id").defaultRandom().primaryKey(),
    /** Run that last bumped `missed_polls` (RJC-397): the same run never bumps a row twice. */
    lastMissedScrapeRunId: uuid("last_missed_scrape_run_id").references(
      () => scrapeRun.id,
      { onDelete: "set null" }
    ),
    /** Last complete listing run this record was seen in (RJC-397); null for rows older than 0009. */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    lastSeenScrapeRunId: uuid("last_seen_scrape_run_id").references(
      () => scrapeRun.id,
      { onDelete: "set null" }
    ),
    /**
     * Listing-tier hash from the discover pass (RJC-357), updated on every
     * observation. NULL (rows older than 0012, or never observed since)
     * means "no listing hash known" and must never allow a fetch skip.
     * Distinct from `content_hash`, which hashes the fetched payload.
     */
    listingHash: text("listing_hash"),
    /**
     * Consecutive complete listing runs of this bron that did not show the
     * record (RJC-397). Saturates at the stale threshold + 1 (one retry for
     * an interrupted stale write); `last_seen_at` carries the age past that
     * point. Reset to 0 on every observation.
     */
    missedPolls: integer("missed_polls").default(0).notNull(),
    rawPayloadRef: text("raw_payload_ref").notNull(),
    scrapeRunId: uuid("scrape_run_id")
      .notNull()
      .references(() => scrapeRun.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("source_record_bron_referentie_uidx").on(
      table.bronId,
      table.bronReferentie
    ),
    index("source_record_scrape_run_id_idx").on(table.scrapeRunId),
    check("source_record_missed_polls_check", sql`${table.missedPolls} >= 0`),
  ]
);

/**
 * When a run last processed each listed reference of a bron (0032): fetched,
 * skipped on a known listing hash, or rejected. Orders the next run's
 * fetches never-seen first, then oldest, so a budget-cut crawl resumes where
 * it stopped. Separate from `source_record` because rejects have no record.
 */
export const sourceFetchHistory = stagingSchema.table(
  "source_fetch_history",
  {
    bronId: uuid("bron_id")
      .notNull()
      .references(() => bron.id, { onDelete: "cascade" }),
    bronReferentie: text("bron_referentie").notNull(),
    lastFetchedAt: timestamp("last_fetched_at", {
      withTimezone: true,
    }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.bronId, table.bronReferentie],
      name: "source_fetch_history_pkey",
    }),
  ]
);

export const aanvraagObservation = stagingSchema.table(
  "aanvraag_observation",
  {
    bronId: uuid("bron_id")
      .notNull()
      .references(() => bron.id, { onDelete: "cascade" }),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    id: uuid("id").defaultRandom().primaryKey(),
    outcome: text("outcome").notNull(),
    parserVersion: text("parser_version"),
    payload: jsonb("payload").notNull(),
    scrapeRunId: uuid("scrape_run_id")
      .notNull()
      .references(() => scrapeRun.id, { onDelete: "cascade" }),
    sourceRecordId: uuid("source_record_id")
      .notNull()
      .references(() => sourceRecord.id, { onDelete: "cascade" }),
    status: text("status").default("pending").notNull(),
  },
  (table) => [
    uniqueIndex("aanvraag_observation_replay_uidx").on(
      table.scrapeRunId,
      table.sourceRecordId,
      table.contentHash
    ),
    index("aanvraag_observation_source_record_id_idx").on(table.sourceRecordId),
    index("aanvraag_observation_status_idx").on(table.status),
    // 0031: curation backlog per bron and status, oldest first.
    index("aanvraag_observation_bron_status_created_idx").on(
      table.bronId,
      table.status,
      table.createdAt
    ),
    // 0035: dominated sweep sibling probe (same source record, same content).
    index("aanvraag_observation_source_record_hash_idx").on(
      table.sourceRecordId,
      table.contentHash
    ),
    check(
      "aanvraag_observation_outcome_check",
      sql`${table.outcome} IN ('new', 'changed', 'unchanged')`
    ),
  ]
);

export const sourceRecordRelations = relations(
  sourceRecord,
  ({ one, many }) => ({
    aanvraagObservations: many(aanvraagObservation),
    bron: one(bron, {
      fields: [sourceRecord.bronId],
      references: [bron.id],
    }),
    scrapeRun: one(scrapeRun, {
      fields: [sourceRecord.scrapeRunId],
      references: [scrapeRun.id],
    }),
  })
);

export const aanvraagObservationRelations = relations(
  aanvraagObservation,
  ({ one }) => ({
    bron: one(bron, {
      fields: [aanvraagObservation.bronId],
      references: [bron.id],
    }),
    scrapeRun: one(scrapeRun, {
      fields: [aanvraagObservation.scrapeRunId],
      references: [scrapeRun.id],
    }),
    sourceRecord: one(sourceRecord, {
      fields: [aanvraagObservation.sourceRecordId],
      references: [sourceRecord.id],
    }),
  })
);
