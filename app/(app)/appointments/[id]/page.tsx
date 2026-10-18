import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BackLink, ProfileAvatar, ProfileTopBar } from "@/components/profile/profile-parts";
import { Icon } from "@/components/ui/icons";
import { AppointmentActions } from "@/components/vets/appointment-actions";
import {
  BookingBadge,
  durationLabel,
  Headline,
  History,
  PaymentBadge,
  PriceBreakdown,
  Section,
  Tracker,
} from "@/components/vets/vet-parts";
import { stateLabel } from "@/lib/locations/nigeria";
import { getAppointment } from "@/lib/server/appointments";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { formatSlot } from "@/lib/vets/schedule";

export const metadata: Metadata = { title: "Appointment" };

// One appointment, for its customer or its vet (anyone else gets a 404).
// Everything shown is the stored state: "on the way" is the vet's own
// update, and there is no live location or arrival estimate.
export default async function AppointmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = await requireVerifiedPageSession();
  const appointment = await getAppointment(user, (await params).id);
  if (!appointment) notFound();
  const a = appointment;
  const asVet = a.viewer === "vet";
  const other = asVet ? a.customer : a.vet;

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title="Track appointment" back={<BackLink href={asVet ? "/jobs" : "/appointments"} />} />
      <div className="flex flex-1 flex-col gap-4 px-5 pb-8">
        <Headline appointment={a} />
        <AppointmentActions appointment={a} />

        <Section title="Visit">
          <div className="mb-3 flex items-center gap-3">
            <ProfileAvatar photoUrl={asVet ? null : a.vet.photoUrl} name={other.name} className="size-11 text-sm ring-2" />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{other.name}</p>
              <p className="text-xs text-muted-foreground">{asVet ? "Customer" : "Vet"}</p>
            </div>
          </div>
          <dl className="space-y-1.5 text-sm">
            <Fact label="Service" value={`${a.service.name} (${a.service.categoryLabel})`} />
            <Fact label="When" value={`${formatSlot(a.startsAt)}, Lagos time`} />
            <Fact label="Length" value={durationLabel(a.service.durationMinutes)} />
            <Fact label="Status" value={<BookingBadge status={a.bookingStatus} />} />
            <Fact
              label="Phone"
              value={
                other.phone ? (
                  <a href={`tel:${other.phone}`} className="font-medium text-primary underline-offset-2 hover:underline">
                    {other.phone}
                  </a>
                ) : asVet ? (
                  "Shown once you accept"
                ) : (
                  "Not shared"
                )
              }
            />
          </dl>
        </Section>

        <Section title="Farm location">
          <p className="flex items-start gap-1.5 text-sm">
            <Icon name="map-pin" className="mt-0.5 size-4 shrink-0 text-primary" />
            <span>
              {a.location.farmName && <span className="block font-medium">{a.location.farmName}</span>}
              {a.location.address}, {stateLabel(a.location.state)}
            </span>
          </p>
          {a.location.directions && (
            <p className="mt-2 text-xs leading-relaxed whitespace-pre-line text-foreground/70">{a.location.directions}</p>
          )}
        </Section>

        <Section title="Price">
          <div className="mb-2">
            <PaymentBadge status={a.paymentStatus} />
          </div>
          <PriceBreakdown priceKobo={a.priceKobo} feeKobo={a.feeKobo} totalKobo={a.totalKobo} paymentStatus={a.paymentStatus} />
        </Section>

        <Section title="Booking progress">
          <Tracker appointment={a} />
          <p className="mt-3 text-xs text-muted-foreground">
            Updated by the vet as the visit goes on. There&rsquo;s no live location tracking.
          </p>
        </Section>

        <Section title="History">
          <History appointment={a} />
        </Section>
      </div>
    </main>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}
