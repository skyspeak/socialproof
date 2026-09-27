import { notFound } from "next/navigation";
import { getDigest, getIntakeItems } from "@/db/queries";
import { isValidDateKey } from "@/lib/window";
import { PrintEdition } from "@/components/PrintEdition";
import "./print.css";

export const revalidate = 3600;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ date: string }>;
}) {
  const { date } = await params;
  return { title: `Trendwire — ${date} — print edition` };
}

export default async function PrintPage({
  params,
}: {
  params: Promise<{ date: string }>;
}) {
  const { date } = await params;
  if (!isValidDateKey(date)) notFound();

  const digest = await getDigest(date).catch(() => null);
  if (!digest || digest.status !== "published") notFound();

  const intake = await getIntakeItems(date, 500).catch(() => []);
  return <PrintEdition digest={digest} intake={intake} />;
}
