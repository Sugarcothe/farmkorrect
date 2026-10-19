import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { JobsPage } from "@/components/vets/jobs-page";
import { requireVerifiedPageSession } from "@/lib/server/auth";

export const metadata: Metadata = { title: "My jobs" };

// Appointments booked with the signed-in veterinarian, by tab (?tab=).
export default async function Jobs({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireVerifiedPageSession();
  if (user.role !== "veterinarian") redirect("/appointments");
  const params = await searchParams;
  return <JobsPage user={user} tabParam={params.tab} cursorParam={params.cursor} />;
}
