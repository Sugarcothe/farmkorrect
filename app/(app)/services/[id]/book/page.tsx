import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { ServiceBookingForm } from "@/components/services/service-booking-form";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { bookableDates } from "@/lib/server/service-bookings";
import { getMarketplaceService } from "@/lib/server/service-directory";

export const metadata: Metadata = { title: "Book a service" };

// Step 1 of 3: the job, the day and the place. The server checks everything
// again when the booking is sent; what's shown here is only what was true
// when it was read.
export default async function BookServicePage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = await requireVerifiedPageSession();
  const service = await getMarketplaceService((await params).id, user._id);
  if (!service) notFound();
  if (!service.canBook) redirect(`/services/${service.id}`);
  const { first, last } = bookableDates();

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar
        title={service.pricing === "quote" ? "Request a quote" : "Book service"}
        back={<BackLink href={`/services/${service.id}`} />}
      />
      <div className="flex flex-1 flex-col px-5 pb-8">
        <p className="mb-3 text-[0.6875rem] font-semibold tracking-wide text-primary uppercase">
          Step 1 of 3 · Booking details
        </p>
        <ServiceBookingForm service={service} firstDate={first} lastDate={last} />
      </div>
    </main>
  );
}
