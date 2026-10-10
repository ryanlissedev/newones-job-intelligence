CREATE SCHEMA "curated";
--> statement-breakpoint
CREATE SCHEMA "marts";
--> statement-breakpoint
CREATE SCHEMA "staging";
--> statement-breakpoint
CREATE TABLE "account" (
	"access_token" text,
	"access_token_expires_at" timestamp,
	"account_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"id_token" text,
	"issuer" text NOT NULL,
	"password" text,
	"provider_id" text NOT NULL,
	"refresh_token" text,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"updated_at" timestamp NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"ip_address" text,
	"token" text NOT NULL,
	"updated_at" timestamp NOT NULL,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"created_at" timestamp DEFAULT now() NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"image" text,
	"name" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "curated"."aanvraag" (
	"beschrijving" text NOT NULL,
	"bron_id" uuid NOT NULL,
	"bron_referentie" text NOT NULL,
	"bron_specifiek" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"bron_url" text,
	"compleetheid_score" numeric,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dedup_groep_id" uuid,
	"eerste_gezien_op" timestamp with time zone NOT NULL,
	"extractie_methode" text NOT NULL,
	"functiegroep" text DEFAULT 'overig' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"laatst_gezien_op" timestamp with time zone NOT NULL,
	"locatie_land" text DEFAULT 'NL' NOT NULL,
	"raw_payload_ref" text NOT NULL,
	"scrape_run_id" uuid NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"taal" text DEFAULT 'nl' NOT NULL,
	"tarief_eenheid" text,
	"tarief_max" numeric,
	"tarief_min" numeric,
	"tarief_valuta" text DEFAULT 'EUR' NOT NULL,
	"titel" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"versie" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "curated"."aanvraag_bron_link" (
	"aanvraag_id" uuid NOT NULL,
	"bron_id" uuid NOT NULL,
	"bron_referentie" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "curated"."aanvraag_versie" (
	"aanvraag_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"geldig_tot" timestamp with time zone,
	"geldig_van" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"raw_payload_ref" text NOT NULL,
	"scrape_run_id" uuid NOT NULL,
	"snapshot" jsonb NOT NULL,
	"versie" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "curated"."agent_context" (
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"entity_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "curated"."audit_event" (
	"action" text NOT NULL,
	"actor_id" text,
	"actor_type" text DEFAULT 'system' NOT NULL,
	"audit_class" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"entity_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "curated"."bron" (
	"actief" boolean DEFAULT false NOT NULL,
	"categorie" text NOT NULL,
	"config_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ingestie_type" text,
	"login_vereist" boolean DEFAULT false NOT NULL,
	"naam" text NOT NULL,
	"schedule" text,
	"secret_ref" text,
	"status" text DEFAULT 'deferred' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voorwaarden_status" text DEFAULT 'te_toetsen' NOT NULL,
	"website" text
);
--> statement-breakpoint
CREATE TABLE "curated"."dedup_groep" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"handmatig_bevestigd" boolean DEFAULT false NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"methode" text,
	"primaire_aanvraag_id" uuid,
	"similariteit" numeric,
	"status" text DEFAULT 'reviewable' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "curated"."outbox_event" (
	"aggregate_id" uuid NOT NULL,
	"aggregate_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event_type" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"index_version" integer,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "curated"."query_snapshot" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"index_version" integer,
	"parser_version" text NOT NULL,
	"query_text" text NOT NULL,
	"result_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"saved_search_id" uuid,
	"schema_version" text NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "curated"."saved_search" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"naam" text NOT NULL,
	"parser_version" text NOT NULL,
	"query_text" text NOT NULL,
	"schema_version" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "curated"."scrape_run" (
	"aantal_gevonden" integer DEFAULT 0 NOT NULL,
	"bron_id" uuid NOT NULL,
	"circuit_status" text DEFAULT 'closed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fouten" integer DEFAULT 0 NOT NULL,
	"geindigd" timestamp with time zone,
	"gesloten" integer DEFAULT 0 NOT NULL,
	"gestart" timestamp with time zone DEFAULT now() NOT NULL,
	"gewijzigd" integer DEFAULT 0 NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nieuw" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"versie_adapter" text
);
--> statement-breakpoint
CREATE TABLE "staging"."aanvraag_observation" (
	"bron_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parser_version" text,
	"payload" jsonb NOT NULL,
	"scrape_run_id" uuid NOT NULL,
	"source_record_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staging"."source_record" (
	"bron_id" uuid NOT NULL,
	"bron_referentie" text NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"raw_payload_ref" text NOT NULL,
	"scrape_run_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curated"."aanvraag" ADD CONSTRAINT "aanvraag_bron_id_bron_id_fk" FOREIGN KEY ("bron_id") REFERENCES "curated"."bron"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curated"."aanvraag" ADD CONSTRAINT "aanvraag_dedup_groep_id_dedup_groep_id_fk" FOREIGN KEY ("dedup_groep_id") REFERENCES "curated"."dedup_groep"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curated"."aanvraag" ADD CONSTRAINT "aanvraag_scrape_run_id_scrape_run_id_fk" FOREIGN KEY ("scrape_run_id") REFERENCES "curated"."scrape_run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curated"."aanvraag_bron_link" ADD CONSTRAINT "aanvraag_bron_link_aanvraag_id_aanvraag_id_fk" FOREIGN KEY ("aanvraag_id") REFERENCES "curated"."aanvraag"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curated"."aanvraag_bron_link" ADD CONSTRAINT "aanvraag_bron_link_bron_id_bron_id_fk" FOREIGN KEY ("bron_id") REFERENCES "curated"."bron"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curated"."aanvraag_versie" ADD CONSTRAINT "aanvraag_versie_aanvraag_id_aanvraag_id_fk" FOREIGN KEY ("aanvraag_id") REFERENCES "curated"."aanvraag"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curated"."aanvraag_versie" ADD CONSTRAINT "aanvraag_versie_scrape_run_id_scrape_run_id_fk" FOREIGN KEY ("scrape_run_id") REFERENCES "curated"."scrape_run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curated"."query_snapshot" ADD CONSTRAINT "query_snapshot_saved_search_id_saved_search_id_fk" FOREIGN KEY ("saved_search_id") REFERENCES "curated"."saved_search"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "curated"."scrape_run" ADD CONSTRAINT "scrape_run_bron_id_bron_id_fk" FOREIGN KEY ("bron_id") REFERENCES "curated"."bron"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staging"."aanvraag_observation" ADD CONSTRAINT "aanvraag_observation_bron_id_bron_id_fk" FOREIGN KEY ("bron_id") REFERENCES "curated"."bron"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staging"."aanvraag_observation" ADD CONSTRAINT "aanvraag_observation_scrape_run_id_scrape_run_id_fk" FOREIGN KEY ("scrape_run_id") REFERENCES "curated"."scrape_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staging"."aanvraag_observation" ADD CONSTRAINT "aanvraag_observation_source_record_id_source_record_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "staging"."source_record"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staging"."source_record" ADD CONSTRAINT "source_record_bron_id_bron_id_fk" FOREIGN KEY ("bron_id") REFERENCES "curated"."bron"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staging"."source_record" ADD CONSTRAINT "source_record_scrape_run_id_scrape_run_id_fk" FOREIGN KEY ("scrape_run_id") REFERENCES "curated"."scrape_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON "account" USING btree ("issuer","account_id");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "aanvraag_bron_referentie_uidx" ON "curated"."aanvraag" USING btree ("bron_id","bron_referentie");--> statement-breakpoint
CREATE INDEX "aanvraag_dedup_groep_id_idx" ON "curated"."aanvraag" USING btree ("dedup_groep_id");--> statement-breakpoint
CREATE INDEX "aanvraag_status_idx" ON "curated"."aanvraag" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "aanvraag_bron_link_aanvraag_bron_uidx" ON "curated"."aanvraag_bron_link" USING btree ("aanvraag_id","bron_id");--> statement-breakpoint
CREATE UNIQUE INDEX "aanvraag_versie_aanvraag_versie_uidx" ON "curated"."aanvraag_versie" USING btree ("aanvraag_id","versie");--> statement-breakpoint
CREATE INDEX "aanvraag_versie_open_idx" ON "curated"."aanvraag_versie" USING btree ("aanvraag_id") WHERE "curated"."aanvraag_versie"."geldig_tot" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_context_entity_uidx" ON "curated"."agent_context" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_event_entity_idx" ON "curated"."audit_event" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_event_occurred_at_idx" ON "curated"."audit_event" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "bron_status_idx" ON "curated"."bron" USING btree ("status");--> statement-breakpoint
CREATE INDEX "bron_categorie_idx" ON "curated"."bron" USING btree ("categorie");--> statement-breakpoint
CREATE INDEX "dedup_groep_status_idx" ON "curated"."dedup_groep" USING btree ("status");--> statement-breakpoint
CREATE INDEX "outbox_event_unprocessed_idx" ON "curated"."outbox_event" USING btree ("created_at") WHERE "curated"."outbox_event"."processed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "query_snapshot_user_id_idx" ON "curated"."query_snapshot" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "saved_search_user_id_idx" ON "curated"."saved_search" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "scrape_run_bron_id_idx" ON "curated"."scrape_run" USING btree ("bron_id");--> statement-breakpoint
CREATE INDEX "scrape_run_gestart_idx" ON "curated"."scrape_run" USING btree ("gestart");--> statement-breakpoint
CREATE INDEX "aanvraag_observation_source_record_id_idx" ON "staging"."aanvraag_observation" USING btree ("source_record_id");--> statement-breakpoint
CREATE INDEX "aanvraag_observation_status_idx" ON "staging"."aanvraag_observation" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "source_record_bron_referentie_uidx" ON "staging"."source_record" USING btree ("bron_id","bron_referentie");--> statement-breakpoint
CREATE UNIQUE INDEX "source_record_bron_content_hash_uidx" ON "staging"."source_record" USING btree ("bron_id","content_hash");--> statement-breakpoint
CREATE INDEX "source_record_scrape_run_id_idx" ON "staging"."source_record" USING btree ("scrape_run_id");