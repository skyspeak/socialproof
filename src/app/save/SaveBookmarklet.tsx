"use client";

import { useMemo, useState } from "react";

export function SaveBookmarklet() {
  const [token, setToken] = useState("");
  const [copied, setCopied] = useState(false);

  const origin =
    typeof window !== "undefined" ? window.location.origin : "https://example.com";

  const href = useMemo(() => {
    if (!token.trim()) return "#";
    const endpoint = `${origin}/api/bookmark?token=${encodeURIComponent(token.trim())}&url=`;
    const js = `javascript:(function(){var u=location.href;if(!/status\\/\\d+/.test(u)){alert('Open a tweet first.');return;}open(${JSON.stringify(endpoint)}+encodeURIComponent(u),'_blank','noopener');})();`;
    return js;
  }, [origin, token]);

  const ready = Boolean(token.trim());

  async function copy() {
    if (!ready) return;
    await navigator.clipboard.writeText(href);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="save-card">
      <label htmlFor="bookmark-token">
        Paste <code>BOOKMARK_SECRET</code> (or <code>CRON_SECRET</code> if you
        have not set a separate one)
      </label>
      <input
        id="bookmark-token"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder="secret"
      />
      <div className="save-actions">
        <a
          className={ready ? "bookmarklet" : "bookmarklet disabled"}
          href={ready ? href : undefined}
          onClick={(e) => {
            if (!ready) e.preventDefault();
          }}
        >
          Save to Trendwire
        </a>
        <button type="button" onClick={copy} disabled={!ready}>
          {copied ? "Copied" : "Copy bookmarklet"}
        </button>
      </div>
      <p className="save-hint">
        Drag the red link onto your bookmarks bar, then click it while a tweet
        is open. The secret stays in the bookmark on this browser — it is not
        sent to this page from the server.
      </p>
    </div>
  );
}
