import {
  bookmarksToIngestItems,
  listBookmarksInWindow,
  syncNativeXBookmarks,
} from "@/lib/bookmarks";
import type { SourceDef } from "../adapter";

/**
 * Reader-saved tweets. The bookmarklet (and optional native X bookmarks poll)
 * write the `bookmarks` table; this adapter copies each tweet plus its outbound
 * links and images into the day's corpus so they cannot be crowded out by HN.
 */
export const bookmarksSource: SourceDef = {
  slug: "bookmarks",
  name: "Saved tweets",
  kind: "bookmarks",
  tier: "saved",
  async fetch(window) {
    try {
      await syncNativeXBookmarks();
    } catch {
      /* local rows still ingest; native sync is optional */
    }
    const rows = await listBookmarksInWindow(window);
    return bookmarksToIngestItems(rows);
  },
};
