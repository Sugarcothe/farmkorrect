import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BackLink, ProfileAvatar, ProfileTopBar } from "@/components/profile/profile-parts";
import { Icon } from "@/components/ui/icons";
import { AppointmentActions } from "@/components/vets/appointment-actions";
import { VisitTimer } from "@/components/vets/visit-timer";
import { VisitWorkspace } from "@/components/vets/visit-workspace";
import {
  BookingBadge,
  durationLabel,
  flockLabel,
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
import { isJobTab } from "@/lib/vets/types";

export const metadata: Metadata = { title: "Appointment" };

// One appointment, for its customer or its vet (anyone else gets a 404).
// Everything shown is the stored state: "on the way" is the vet's own
// update, and there is no live location or arrival estimate.
//
// The vet sees it as a job offer while it's a request, and with the visit
// timer, checklist and private clinical notes once the visit has started.
// ?from= only picks which jobs tab the back link returns to.
export default async function AppointmentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user } = await requireVerifiedPageSession();
  const now = new Date();
  const appointment = await getAppointment(user, (await params).id, now);
  if (!appointment) notFound();
  const a = appointment;
  const asVet = a.viewer === "vet";
  const other = asVet ? a.customer : a.vet;
  const from = (await searchParams).from;
  const back = asVet ? (isJobTab(from) ? `/jobs?tab=${from}` : "/jobs") : "/appointments";
  const title = !asVet
    ? "Track appointment"
    : a.bookingStatus === "requested"
      ? "Job offer"
      : a.bookingStatus === "in_progress"
        ? "Appointment progress"
        : "Job details";
  const flock = flockLabel(a.farm);
  const visitShown = asVet && (a.bookingStatus === "in_progress" || a.bookingStatus === "completed");

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar title={title} back={<BackLink href={back} />} />
      <div className="flex flex-1 flex-col gap-4 px-5 pb-8">
        <Headline appointment={a} />
        {visitShown && (
          <VisitTimer
            startedAt={a.startedAt}
            serverNow={now.toISOString()}
            plannedMinutes={a.service.durationMinutes}
            running={a.bookingStatus === "in_progress"}
            endedAt={a.completedAt}
          />
        )}
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
            {asVet && <Fact label="Flock" value={flock ?? "Not linked to a farm record"} />}
            <Fact label="Status" value={<BookingBadge status={a.bookingStatus} viewer={a.viewer} />} />
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

        {visitShown && a.visit && (
          <VisitWorkspace key={`${a.bookingStatus}.${a.visit.notesVersion}`} appointment={a} visit={a.visit} />
        )}

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
