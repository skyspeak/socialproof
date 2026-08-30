import {
  pgTable,
  text,
  integer,
  timestamp,
  boolean,
  jsonb,
  uuid,
  date,
  real,
  uniqueIndex,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

/**
 * Registry of every feed we ingest. Rows are seeded from src/ingest/registry.ts
 * but live in the DB so a source can be disabled in production without a deploy.
 */
export const sources = pgTable(
  "sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    /** hackernews | lobsters | github | reddit | arxiv | rss | techmeme | exa_x */
    kind: text("kind").notNull(),
    /** Which discourse tier this belongs to: core | x_adjacent | people | saved */
    tier: text("tier").notNull().default("core"),
    url: text("url"),
    config: jsonb("config").$type<Record<string, unknown>>(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("sources_slug_idx").on(t.slug)],
);

/**
 * Everything ingested, normalized. Unique on (source_id, external_id) so
 * re-running a day is idempotent — repeated ingests upsert rather than duplicate.
 */
export const rawItems = pgTable(
  "raw_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    url: text("url"),
    /** Canonicalized URL used for cross-source dedup. */
    canonicalUrl: text("canonical_url"),
    /** sha256 of normalized title+body, catches the same story posted at different URLs. */
    contentHash: text("content_hash"),
    title: text("title").notNull(),
    body: text("body"),
    author: text("author"),
    score: integer("score"),
    commentCount: integer("comment_count"),
    /** Engagement velocity at fetch time — points per hour since publication. */
    velocity: real("velocity"),
    discussionUrl: text("discussion_url"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
  },
  (t) => [
    uniqueIndex("raw_items_source_external_idx").on(t.sourceId, t.externalId),
    index("raw_items_published_idx").on(t.publishedAt),
    index("raw_items_canonical_idx").on(t.canonicalUrl),
    index("raw_items_hash_idx").on(t.contentHash),
  ],
);

/** One row per day. `digestDate` is the local date the window closes on. */
export const digests = pgTable(
  "digests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    digestDate: date("digest_date").notNull(),
    /** pending | ingesting | synthesizing | published | failed */
    status: text("status").notNull().default("pending"),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    /** One-paragraph editorial read on the day. */
    intro: text("intro"),
    /** The one or two things actually worth attention. */
    headline: text("headline"),
    itemCount: integer("item_count").notNull().default(0),
    generatedAt: timestamp("generated_at", { withTimezone: true }),
    /** Model id (gemini, openrouter, …) or `wire` when the editorial call did not run. */
    provider: text("provider"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("digests_date_idx").on(t.digestDate),
    index("digests_status_idx").on(t.status),
  ],
);

/** Named themes clustered across sources for a given digest. */
export const themes = pgTable(
  "themes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    digestId: uuid("digest_id")
      .notNull()
      .references(() => digests.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    summary: text("summary").notNull(),
    /** Why this matters — the editorial line, kept separate from the summary. */
    soWhat: text("so_what"),
    isNew: boolean("is_new").notNull().default(true),
    rank: integer("rank").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("themes_digest_idx").on(t.digestId, t.rank)],
);

/** Join table: which ingested items support which theme. */
export const themeItems = pgTable(
  "theme_items",
  {
    themeId: uuid("theme_id")
      .notNull()
      .references(() => themes.id, { onDelete: "cascade" }),
    rawItemId: uuid("raw_item_id")
      .notNull()
      .references(() => rawItems.id, { onDelete: "cascade" }),
    rank: integer("rank").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.themeId, t.rawItemId] })],
);

/**
 * The people beat. Confidence is a column, not prose, so the UI can separate
 * confirmed moves from unverified chatter and callers can filter.
 */
export const peopleMoves = pgTable(
  "people_moves",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    digestId: uuid("digest_id")
      .notNull()
      .references(() => digests.id, { onDelete: "cascade" }),
    person: text("person").notNull(),
    fromOrg: text("from_org"),
    toOrg: text("to_org"),
    role: text("role"),
    /** departure | new_role | founded | promoted | board | funding | layoff | other */
    moveType: text("move_type").notNull().default("other"),
    /** confirmed | reported | chatter */
    confidence: text("confidence").notNull().default("reported"),
    /** One line on why this signals something. */
    note: text("note"),
    evidenceUrl: text("evidence_url"),
    rawItemId: uuid("raw_item_id").references(() => rawItems.id, {
      onDelete: "set null",
    }),
    rank: integer("rank").notNull().default(0),
  },
  (t) => [
    index("people_moves_digest_idx").on(t.digestId, t.rank),
    index("people_moves_person_idx").on(t.person),
  ],
);

/**
 * Per-execution log. A broken scraper shows up here instead of silently
 * shrinking the digest.
 */
export const runs = pgTable(
  "runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    digestId: uuid("digest_id").references(() => digests.id, {
      onDelete: "cascade",
    }),
    /** ingest | synthesize */
    phase: text("phase").notNull(),
    /** running | ok | partial | failed */
    status: text("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    itemsIngested: integer("items_ingested").notNull().default(0),
    error: text("error"),
  },
  (t) => [index("runs_digest_idx").on(t.digestId)],
);

/**
 * Cooperative lease lock.
 *
 * Vercel explicitly does not manage cron concurrency — if a run outlives its
 * interval, a second invocation can start on top of it. We can't use Postgres
 * session advisory locks here because Neon's pooled endpoint runs PgBouncer in
 * transaction mode, where a session-scoped lock can outlive the logical
 * connection that took it. A lease row with an expiry is safe under pooling,
 * survives a hard function kill (the lease simply expires), and is inspectable.
 */
export const locks = pgTable("locks", {
  name: text("name").primaryKey(),
  holder: text("holder").notNull(),
  acquiredAt: timestamp("acquired_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

/** Per-source outcome within a run — the granular half of observability. */
export const runSources = pgTable(
  "run_sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    sourceSlug: text("source_slug").notNull(),
    /** ok | empty | failed | skipped */
    status: text("status").notNull(),
    itemsFound: integer("items_found").notNull().default(0),
    itemsNew: integer("items_new").notNull().default(0),
    durationMs: integer("duration_ms"),
    error: text("error"),
  },
  (t) => [index("run_sources_run_idx").on(t.runId)],
);

/**
 * Tweets the reader saved (bookmarklet or native X bookmarks). Filtered by
 * capturedAt, not tweet age — an old post bookmarked today belongs in today's
 * issue. Links and images are unpacked into raw_items by the bookmarks source.
 */
export const bookmarks = pgTable(
  "bookmarks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tweetId: text("tweet_id").notNull(),
    tweetUrl: text("tweet_url").notNull(),
    author: text("author"),
    text: text("text"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    links: jsonb("links").$type<string[]>().notNull().default([]),
    images: jsonb("images").$type<string[]>().notNull().default([]),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
  },
  (t) => [
    uniqueIndex("bookmarks_tweet_id_idx").on(t.tweetId),
    index("bookmarks_captured_idx").on(t.capturedAt),
  ],
);

// ---- Relations --------------------------------------------------------------

export const sourcesRelations = relations(sources, ({ many }) => ({
  items: many(rawItems),
}));

export const rawItemsRelations = relations(rawItems, ({ one, many }) => ({
  source: one(sources, {
    fields: [rawItems.sourceId],
    references: [sources.id],
  }),
  themeItems: many(themeItems),
}));

export const digestsRelations = relations(digests, ({ many }) => ({
  themes: many(themes),
  peopleMoves: many(peopleMoves),
  runs: many(runs),
}));

export const themesRelations = relations(themes, ({ one, many }) => ({
  digest: one(digests, {
    fields: [themes.digestId],
    references: [digests.id],
  }),
  items: many(themeItems),
}));

export const themeItemsRelations = relations(themeItems, ({ one }) => ({
  theme: one(themes, {
    fields: [themeItems.themeId],
    references: [themes.id],
  }),
  rawItem: one(rawItems, {
    fields: [themeItems.rawItemId],
    references: [rawItems.id],
  }),
}));

export const peopleMovesRelations = relations(peopleMoves, ({ one }) => ({
  digest: one(digests, {
    fields: [peopleMoves.digestId],
    references: [digests.id],
  }),
  rawItem: one(rawItems, {
    fields: [peopleMoves.rawItemId],
    references: [rawItems.id],
  }),
}));

export const runsRelations = relations(runs, ({ one, many }) => ({
  digest: one(digests, {
    fields: [runs.digestId],
    references: [digests.id],
  }),
  sources: many(runSources),
}));

export const runSourcesRelations = relations(runSources, ({ one }) => ({
  run: one(runs, { fields: [runSources.runId], references: [runs.id] }),
}));

export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;
export type RawItem = typeof rawItems.$inferSelect;
export type NewRawItem = typeof rawItems.$inferInsert;
export type Digest = typeof digests.$inferSelect;
export type Theme = typeof themes.$inferSelect;
export type PeopleMove = typeof peopleMoves.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type Bookmark = typeof bookmarks.$inferSelect;
export type NewBookmark = typeof bookmarks.$inferInsert;
