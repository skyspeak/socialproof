import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Trendwire — the daily tech read, without X",
  description:
    "A daily digest of what technology actually argued about: Hacker News, the open forums, and the X conversation as it reaches the open web. Plus who left, who joined, and who started something.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&family=Libre+Franklin:wght@400;600;700&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&display=swap"
          rel="stylesheet"
        />
        <link
          rel="alternate"
          type="application/rss+xml"
          title="Trendwire"
          href="/feed.xml"
        />
      </head>
      <body>
        <div className="shell">
          <header className="masthead">
            <h1>
              <a href="/">Trendwire</a>
            </h1>
            <div className="tagline">
              The daily technology read · assembled without opening X
            </div>
          </header>
          {children}
          <footer className="colophon">
            <span>
              Assembled daily from Hacker News, Lobsters, GitHub, arXiv,
              Techmeme, Reddit and the open-web reflection of X.
            </span>
            <span>
              <a href="/feed.xml">RSS</a> · <a href="/archive">Archive</a>
            </span>
          </footer>
        </div>
      </body>
    </html>
  );
}
