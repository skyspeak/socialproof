CREATE TABLE "digests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"digest_date" date NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"intro" text,
	"headline" text,
	"item_count" integer DEFAULT 0 NOT NULL,
	"generated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "people_moves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"digest_id" uuid NOT NULL,
	"person" text NOT NULL,
	"from_org" text,
	"to_org" text,
	"role" text,
	"move_type" text DEFAULT 'other' NOT NULL,
	"confidence" text DEFAULT 'reported' NOT NULL,
	"note" text,
	"evidence_url" text,
	"raw_item_id" uuid,
	"rank" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"url" text,
	"canonical_url" text,
	"content_hash" text,
	"title" text NOT NULL,
	"body" text,
	"author" text,
	"score" integer,
	"comment_count" integer,
	"velocity" real,
	"discussion_url" text,
	"published_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw" jsonb
);
--> statement-breakpoint
CREATE TABLE "run_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"source_slug" text NOT NULL,
	"status" text NOT NULL,
	"items_found" integer DEFAULT 0 NOT NULL,
	"items_new" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"digest_id" uuid,
	"phase" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"items_ingested" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"tier" text DEFAULT 'core' NOT NULL,
	"url" text,
	"config" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "theme_items" (
	"theme_id" uuid NOT NULL,
	"raw_item_id" uuid NOT NULL,
	"rank" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "theme_items_theme_id_raw_item_id_pk" PRIMARY KEY("theme_id","raw_item_id")
);
--> statement-breakpoint
CREATE TABLE "themes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"digest_id" uuid NOT NULL,
	"name" text NOT NULL,
	"summary" text NOT NULL,
	"so_what" text,
	"is_new" boolean DEFAULT true NOT NULL,
	"rank" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "people_moves" ADD CONSTRAINT "people_moves_digest_id_digests_id_fk" FOREIGN KEY ("digest_id") REFERENCES "public"."digests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people_moves" ADD CONSTRAINT "people_moves_raw_item_id_raw_items_id_fk" FOREIGN KEY ("raw_item_id") REFERENCES "public"."raw_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_items" ADD CONSTRAINT "raw_items_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_sources" ADD CONSTRAINT "run_sources_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_digest_id_digests_id_fk" FOREIGN KEY ("digest_id") REFERENCES "public"."digests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "theme_items" ADD CONSTRAINT "theme_items_theme_id_themes_id_fk" FOREIGN KEY ("theme_id") REFERENCES "public"."themes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "theme_items" ADD CONSTRAINT "theme_items_raw_item_id_raw_items_id_fk" FOREIGN KEY ("raw_item_id") REFERENCES "public"."raw_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "themes" ADD CONSTRAINT "themes_digest_id_digests_id_fk" FOREIGN KEY ("digest_id") REFERENCES "public"."digests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "digests_date_idx" ON "digests" USING btree ("digest_date");--> statement-breakpoint
CREATE INDEX "digests_status_idx" ON "digests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "people_moves_digest_idx" ON "people_moves" USING btree ("digest_id","rank");--> statement-breakpoint
CREATE INDEX "people_moves_person_idx" ON "people_moves" USING btree ("person");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_items_source_external_idx" ON "raw_items" USING btree ("source_id","external_id");--> statement-breakpoint
CREATE INDEX "raw_items_published_idx" ON "raw_items" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "raw_items_canonical_idx" ON "raw_items" USING btree ("canonical_url");--> statement-breakpoint
CREATE INDEX "raw_items_hash_idx" ON "raw_items" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "run_sources_run_idx" ON "run_sources" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "runs_digest_idx" ON "runs" USING btree ("digest_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_slug_idx" ON "sources" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "themes_digest_idx" ON "themes" USING btree ("digest_id","rank");