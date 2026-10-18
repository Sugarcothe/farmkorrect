import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { BackLink, ProfileTopBar } from "@/components/profile/profile-parts";
import { BookingWizard, type FarmOption } from "@/components/vets/booking-wizard";
import { first } from "@/components/wallet/wallet-parts";
import type { ObjectId } from "mongodb";
import { parseNigerianState } from "@/lib/locations/nigeria";
import { appointmentCollections } from "@/lib/server/appointments";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { getVetProfile } from "@/lib/server/vet-directory";

export const metadata: Metadata = { title: "Book a vet" };

/** The customer's own farms, offered as the visit's location. */
async function farmOptions(ownerUserId: ObjectId): Promise<FarmOption[]> {
  const { farms } = await appointmentCollections();
  const docs = await farms
    .find({ ownerUserId }, { projection: { farmName: 1, location: 1, farmType: 1, birdCount: 1 } })
    .sort({ createdAt: 1 })
    .limit(10)
    .toArray();
  return docs.map((f) => ({
    id: f._id.toHexString(),
    farmName: f.farmName,
    location: f.location,
    // only an exact state name ("…, Oyo State" or "…, Oyo"); nothing is guessed
    state: parseNigerianState(f.location.split(",").at(-1)?.trim().replace(/\s+state$/i, "")),
    farmType: f.farmType,
    birdCount: f.birdCount,
  }));
}

// Booking a listed vet: service, then date and time, the farm's location,
// a review and the request as the server recorded it. The server re-checks everything when the booking is sent;
// what's shown here is only what was true when it was read.
export default async function BookVetPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireVerifiedPageSession();
  const { id } = await params;
  const vet = await getVetProfile(id);
  if (!vet) notFound();
  if (vet.id === user._id.toHexString()) redirect(`/vets/${vet.id}`);
  const wanted = first((await searchParams).service);
  const serviceId = vet.services.some((s) => s.id === wanted) ? wanted! : null;

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Book appointment" back={<BackLink href={`/vets/${vet.id}`} />} />
      <BookingWizard vet={vet} initialServiceId={serviceId} farms={await farmOptions(user._id)} />
    </main>
  );
}
