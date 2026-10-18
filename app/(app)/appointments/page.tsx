import type { Metadata } from "next";
import { AppointmentListPage } from "@/components/vets/appointment-list-page";
import { requireVerifiedPageSession } from "@/lib/server/auth";

export const metadata: Metadata = { title: "My appointments" };

// The signed-in customer's vet appointments, read from the database.
export default async function AppointmentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireVerifiedPageSession();
  return <AppointmentListPage user={user} view="customer" cursorParam={(await searchParams).cursor} />;
}
