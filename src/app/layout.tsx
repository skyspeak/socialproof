import type { Metadata } from "next";
import { display, sans, serif } from "@/lib/fonts";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import { ThemeToggle } from "@/components/ThemeToggle";
import "./globals.css";

export const metadata: Metadata = {
  title: "Trendwire",
  description:
    "A daily magazine of what technology actually argued about, assembled without opening the sites.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${serif.variable} ${sans.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <link
          rel="alternate"
          type="application/rss+xml"
          title="Trendwire"
          href="/feed.xml"
        />
      </head>
      <body>
        <div className="desk">
          <div className="sheet">
            <div className="lamp">
              <ThemeToggle />
            </div>
            {children}
            <footer className="colophon">
              <span>
                Typeset daily from the open web. The sites stay closed.
              </span>
              <span>
                <a href="/archive">Back issues</a>
                {" · "}
                <a href="/save">Save a tweet</a>
                {" · "}
                <a href="/feed.xml">RSS</a>
              </span>
            </footer>
          </div>
        </div>
      </body>
    </html>
  );
}
