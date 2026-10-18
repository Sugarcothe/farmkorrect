import { notFound, redirect } from "next/navigation";
import { BackLink, ProfileAvatar, ProfileTopBar } from "@/components/profile/profile-parts";
import { Icon } from "@/components/ui/icons";
import { first } from "@/components/wallet/wallet-parts";
import { stateLabel } from "@/lib/locations/nigeria";
import { requireVerifiedPageSession } from "@/lib/server/auth";
import { getServiceBooking } from "@/lib/server/service-bookings";
import { CONTACT_PREFERENCES } from "@/lib/services/marketplace";
import { formatSlot } from "@/lib/vets/schedule";
import { formatKobo } from "@/lib/wallet/money";
import { ServiceBookingActions } from "./service-booking-actions";
import {
  Fact,
  PaymentSummary,
  Section,
  ServiceHeadline,
  ServiceHistory,
  ServicePaymentBadge,
  ServiceStatusBadge,
  ServiceTracker,
  whenLabel,
} from "./service-parts";

type SearchParams = Record<string, string | string[] | undefined>;

/** The payment reference Paystack hands back (ours, fsp_…); anything else is ignored. */
const returned = (params: SearchParams) => {
  const ref = first(params.reference) ?? first(params.trxref);
  return ref && /^[A-Za-z0-9_-]{6,64}$/.test(ref) ? ref : null;
};

/**
 * One service booking, for its customer (/services/bookings/[id]) or its
 * provider (/services/jobs/[id]); anyone else gets a 404. Everything shown is
 * the stored state: "on the way" is the provider's own update, and there is
 * no live location or arrival estimate. Coming back from Paystack, the
 * payment is checked with Paystack through the server before anything shows
 * as paid.
 */
export async function ServiceBookingPage({
  params,
  searchParams,
  as,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
  as: "customer" | "provider";
}) {
  const { user } = await requireVerifiedPageSession();
  const { id } = await params;
  const found = await getServiceBooking(user, id);
  if (!found) notFound();
  const b = found.booking;
  const query = await searchParams;
  if (b.viewer !== as) {
    const search = new URLSearchParams(
      Object.entries(query).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])),
    ).toString();
    redirect(`/services/${b.viewer === "provider" ? "jobs" : "bookings"}/${b.id}${search ? `?${search}` : ""}`);
  }
  const provider = b.viewer === "provider";
  const other = provider ? b.customer : b.provider;
  const contact = CONTACT_PREFERENCES.find((c) => c.value === b.contactPreference)?.label ?? "";

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar
        title={provider ? "Job" : "Track booking"}
        back={<BackLink href={provider ? "/services/jobs" : "/services/bookings"} />}
      />
      <div className="flex flex-1 flex-col gap-4 px-5 pb-8">
        <ServiceHeadline booking={b} />
        <ServiceBookingActions booking={b} returnedReference={provider ? null : returned(query)} />

        {b.quote && (
          <Section title="Quote">
            <dl className="space-y-1.5 text-sm">
              <Fact label="Price" value={<span className="font-semibold">{formatKobo(b.quote.amountKobo)}</span>} />
              <Fact label="Sent" value={formatSlot(b.quote.offeredAt)} />
              <Fact label="Valid until" value={formatSlot(b.quote.validUntil)} />
            </dl>
            {b.quote.note && (
              <p className="mt-2 text-sm leading-relaxed whitespace-pre-line text-foreground/80">{b.quote.note}</p>
            )}
          </Section>
        )}

        <Section title="Booking">
          <div className="mb-3 flex items-center gap-3">
            <ProfileAvatar
              photoUrl={provider ? null : b.provider.photoUrl}
              name={other.name}
              className="size-11 text-sm ring-2"
            />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{other.name}</p>
              <p className="text-xs text-muted-foreground">{provider ? "Customer" : "Provider"}</p>
            </div>
          </div>
          <dl className="space-y-1.5 text-sm">
            <Fact label="Service" value={`${b.service.name} (${b.service.categoryLabel})`} />
            <Fact label="When" value={whenLabel(b.schedule)} />
            <Fact label="Status" value={<ServiceStatusBadge status={b.status} />} />
            <Fact label="Contact by" value={contact} />
            <Fact
              label="Phone"
              value={
                other.phone ? (
                  <a
                    href={`tel:${other.phone}`}
                    className="font-medium text-primary underline-offset-2 hover:underline"
                  >
                    {other.phone}
                  </a>
                ) : (
                  "Shared once the booking is confirmed"
                )
              }
            />
            {b.details.map((d) => (
              <Fact key={d.label} label={d.label} value={d.value} />
            ))}
          </dl>
          {b.notes && (
            <p className="mt-3 text-sm leading-relaxed whitespace-pre-line text-foreground/80">
              <span className="font-medium">Notes: </span>
              {b.notes}
            </p>
          )}
        </Section>

        <Section title="Location">
          <p className="flex items-start gap-1.5 text-sm">
            <Icon name="map-pin" className="mt-0.5 size-4 shrink-0 text-primary" />
            <span>
              {b.location.address}, {stateLabel(b.location.state)}
            </span>
          </p>
          {b.location.directions && (
            <p className="mt-2 text-xs leading-relaxed whitespace-pre-line text-foreground/70">
              {b.location.directions}
            </p>
          )}
        </Section>

        <Section title="Payment">
          <div className="mb-2">
            <ServicePaymentBadge status={b.paymentStatus} />
          </div>
          <PaymentSummary booking={b} />
          {provider && (
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              What you earn after the platform&rsquo;s commission shows in your wallet once the job is accepted and
              paid.
            </p>
          )}
        </Section>

        <Section title="Progress">
          <ServiceTracker booking={b} />
          <p className="mt-3 text-xs text-muted-foreground">
            Updated by the provider as the job goes on. There&rsquo;s no live location tracking or arrival estimate.
          </p>
        </Section>

        <Section title="History">
          <ServiceHistory booking={b} />
        </Section>
      </div>
    </main>
  );
}
