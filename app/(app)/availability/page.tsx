import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ProfileTopBar } from "@/components/profile/profile-parts";
import { AvailabilityForm } from "@/components/vets/availability-form";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { availabilityResponse } from "@/lib/server/vet-availability";
import { lagosDate } from "@/lib/vets/schedule";

export const metadata: Metadata = { title: "Availability" };

// A veterinarian's booking settings: whether they're listed, where they work,
// their hours and days off. Other accounts don't take vet appointments.
export default async function AvailabilityPage() {
  const { user } = await requireVerifiedPageSession();
  if (user.role !== "veterinarian") redirect("/home");
  const { settings, listingIssues } = await availabilityResponse(user);

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Availability" />
      <div className="flex-1 px-5 pb-8">
        <AvailabilityForm initial={settings} initialIssues={listingIssues} today={lagosDate(new Date())} />
      </div>
    </main>
  );
}
