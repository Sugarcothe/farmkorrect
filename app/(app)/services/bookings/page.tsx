import type { Metadata } from "next";
import { ServiceBookingListPage } from "@/components/services/service-booking-list-page";
import { requireVerifiedPageSession } from "@/lib/server/auth";

export const metadata: Metadata = { title: "My service bookings" };

// Services the signed-in user has booked.
export default async function ServiceBookingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireVerifiedPageSession();
  return <ServiceBookingListPage user={user} view="customer" cursorParam={(await searchParams).cursor} />;
}
