import Link from "next/link";
import type { ReactNode } from "react";
import { ProfileAvatar } from "@/components/profile/profile-parts";
import { buttonClasses } from "@/components/ui/button";
import { Icon } from "@/components/ui/icons";
import { durationLabel } from "@/components/vets/vet-parts";
import { stateLabel, type NigerianState } from "@/lib/locations/nigeria";
import {
  SERVICE_BOOKING_STATUS_LABELS,
  SERVICE_PAYMENT_STATUS_LABELS,
  timeWindowLabel,
  type ServiceBooking,
  type ServiceBookingEvent,
  type ServiceBookingStatus,
  type ServiceBookingSummary,
  type ServiceCard,
  type ServicePaymentStatus,
} from "@/lib/services/marketplace";
import { formatDay, formatSlot } from "@/lib/vets/schedule";
import { formatKobo } from "@/lib/wallet/money";

// Pieces shared by the Other Services screens. Every status, price and time
// shown comes from the server; nothing here decides one. There are no
// ratings, job counts, distances or arrival times: nothing records them.

export { Section } from "@/components/vets/vet-parts";

const TONES = {
  neutral: "bg-foreground/6 text-foreground/65",
  waiting: "bg-amber-50 text-amber-800",
  good: "bg-accent/12 text-primary",
  bad: "bg-red-50 text-red-700",
} as const;
type Tone = keyof typeof TONES;

const STATUS_TONES: Record<ServiceBookingStatus, Tone> = {
  requested: "waiting",
  quote_offered: "waiting",
  awaiting_payment: "waiting",
  confirmed: "good",
  provider_en_route: "good",
  in_progress: "good",
  completed: "good",
  declined: "bad",
  cancelled: "neutral",
  expired: "neutral",
};

const PAYMENT_TONES: Record<ServicePaymentStatus, Tone> = {
  none: "neutral",
  pending: "waiting",
  failed: "bad",
  paid: "good",
  refund_pending: "waiting",
  refunded: "neutral",
  refund_failed: "bad",
};

const badgeClass = "inline-flex shrink-0 rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold";

export function ServiceStatusBadge({ status }: { status: ServiceBookingStatus }) {
  return (
    <span className={`${badgeClass} ${TONES[STATUS_TONES[status]]}`}>{SERVICE_BOOKING_STATUS_LABELS[status]}</span>
  );
}

export function ServicePaymentBadge({ status }: { status: ServicePaymentStatus }) {
  return (
    <span className={`${badgeClass} ${TONES[PAYMENT_TONES[status]]}`}>{SERVICE_PAYMENT_STATUS_LABELS[status]}</span>
  );
}

/** "₦45,000" for a fixed price, otherwise "Quote required". */
export const servicePrice = (s: Pick<ServiceCard, "pricing" | "priceNgn">) =>
  s.pricing === "fixed" && s.priceNgn !== null ? formatKobo(s.priceNgn * 100) : "Quote required";

/** "Oyo, Lagos" or "Oyo, Lagos +3 more". */
export function statesSummary(states: readonly NigerianState[], shown = 3) {
  if (states.length === 0) return "";
  const names = states.slice(0, shown).map(stateLabel).join(", ");
  return states.length > shown ? `${names} +${states.length - shown} more` : names;
}

/** Shown only when an admin approved credentials the provider submitted. */
export function CredentialsBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-accent/12 px-2 py-0.5 text-[0.6875rem] font-semibold text-primary">
      <Icon name="shield-check" className="size-3.5" />
      Credentials reviewed
    </span>
  );
}

export const bookLabel = (pricing: ServiceCard["pricing"]) => (pricing === "quote" ? "Request quote" : "Book now");

export function ServiceCardView({ service: s }: { service: ServiceCard }) {
  const href = `/services/${s.id}`;
  const states = statesSummary(s.serviceStates);
  return (
    <article
      aria-labelledby={`service-${s.id}`}
      className="rounded-3xl bg-white p-4 shadow-sm ring-1 ring-foreground/5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[0.6875rem] font-semibold tracking-wide text-primary uppercase">{s.categoryLabel}</p>
          <h3 id={`service-${s.id}`} className="mt-0.5 text-[0.9375rem] font-semibold">
            {s.name}
          </h3>
        </div>
        <span className="shrink-0 text-sm font-semibold text-primary tabular-nums">{servicePrice(s)}</span>
      </div>
      <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-foreground/75">{s.description}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {states && (
          <span className="flex items-center gap-1">
            <Icon name="map-pin" className="size-3.5 shrink-0" />
            {states}
          </span>
        )}
        <span className="flex items-center gap-1">
          <Icon name="clock" className="size-3.5 shrink-0" />
          {durationLabel(s.durationMinutes)}
        </span>
      </div>
      <Link
        href={`/services/providers/${s.provider.id}`}
        className="mt-3 flex items-center gap-2 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <ProfileAvatar photoUrl={s.provider.photoUrl} name={s.provider.name} className="size-8 text-xs ring-1" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium hover:underline">{s.provider.name}</span>
          <span className="block text-[0.6875rem] text-muted-foreground">{s.provider.roleLabel}</span>
        </span>
        {s.provider.credentialsVerified && <CredentialsBadge />}
      </Link>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Link href={href} className={buttonClasses("outline", "h-10 text-sm")} aria-label={`View ${s.name}`}>
          View
        </Link>
        <Link
          href={`${href}/book`}
          className={buttonClasses("solid", "h-10 text-sm")}
          aria-label={`${bookLabel(s.pricing)}: ${s.name}`}
        >
          {bookLabel(s.pricing)}
        </Link>
      </div>
    </article>
  );
}

export function CardSkeletons({ label = "Loading services" }: { label?: string }) {
  return (
    <ul aria-busy="true" aria-label={label} className="flex flex-col gap-3">
      {Array.from({ length: 4 }, (_, i) => (
        <li key={i} className="animate-pulse space-y-2 rounded-3xl bg-white p-4 shadow-sm ring-1 ring-foreground/5">
          <div className="h-3 w-24 rounded-full bg-foreground/8" />
          <div className="h-4 w-48 rounded-full bg-foreground/8" />
          <div className="h-3 w-full rounded-full bg-foreground/6" />
          <div className="h-3 w-2/3 rounded-full bg-foreground/6" />
        </li>
      ))}
    </ul>
  );
}

export function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right break-words">{value}</dd>
    </div>
  );
}

export const whenLabel = (b: Pick<ServiceBooking["schedule"], "date" | "window">) =>
  `${formatDay(b.date)}, ${timeWindowLabel(b.window)}`;

// --- one booking -----------------------------------------------------------------------

/**
 * What the booking amounts to right now. "Confirmed" appears only when the
 * provider has taken the job and the payment is confirmed by Paystack
 * through the server.
 */
export function serviceHeadline(b: ServiceBooking): { title: string; detail: string; tone: Tone } {
  const provider = b.viewer === "provider";
  const quote = b.service.pricing === "quote";
  switch (b.status) {
    case "awaiting_payment":
      return provider
        ? {
            title: "Waiting for payment",
            detail: quote
              ? "The customer accepted your quote. The job is confirmed once their payment goes through."
              : "The customer hasn't paid yet. You'll be asked to accept once they have.",
            tone: "waiting",
          }
        : {
            title: "Payment needed",
            detail: quote
              ? "You accepted the quote. Pay to confirm the booking."
              : "Pay to send your request to the provider. Nothing is booked until payment is confirmed.",
            tone: "waiting",
          };
    case "requested":
      if (provider)
        return {
          title: "New request",
          detail: quote
            ? "Send a quote or decline before the time to respond runs out."
            : "The customer has paid. Accept or decline before the time to respond runs out.",
          tone: "waiting",
        };
      return {
        title: quote ? "Quote requested" : "Paid — waiting for the provider",
        detail: quote
          ? "The provider will send a price. Nothing is charged until you accept a quote and pay."
          : "Your payment is confirmed. If the provider declines or doesn't answer in time, you get a full refund.",
        tone: "waiting",
      };
    case "quote_offered":
      return provider
        ? { title: "Quote sent", detail: "Waiting for the customer to accept or reject it.", tone: "waiting" }
        : {
            title: "Quote received",
            detail: "Accept it to pay and confirm the booking, or reject it.",
            tone: "waiting",
          };
    case "confirmed":
      return {
        title: "Booking confirmed",
        detail: provider ? "The customer has paid and the job is yours." : "Paid, and the provider has taken the job.",
        tone: "good",
      };
    case "provider_en_route":
      return {
        title: "Provider on the way",
        detail: "The provider said they've set off. There's no live location or arrival time.",
        tone: "good",
      };
    case "in_progress":
      return { title: "In progress", detail: "The provider has started the job.", tone: "good" };
    case "completed":
      return { title: "Completed", detail: "The provider marked this job as done.", tone: "good" };
    case "declined":
      return { title: "Declined", detail: refundDetail(b, "The provider couldn't take this job."), tone: "bad" };
    case "cancelled":
      return { title: "Cancelled", detail: refundDetail(b, "This booking was cancelled."), tone: "neutral" };
    case "expired":
      return {
        title: "Lapsed",
        detail: refundDetail(b, "Nobody acted in time, so this booking lapsed."),
        tone: "neutral",
      };
  }
}

function refundDetail(b: ServiceBooking, first: string) {
  switch (b.paymentStatus) {
    case "refunded":
      return `${first} ${formatKobo(b.refundedKobo)} was refunded.`;
    case "refund_pending":
      return `${first} A full refund is on its way.`;
    case "refund_failed":
      return `${first} The refund hasn't gone through yet. Our team has been alerted.`;
    case "paid":
      return `${first} A refund is being arranged.`;
    default:
      return `${first} Nothing was charged.`;
  }
}

const ICON_TONES: Record<Tone, string> = {
  neutral: "text-foreground/60",
  waiting: "text-amber-800",
  good: "text-primary",
  bad: "text-red-700",
};

export function ServiceHeadline({ booking }: { booking: ServiceBooking }) {
  const h = serviceHeadline(booking);
  const icon = h.tone === "good" ? "check-circle" : h.tone === "waiting" ? "clock" : "alert-circle";
  return (
    <section
      role="status"
      className={`flex gap-3 rounded-3xl px-4 py-4 ring-1 ring-foreground/5 ${h.tone === "good" ? "bg-accent/10" : h.tone === "waiting" ? "bg-amber-50" : h.tone === "bad" ? "bg-red-50" : "bg-white"}`}
    >
      <Icon name={icon} className={`mt-0.5 size-6 shrink-0 ${ICON_TONES[h.tone]}`} />
      <div className="min-w-0">
        <h2 className="text-base font-semibold">{h.title}</h2>
        <p className="mt-0.5 text-sm leading-relaxed text-foreground/75">{h.detail}</p>
        <p className="mt-1 font-mono text-[0.6875rem] text-muted-foreground">Ref: {booking.reference}</p>
      </div>
    </section>
  );
}

/** The agreed price, the booking fee (none), and what's been paid and refunded. */
export function PaymentSummary({ booking: b }: { booking: ServiceBooking }) {
  return (
    <div className="space-y-1.5 text-sm">
      <p className="flex justify-between gap-3">
        <span className="text-muted-foreground">Service</span>
        <span className="tabular-nums">
          {b.amountKobo !== null
            ? formatKobo(b.amountKobo)
            : b.quote
              ? formatKobo(b.quote.amountKobo)
              : "Quote pending"}
        </span>
      </p>
      <p className="flex justify-between gap-3">
        <span className="text-muted-foreground">Booking fee</span>
        <span>None</span>
      </p>
      {b.amountKobo !== null && (
        <p className="flex justify-between gap-3 border-t border-foreground/8 pt-1.5 font-semibold">
          <span>Total</span>
          <span className="tabular-nums">{formatKobo(b.amountKobo)}</span>
        </p>
      )}
      {b.paidKobo > 0 && (
        <p className="flex justify-between gap-3">
          <span className="text-muted-foreground">Paid</span>
          <span className="tabular-nums">{formatKobo(b.paidKobo)}</span>
        </p>
      )}
      {b.refundedKobo > 0 && (
        <p className="flex justify-between gap-3">
          <span className="text-muted-foreground">Refunded</span>
          <span className="tabular-nums">{formatKobo(b.refundedKobo)}</span>
        </p>
      )}
    </div>
  );
}

const STEPS: { status: ServiceBookingStatus | "paid"; label: string; quoteOnly?: true }[] = [
  { status: "requested", label: "Requested" },
  { status: "quote_offered", label: "Quote sent", quoteOnly: true },
  { status: "paid", label: "Paid" },
  { status: "confirmed", label: "Confirmed" },
  { status: "provider_en_route", label: "On the way" },
  { status: "in_progress", label: "In progress" },
  { status: "completed", label: "Completed" },
];

const ENDED: readonly ServiceBookingStatus[] = ["declined", "cancelled", "expired"];

/**
 * Progress through the job, from the recorded history only. "On the way" is
 * the provider's own update: there is no live location or arrival estimate.
 */
export function ServiceTracker({ booking }: { booking: ServiceBooking }) {
  const reached = new Map<string, string>();
  for (const h of booking.history) if (!reached.has(h.event)) reached.set(h.event, h.at);
  // a fixed-price request starts as awaiting payment
  if (!reached.has("requested") && booking.history[0]) reached.set("requested", booking.history[0].at);
  const steps = STEPS.filter((s) => !s.quoteOnly || booking.service.pricing === "quote");
  const ended = ENDED.includes(booking.status);
  return (
    <ol className="space-y-3">
      {steps.map((step) => {
        const at = reached.get(step.status);
        return (
          <li key={step.status} className="flex items-center gap-3 text-sm">
            <span
              aria-hidden="true"
              className={`flex size-6 shrink-0 items-center justify-center rounded-full ${at ? "bg-primary text-primary-foreground" : "bg-foreground/8 text-foreground/40"}`}
            >
              {at ? <Icon name="check" className="size-3.5" /> : null}
            </span>
            <span className={at ? "font-medium" : "text-muted-foreground"}>
              {step.label}
              <span className="sr-only">{at ? " (done)" : " (not yet)"}</span>
            </span>
            {at && <span className="ml-auto text-xs text-muted-foreground">{formatSlot(at)}</span>}
          </li>
        );
      })}
      {ended && (
        <li className="flex items-center gap-3 text-sm">
          <span
            aria-hidden="true"
            className="flex size-6 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-700"
          >
            <Icon name="x" className="size-3.5" />
          </span>
          <span className="font-medium">{SERVICE_BOOKING_STATUS_LABELS[booking.status]}</span>
          {reached.get(booking.status) && (
            <span className="ml-auto text-xs text-muted-foreground">{formatSlot(reached.get(booking.status)!)}</span>
          )}
        </li>
      )}
    </ol>
  );
}

const EVENT_LABELS: Record<ServiceBookingEvent, string> = {
  ...SERVICE_BOOKING_STATUS_LABELS,
  requested: "Request sent to the provider",
  awaiting_payment: "Waiting for payment",
  paid: "Payment confirmed",
  payment_failed: "Payment failed",
  refund_processed: "Refund processed",
  refund_failed: "Refund didn't go through",
  late_payment_refunded: "Late payment refunded",
};

const ACTORS = { customer: "Customer", provider: "Provider", system: "Automatically" } as const;

export function ServiceHistory({ booking }: { booking: ServiceBooking }) {
  return (
    <ul className="space-y-2.5">
      {[...booking.history].reverse().map((h, i) => (
        <li key={`${h.at}-${i}`} className="text-sm">
          <p className="flex justify-between gap-3">
            <span className="font-medium">{EVENT_LABELS[h.event]}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{formatSlot(h.at)}</span>
          </p>
          <p className="text-xs text-muted-foreground">
            {ACTORS[h.by]}
            {h.note ? ` · “${h.note}”` : ""}
          </p>
        </li>
      ))}
    </ul>
  );
}

export function ServiceBookingRow({ booking: b, href }: { booking: ServiceBookingSummary; href: string }) {
  return (
    <li>
      <Link
        href={href}
        className="flex items-start gap-3 px-4 py-3.5 outline-none transition-colors hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/8 text-primary">
          <Icon name="wrench" className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{b.serviceName}</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {b.viewer === "customer" ? `With ${b.otherParty}` : `For ${b.otherParty}`} · {formatDay(b.date)}
          </p>
          <p className="mt-0.5 font-mono text-[0.6875rem] text-muted-foreground">{b.reference}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-sm font-semibold tabular-nums">
            {b.amountKobo !== null ? formatKobo(b.amountKobo) : "Quote"}
          </span>
          <ServiceStatusBadge status={b.status} />
        </div>
      </Link>
    </li>
  );
}
