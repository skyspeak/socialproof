import type { Metadata } from "next";
import { DigestBody } from "@/components/DigestBody";
import { FIXTURE_DIGEST } from "@/lib/fixture-digest";

export const metadata: Metadata = {
  title: "Specimen — Trendwire",
  robots: { index: false, follow: false },
};

/** Typeset a fixture issue so the magazine can be judged without a press run. */
export default function PreviewPage() {
  return <DigestBody digest={FIXTURE_DIGEST} specimen />;
}
