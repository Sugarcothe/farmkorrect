import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AppointmentListPage } from "@/components/vets/appointment-list-page";
import { requireVerifiedPageSession } from "@/lib/server/auth";

export const metadata: Metadata = { title: "Jobs" };

// Appointments booked with the signed-in veterinarian.
export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireVerifiedPageSession();
  if (user.role !== "veterinarian") redirect("/appointments");
  return <AppointmentListPage user={user} view="vet" cursorParam={(await searchParams).cursor} />;
}
