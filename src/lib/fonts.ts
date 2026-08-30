import { Fraunces, Libre_Franklin, Newsreader } from "next/font/google";

/** Display: nameplate, cover line, story heds. */
export const display = Fraunces({
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  style: ["normal", "italic"],
  variable: "--font-display",
  display: "swap",
});

/** Body: the well. Optical-ish weights for long reading. */
export const serif = Newsreader({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-serif",
  display: "swap",
});

/** Kickers, folio, credits. */
export const sans = Libre_Franklin({
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  variable: "--font-sans",
  display: "swap",
});
