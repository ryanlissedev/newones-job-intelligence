DROP INDEX "staging"."source_record_bron_content_hash_uidx";--> statement-breakpoint
ALTER TABLE "curated"."bron" ALTER COLUMN "ingestie_type" SET DEFAULT 'json-api';--> statement-breakpoint
UPDATE "curated"."bron" SET "ingestie_type" = 'json-api' WHERE "ingestie_type" IS NULL;--> statement-breakpoint
ALTER TABLE "curated"."bron" ALTER COLUMN "ingestie_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "curated"."bron" ADD COLUMN "crawl_delay_ms" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "curated"."bron" ADD COLUMN "interval" text;--> statement-breakpoint
UPDATE "curated"."bron"
SET "interval" = COALESCE(NULLIF(BTRIM("schedule"), ''), '0 * * * *');--> statement-breakpoint
ALTER TABLE "curated"."bron" ALTER COLUMN "interval" SET DEFAULT '0 * * * *';--> statement-breakpoint
ALTER TABLE "curated"."bron" ALTER COLUMN "interval" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "curated"."bron" ADD COLUMN "mapping_ref" text;--> statement-breakpoint
UPDATE "curated"."bron"
SET "mapping_ref" = "config_ref"
WHERE NULLIF(BTRIM("config_ref"), '') IS NOT NULL;--> statement-breakpoint
ALTER TABLE "curated"."bron" ADD COLUMN "rate_limit_per_minute" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "curated"."bron" ADD COLUMN "retention_days" integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE "curated"."scrape_run" ADD COLUMN "checkpoint" jsonb;--> statement-breakpoint
ALTER TABLE "curated"."scrape_run" ADD COLUMN "rejected" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "curated"."scrape_run" ADD COLUMN "run_kind" text DEFAULT 'poll' NOT NULL;--> statement-breakpoint
ALTER TABLE "curated"."scrape_run" ADD COLUMN "failure_class" text;--> statement-breakpoint
ALTER TABLE "curated"."scrape_run" ADD COLUMN "failure_code" text;--> statement-breakpoint
ALTER TABLE "curated"."scrape_run" ADD COLUMN "failure_message" text;--> statement-breakpoint
ALTER TABLE "curated"."scrape_run" ADD COLUMN "failure_phase" text;--> statement-breakpoint
ALTER TABLE "curated"."scrape_run" ADD COLUMN "fence_token" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "staging"."aanvraag_observation" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "staging"."aanvraag_observation" ADD COLUMN "outcome" text;--> statement-breakpoint
UPDATE "staging"."aanvraag_observation" AS observation
SET
  "content_hash" = NULLIF(BTRIM(observation."payload"->>'contentHash'), '');--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "staging"."aanvraag_observation"
    WHERE "content_hash" IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot migrate aanvraag observations without an immutable payload contentHash';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "staging"."aanvraag_observation"
    WHERE NULLIF(BTRIM("payload"->>'observedAt'), '') IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot migrate aanvraag observations without an immutable payload observedAt';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "staging"."aanvraag_observation"
    GROUP BY "scrape_run_id", "source_record_id", "content_hash"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot migrate duplicate aanvraag observation replay keys';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "staging"."aanvraag_observation"
    GROUP BY "source_record_id", ("payload"->>'observedAt')::timestamptz
    HAVING COUNT(DISTINCT "content_hash") > 1
  ) THEN
    RAISE EXCEPTION 'Cannot migrate ambiguous aanvraag observation ordering at equal observedAt';
  END IF;
END $$;--> statement-breakpoint
WITH ordered_observations AS (
  SELECT
    "id",
    LAG("content_hash") OVER (
      PARTITION BY "source_record_id"
      ORDER BY ("payload"->>'observedAt')::timestamptz
    ) AS previous_content_hash
  FROM "staging"."aanvraag_observation"
)
UPDATE "staging"."aanvraag_observation" AS observation
SET "outcome" = CASE
  WHEN ordered.previous_content_hash IS NULL THEN 'new'
  WHEN observation."content_hash" = ordered.previous_content_hash THEN 'unchanged'
  ELSE 'changed'
END
FROM ordered_observations AS ordered
WHERE observation."id" = ordered."id";--> statement-breakpoint
ALTER TABLE "staging"."aanvraag_observation" ALTER COLUMN "content_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "staging"."aanvraag_observation" ALTER COLUMN "outcome" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "aanvraag_observation_replay_uidx" ON "staging"."aanvraag_observation" USING btree ("scrape_run_id","source_record_id","content_hash");--> statement-breakpoint
ALTER TABLE "curated"."bron" ADD CONSTRAINT "bron_status_check" CHECK ("curated"."bron"."status" IN ('ready', 'blocked', 'deferred'));--> statement-breakpoint
ALTER TABLE "curated"."bron" ADD CONSTRAINT "bron_voorwaarden_status_check" CHECK ("curated"."bron"."voorwaarden_status" IN ('toegestaan', 'verboden', 'te_toetsen'));--> statement-breakpoint
ALTER TABLE "curated"."bron" ADD CONSTRAINT "bron_rate_limit_check" CHECK ("curated"."bron"."rate_limit_per_minute" > 0);--> statement-breakpoint
ALTER TABLE "curated"."bron" ADD CONSTRAINT "bron_crawl_delay_check" CHECK ("curated"."bron"."crawl_delay_ms" >= 0);--> statement-breakpoint
ALTER TABLE "curated"."bron" ADD CONSTRAINT "bron_retention_days_check" CHECK ("curated"."bron"."retention_days" > 0);--> statement-breakpoint
ALTER TABLE "curated"."bron" ADD CONSTRAINT "bron_secret_ref_check" CHECK ("curated"."bron"."secret_ref" IS NULL OR "curated"."bron"."secret_ref" ~ '^(op|vault|trigger)://[^[:space:]/]+(/[^[:space:]]*)?$');--> statement-breakpoint
UPDATE "curated"."bron"
SET "status" = 'blocked', "actief" = false
WHERE "status" = 'ready' AND "voorwaarden_status" <> 'toegestaan';--> statement-breakpoint
ALTER TABLE "curated"."bron" ADD CONSTRAINT "bron_ready_policy_check" CHECK ("curated"."bron"."status" <> 'ready' OR "curated"."bron"."voorwaarden_status" = 'toegestaan');--> statement-breakpoint
UPDATE "curated"."bron"
SET "actief" = false
WHERE "actief" = true
  AND ("status" <> 'ready' OR "voorwaarden_status" <> 'toegestaan');--> statement-breakpoint
ALTER TABLE "curated"."bron" ADD CONSTRAINT "bron_active_policy_check" CHECK ("curated"."bron"."actief" = false OR ("curated"."bron"."status" = 'ready' AND "curated"."bron"."voorwaarden_status" = 'toegestaan'));--> statement-breakpoint
ALTER TABLE "curated"."scrape_run" ADD CONSTRAINT "scrape_run_status_check" CHECK ("curated"."scrape_run"."status" IN ('running', 'succeeded', 'failed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "curated"."scrape_run" ADD CONSTRAINT "scrape_run_kind_check" CHECK ("curated"."scrape_run"."run_kind" IN ('test', 'poll'));--> statement-breakpoint
ALTER TABLE "curated"."scrape_run" ADD CONSTRAINT "scrape_run_metrics_nonnegative_check" CHECK ("curated"."scrape_run"."aantal_gevonden" >= 0 AND "curated"."scrape_run"."nieuw" >= 0 AND "curated"."scrape_run"."gewijzigd" >= 0 AND "curated"."scrape_run"."rejected" >= 0 AND "curated"."scrape_run"."gesloten" >= 0 AND "curated"."scrape_run"."fouten" >= 0);--> statement-breakpoint
UPDATE "curated"."scrape_run"
SET "geindigd" = COALESCE("gestart", "created_at", NOW())
WHERE "status" <> 'running' AND "geindigd" IS NULL;--> statement-breakpoint
ALTER TABLE "curated"."scrape_run" ADD CONSTRAINT "scrape_run_completion_check" CHECK (("curated"."scrape_run"."status" = 'running' AND "curated"."scrape_run"."geindigd" IS NULL) OR ("curated"."scrape_run"."status" <> 'running' AND "curated"."scrape_run"."geindigd" IS NOT NULL));--> statement-breakpoint
UPDATE "curated"."scrape_run"
SET
  "failure_phase" = 'unknown',
  "failure_class" = 'internal',
  "failure_code" = 'LEGACY_FAILURE',
  "failure_message" = 'Legacy run failed' || chr(59) || ' details unavailable'
WHERE "status" = 'failed';--> statement-breakpoint
ALTER TABLE "curated"."scrape_run" ADD CONSTRAINT "scrape_run_fence_token_check" CHECK ("curated"."scrape_run"."fence_token" >= 0 AND "curated"."scrape_run"."fence_token" <= 9007199254740991);--> statement-breakpoint
ALTER TABLE "curated"."scrape_run" ADD CONSTRAINT "scrape_run_failure_envelope_check" CHECK ((
  "curated"."scrape_run"."status" = 'failed'
  AND "curated"."scrape_run"."failure_phase" IS NOT NULL
  AND "curated"."scrape_run"."failure_class" IS NOT NULL
  AND "curated"."scrape_run"."failure_code" IS NOT NULL
  AND "curated"."scrape_run"."failure_message" IS NOT NULL
) OR (
  "curated"."scrape_run"."status" <> 'failed'
  AND "curated"."scrape_run"."failure_phase" IS NULL
  AND "curated"."scrape_run"."failure_class" IS NULL
  AND "curated"."scrape_run"."failure_code" IS NULL
  AND "curated"."scrape_run"."failure_message" IS NULL
));--> statement-breakpoint
ALTER TABLE "curated"."scrape_run" ADD CONSTRAINT "scrape_run_failure_tuple_check" CHECK (("curated"."scrape_run"."failure_phase", "curated"."scrape_run"."failure_class", "curated"."scrape_run"."failure_code", "curated"."scrape_run"."failure_message") IN (
  ('discover', 'connector', 'DISCOVER_FAILED', 'Connector discovery failed'),
  ('fetch', 'connector', 'FETCH_FAILED', 'Connector fetch failed'),
  ('raw-store', 'storage', 'RAW_STORE_WRITE_FAILED', 'Raw object persistence failed'),
  ('observation', 'persistence', 'OBSERVATION_WRITE_FAILED', 'Observation persistence failed'),
  ('checkpoint', 'persistence', 'CHECKPOINT_WRITE_FAILED', 'Run checkpoint persistence failed'),
  ('complete', 'persistence', 'COMPLETE_WRITE_FAILED', 'Run completion persistence failed'),
  ('unknown', 'internal', 'UNEXPECTED_FAILURE', 'Connector run failed'),
  ('unknown', 'internal', 'LEGACY_FAILURE', 'Legacy run failed' || chr(59) || ' details unavailable')
) OR (
  "curated"."scrape_run"."failure_phase" IS NULL
  AND "curated"."scrape_run"."failure_class" IS NULL
  AND "curated"."scrape_run"."failure_code" IS NULL
  AND "curated"."scrape_run"."failure_message" IS NULL
));--> statement-breakpoint
ALTER TABLE "staging"."aanvraag_observation" ADD CONSTRAINT "aanvraag_observation_outcome_check" CHECK ("staging"."aanvraag_observation"."outcome" IN ('new', 'changed', 'unchanged'));
