import type { Metadata } from "next";
import { ServiceBookingPage } from "@/components/services/service-booking-page";

export const metadata: Metadata = { title: "Service job" };

// The provider's view of one booking.
export default function ServiceJobRoute(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <ServiceBookingPage {...props} as="provider" />;
}
