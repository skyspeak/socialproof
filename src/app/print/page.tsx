import { notFound, redirect } from "next/navigation";
import { getLatestDigestDate } from "@/db/queries";

export const dynamic = "force-dynamic";

/** `/print` — the newest published issue's print edition. */
export default async function LatestPrint() {
  const latest = await getLatestDigestDate().catch(() => null);
  if (!latest) notFound();
  redirect(`/digest/${latest}/print`);
}
