CREATE TABLE "curated"."approval_record" (
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"motivatie" text NOT NULL,
	"result_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"snapshot_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "curated"."approval_record" ADD CONSTRAINT "approval_record_snapshot_id_query_snapshot_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "curated"."query_snapshot"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_record_snapshot_id_idx" ON "curated"."approval_record" USING btree ("snapshot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_record_snapshot_uidx" ON "curated"."approval_record" USING btree ("snapshot_id");--> statement-breakpoint
ALTER TABLE "curated"."approval_record" ADD CONSTRAINT "approval_record_motivatie_check" CHECK (length(trim("motivatie")) > 0);--> statement-breakpoint
ALTER TABLE "curated"."approval_record" ADD CONSTRAINT "approval_record_expires_after_created_check" CHECK ("expires_at" > "created_at");
