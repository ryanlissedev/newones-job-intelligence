CREATE TABLE "curated"."durable_job" (
  "sequence" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "id" text NOT NULL,
  "queue_name" text NOT NULL,
  "element" jsonb NOT NULL,
  "completed" boolean NOT NULL DEFAULT false,
  "attempts" integer NOT NULL DEFAULT 0,
  "last_failure" text,
  "acquired_at" timestamptz,
  "acquired_by" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "durable_job_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "durable_job_id_nonempty_check" CHECK (length(btrim("id")) > 0),
  CONSTRAINT "durable_job_queue_name_nonempty_check" CHECK (length(btrim("queue_name")) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "durable_job_id_queue_uidx"
  ON "curated"."durable_job" ("id", "queue_name");
--> statement-breakpoint
CREATE INDEX "durable_job_take_idx"
  ON "curated"."durable_job" ("queue_name", "completed", "attempts", "acquired_at");
--> statement-breakpoint
-- Business idempotency, not dedup retention: at most one OPEN job per
-- (queue_name, bronId), so re-offering a bron while its job is queued or in
-- flight is a no-op instead of a second domain run. Elements without a bronId
-- key get NULL here and never conflict.
CREATE UNIQUE INDEX "durable_job_open_bron_uidx"
  ON "curated"."durable_job" ("queue_name", (("element" ->> 'bronId')))
  WHERE "completed" = false;
--> statement-breakpoint
CREATE INDEX "durable_job_acquired_idx"
  ON "curated"."durable_job" ("acquired_by", "acquired_at");
