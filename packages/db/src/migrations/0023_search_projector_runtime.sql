CREATE TABLE "curated"."search_projector_runtime" (
	"container_id" text NOT NULL,
	"cycle" bigint NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL,
	"index_name" text PRIMARY KEY NOT NULL,
	"release_sha" text,
	"started_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
