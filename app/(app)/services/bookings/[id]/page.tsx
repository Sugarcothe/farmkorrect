import type { Metadata } from "next";
import { ServiceBookingPage } from "@/components/services/service-booking-page";

export const metadata: Metadata = { title: "Service booking" };

// The customer's view of one booking: payment, confirmation and tracking.
// Paystack sends the customer back here with ?reference=…
export default function ServiceBookingRoute(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <ServiceBookingPage {...props} as="customer" />;
}
