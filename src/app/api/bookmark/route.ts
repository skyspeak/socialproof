import { NextResponse } from "next/server";
import { BookmarkError, captureBookmark } from "@/lib/bookmarks";
import { findTweetUrl } from "@/lib/tweet";
import { authorizedBookmark } from "@/lib/site";
import { THEME_INIT_SCRIPT } from "@/lib/theme";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers":
    "authorization, content-type, x-bookmark-token",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/**
 * Capture a tweet (and the links + images it carries) into the bookmarks table.
 *
 * GET is the bookmarklet path: navigate here with `?url=` and `?token=`.
 * POST is for shortcuts / fetch() from x.com.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  if (!authorizedBookmark(req, url)) {
    return respond(req, { error: "unauthorized" }, 401);
  }

  const input = url.searchParams.get("url") ?? url.searchParams.get("text") ?? "";
  return handleCapture(req, input);
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  if (!authorizedBookmark(req, url)) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: CORS },
    );
  }

  let input = url.searchParams.get("url") ?? url.searchParams.get("text") ?? "";
  const contentType = req.headers.get("content-type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const body = (await req.json()) as { url?: string; text?: string };
      input = body.url || body.text || input;
    } else if (
      contentType.includes("application/x-www-form-urlencoded") ||
      contentType.includes("multipart/form-data")
    ) {
      const form = await req.formData();
      input = String(form.get("url") || form.get("text") || input);
    } else if (!input) {
      input = (await req.text()).trim();
    }
  } catch {
    /* body optional if the URL is in the query string */
  }

  return handleCapture(req, input);
}

async function handleCapture(req: Request, input: string) {
  const tweetUrl = findTweetUrl(input) ?? input.trim();
  if (!tweetUrl) {
    return respond(
      req,
      { error: "missing_url", message: "Pass a tweet URL as url= or JSON { url }." },
      400,
    );
  }

  try {
    const saved = await captureBookmark(tweetUrl);
    return respond(req, { ok: true, saved }, 200);
  } catch (err) {
    if (err instanceof BookmarkError) {
      return respond(
        req,
        { error: err.code, message: err.message },
        err.code === "not_a_tweet" ? 400 : 502,
      );
    }
    return respond(
      req,
      {
        error: "fetch_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      502,
    );
  }
}

function respond(
  req: Request,
  body: Record<string, unknown>,
  status: number,
): NextResponse {
  const accept = req.headers.get("accept") ?? "";
  const wantsHtml =
    req.method === "GET" &&
    accept.includes("text/html") &&
    !accept.includes("application/json");

  if (!wantsHtml) {
    return NextResponse.json(body, { status, headers: CORS });
  }

  return new NextResponse(htmlPage(body), {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...CORS },
  });
}

function htmlPage(body: Record<string, unknown>): string {
  const saved = body.saved as
    | {
        tweetUrl?: string;
        author?: string | null;
        text?: string | null;
        links?: string[];
        images?: string[];
      }
    | undefined;
  const ok = body.ok === true && saved;
  const message = typeof body.message === "string" ? body.message : null;
  const title = ok ? "Saved to Trendwire" : "Could not save";
  const images = saved?.images ?? [];
  const links = saved?.links ?? [];

  const imageBlock = images.length
    ? `<div class="imgs">${images
        .map(
          (src) =>
            `<a href="${esc(src)}" target="_blank" rel="noopener"><img src="${esc(src)}" alt=""></a>`,
        )
        .join("")}</div>`
    : `<p class="mute">No images on this tweet.</p>`;

  const linkBlock = links.length
    ? `<ul>${links
        .map(
          (href) =>
            `<li><a href="${esc(href)}" target="_blank" rel="noopener">${esc(href)}</a></li>`,
        )
        .join("")}</ul>`
    : `<p class="mute">No outbound links.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <script>${THEME_INIT_SCRIPT}</script>
  <style>
    :root {
      --ink: #141210; --mute: #6a635a; --paper: #efe8dc; --sheet: #fffcf6;
      --hair: #e4ddd2; --navy: #153a5c; color-scheme: light;
    }
    @media (prefers-color-scheme: dark) {
      html:not([data-theme="light"]) {
        --ink: #f3ece3; --mute: #9a9086; --paper: #161310; --sheet: #1f1b17;
        --hair: #3f3832; --navy: #b7cfe0; color-scheme: dark;
      }
    }
    html[data-theme="dark"] {
      --ink: #f3ece3; --mute: #9a9086; --paper: #161310; --sheet: #1f1b17;
      --hair: #3f3832; --navy: #b7cfe0; color-scheme: dark;
    }
    html[data-theme="light"] { color-scheme: light; }
    body { margin: 0; font-family: Georgia, "Times New Roman", serif; background: var(--paper); color: var(--ink); }
    main { max-width: 42rem; margin: 0 auto; padding: 3rem 6vw 4rem; background: var(--sheet); }
    .kicker { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 0.7rem; letter-spacing: 0.16em; text-transform: uppercase; color: var(--mute); }
    h1 { font-size: 1.8rem; margin: 0.4rem 0 1rem; }
    p { line-height: 1.55; }
    .mute { color: var(--mute); font-size: 0.95rem; }
    a { color: var(--navy); }
    .imgs { display: grid; grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr)); gap: 0.6rem; margin: 1rem 0; }
    .imgs img { width: 100%; height: 8rem; object-fit: cover; border: 1px solid var(--hair); }
    ul { padding-left: 1.2rem; }
    li { margin: 0.35rem 0; word-break: break-all; font-size: 0.9rem; }
  </style>
</head>
<body>
  <main>
    <div class="kicker">Trendwire</div>
    <h1>${esc(title)}</h1>
    ${
      ok
        ? `<p>${saved.author ? `@${esc(saved.author)}` : "Tweet"} saved. Its links and images will land in the next issue.</p>
           ${saved.text ? `<p>${esc(saved.text.slice(0, 500))}</p>` : ""}
           <p><a href="${esc(saved.tweetUrl ?? "#")}">Open the tweet</a> · <a href="/">Back to the digest</a> · <a href="/save">Bookmarklet</a></p>
           <h2 style="font-size:1.1rem;margin-top:2rem">Images</h2>
           ${imageBlock}
           <h2 style="font-size:1.1rem">Links</h2>
           ${linkBlock}`
        : `<p>${esc(message ?? "Something went wrong.")}</p>
           <p><a href="/save">How to save a tweet</a></p>`
    }
  </main>
</body>
</html>`;
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
