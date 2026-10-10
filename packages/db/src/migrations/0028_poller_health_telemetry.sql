ALTER TABLE "curated"."bron_health"
  ADD COLUMN "active_run_id" uuid,
  ADD COLUMN "last_completion_outcome" text,
  ADD COLUMN "last_fully_successful_at" timestamptz,
  ADD COLUMN "progress_at" timestamptz,
  ADD COLUMN "progress_phase" text,
  ADD COLUMN "phase_started_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "curated"."bron_health"
  ADD CONSTRAINT "bron_health_active_run_fk"
  FOREIGN KEY ("active_run_id") REFERENCES "curated"."scrape_run"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "curated"."bron_health"
  ADD CONSTRAINT "bron_health_progress_phase_check"
  CHECK ("progress_phase" IS NULL OR "progress_phase" IN ('fetch', 'persist', 'curation'));
--> statement-breakpoint
ALTER TABLE "curated"."bron_health"
  ADD CONSTRAINT "bron_health_completion_outcome_check"
  CHECK ("last_completion_outcome" IS NULL OR "last_completion_outcome" IN ('complete', 'incomplete', 'backlogged', 'parked', 'failed', 'quarantined', 'unknown'));
--> statement-breakpoint
CREATE TABLE "curated"."poller_runtime" (
  "advisory_lock_max_age_ms" bigint,
  "curation_budget_ms" bigint,
  "heartbeat_max_age_ms" bigint,
  "run_budget_ms" bigint,
  "component" text PRIMARY KEY DEFAULT 'poller',
  "fence_token" bigint NOT NULL,
  "heartbeat_at" timestamptz NOT NULL,
  "instance_id" text NOT NULL,
  "last_lock_check_at" timestamptz NOT NULL,
  "owner_token" uuid NOT NULL,
  "release_sha" text,
  "started_at" timestamptz NOT NULL,
  "status" text NOT NULL,
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "poller_runtime_advisory_lock_max_age_ms_check" CHECK ("advisory_lock_max_age_ms" IS NULL OR ("advisory_lock_max_age_ms" > 0 AND "advisory_lock_max_age_ms" <= 9007199254740991)),
  CONSTRAINT "poller_runtime_curation_budget_ms_check" CHECK ("curation_budget_ms" IS NULL OR ("curation_budget_ms" > 0 AND "curation_budget_ms" <= 9007199254740991)),
  CONSTRAINT "poller_runtime_heartbeat_max_age_ms_check" CHECK ("heartbeat_max_age_ms" IS NULL OR ("heartbeat_max_age_ms" > 0 AND "heartbeat_max_age_ms" <= 9007199254740991)),
  CONSTRAINT "poller_runtime_run_budget_ms_check" CHECK ("run_budget_ms" IS NULL OR ("run_budget_ms" > 0 AND "run_budget_ms" <= 9007199254740991)),
  CONSTRAINT "poller_runtime_component_check" CHECK ("component" = 'poller'),
  CONSTRAINT "poller_runtime_fence_token_check" CHECK ("fence_token" > 0 AND "fence_token" <= 9007199254740991),
  CONSTRAINT "poller_runtime_status_check" CHECK ("status" IN ('running', 'lock_lost', 'stopped')),
  CONSTRAINT "poller_runtime_instance_id_check" CHECK (length(trim("instance_id")) > 0)
);
