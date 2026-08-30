import type { Metadata } from "next";
import { SaveBookmarklet } from "./SaveBookmarklet";

export const metadata: Metadata = {
  title: "Save a tweet — Trendwire",
  description:
    "Hold a tweet, its links, and its images for the next issue.",
};

export default function SavePage() {
  return (
    <article className="save">
      <header className="mast-compact">
        <a href="/">Trendwire</a>
        <span>Hold for the issue</span>
      </header>

      <h3 className="hed">Bookmarks</h3>
      <h2>Save a tweet without opening the site tomorrow.</h2>
      <p>
        Click it on a post. The next issue gets the text, every outbound link,
        and every image — filed under Noted, and eligible for a theme.
      </p>

      <h3>The bookmarklet</h3>
      <p>
        Set <code>BOOKMARK_SECRET</code> in the environment, paste it below,
        drag the red link to your bookmarks bar.
      </p>
      <SaveBookmarklet />

      <h3>Inside X, optionally</h3>
      <p>
        Native X bookmarks can feed the same path if you set{" "}
        <code>X_BOOKMARKS_TOKEN</code> (user token, <code>bookmark.read</code>)
        and <code>X_USER_ID</code>.
      </p>

      <h3>A shortcut</h3>
      <pre>
        {`GET /api/bookmark?token=YOUR_SECRET&url=https://x.com/user/status/123`}
      </pre>
    </article>
  );
}
