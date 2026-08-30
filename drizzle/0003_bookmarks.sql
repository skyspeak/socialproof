CREATE TABLE "bookmarks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tweet_id" text NOT NULL,
	"tweet_url" text NOT NULL,
	"author" text,
	"text" text,
	"published_at" timestamp with time zone,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"links" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"images" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw" jsonb
);
--> statement-breakpoint
CREATE UNIQUE INDEX "bookmarks_tweet_id_idx" ON "bookmarks" USING btree ("tweet_id");
--> statement-breakpoint
CREATE INDEX "bookmarks_captured_idx" ON "bookmarks" USING btree ("captured_at");
