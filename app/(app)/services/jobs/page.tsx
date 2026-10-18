import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ServiceBookingListPage } from "@/components/services/service-booking-list-page";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { MARKETPLACE_ROLES } from "@/lib/services/config";

export const metadata: Metadata = { title: "Service jobs" };

// Service bookings made with the signed-in provider.
export default async function ServiceJobsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireVerifiedPageSession();
  if (MARKETPLACE_ROLES[user.role].length === 0) redirect("/services/bookings");
  return <ServiceBookingListPage user={user} view="provider" cursorParam={(await searchParams).cursor} />;
}
