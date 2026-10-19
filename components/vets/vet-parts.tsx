import Link from "next/link";
import type { ReactNode } from "react";
import { ProfileAvatar } from "@/components/profile/profile-parts";
import { buttonClasses } from "@/components/ui/button";
import { Icon } from "@/components/ui/icons";
import { FARM_TYPE_LABELS } from "@/lib/auth/types";
import { stateLabel } from "@/lib/locations/nigeria";
import { formatSlot, minuteLabel, WEEKDAYS } from "@/lib/vets/schedule";
import {
  BOOKING_STATUS_LABELS,
  isFullyConfirmed,
  VET_STATUS_LABELS,
  type Appointment,
  type AppointmentFarm,
  type AppointmentPaymentStatus,
  type AppointmentSummary,
  type BookingStatus,
  type VetCard,
  type WeeklyHours,
} from "@/lib/vets/types";
import { formatKobo } from "@/lib/wallet/money";

// Pieces shared by the Find a Vet screens. Every status, price and time
// shown comes from the server; nothing here decides one.

const TONES = {
  neutral: "bg-foreground/6 text-foreground/65",
  waiting: "bg-amber-50 text-amber-800",
  good: "bg-accent/12 text-primary",
  bad: "bg-red-50 text-red-700",
} as const;

const STATUS_TONES: Record<BookingStatus, keyof typeof TONES> = {
  requested: "waiting",
  confirmed: "good",
  en_route: "good",
  in_progress: "good",
  completed: "good",
  declined: "bad",
  cancelled: "neutral",
  expired: "neutral",
};

/** The status chip; on the vet's side the labels read from their point of view ("Pending", not "Waiting for the vet"). */
export function BookingBadge({ status, viewer = "customer" }: { status: BookingStatus; viewer?: Appointment["viewer"] }) {
  return (
    <span
      className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold ${TONES[STATUS_TONES[status]]}`}
    >
      {(viewer === "vet" ? VET_STATUS_LABELS : BOOKING_STATUS_LABELS)[status]}
    </span>
  );
}

/** "Layer · 1,200 birds" from the customer's farm record; null when the booking isn't linked to a farm. */
export function flockLabel(farm: AppointmentFarm | null): string | null {
  if (!farm) return null;
  const birds = `${farm.birdCount.toLocaleString("en-NG")} ${farm.birdCount === 1 ? "bird" : "birds"}`;
  return `${FARM_TYPE_LABELS[farm.farmType]} · ${birds}`;
}

export const PAYMENT_LABELS: Record<AppointmentPaymentStatus, string> = {
  not_required: "Nothing to pay",
  payment_required: "Payment not collected in the app",
};

export function PaymentBadge({ status }: { status: AppointmentPaymentStatus }) {
  return (
    <span
      className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold ${TONES[status === "not_required" ? "neutral" : "waiting"]}`}
    >
      {PAYMENT_LABELS[status]}
    </span>
  );
}

/** "From ₦5,000", or a note that a free service is offered. */
export function priceFrom(priceFromNgn: number | null) {
  if (priceFromNgn === null) return null;
  return priceFromNgn === 0 ? "Free service offered" : `From ${formatKobo(priceFromNgn * 100)}`;
}

export const priceLabel = (priceNgn: number) => (priceNgn === 0 ? "Free" : formatKobo(priceNgn * 100));

export const durationLabel = (minutes: number | null) => {
  if (minutes === null) return "Duration varies";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
};

export const placeLabel = (state: VetCard["state"], area: string) =>
  [area, state ? stateLabel(state) : ""].filter(Boolean).join(", ");

/** The vet's review status, worded for what it is: our team's review, not a registry check. */
export function ReviewedBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-accent/12 px-2 py-0.5 text-[0.6875rem] font-semibold text-primary">
      <Icon name="shield-check" className="size-3.5" />
      Credentials reviewed
    </span>
  );
}

export function VetCardView({ vet, href }: { vet: VetCard; href: string }) {
  const place = placeLabel(vet.state, vet.area);
  const price = priceFrom(vet.priceFromNgn);
  return (
    <article aria-labelledby={`vet-${vet.id}`} className="rounded-3xl bg-white p-4 shadow-sm ring-1 ring-foreground/5">
      <div className="flex gap-3">
        <ProfileAvatar photoUrl={vet.photoUrl} name={vet.name} className="size-14 text-base ring-2" />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 id={`vet-${vet.id}`} className="min-w-0 truncate text-[0.9375rem] font-semibold">
              {vet.name}
            </h3>
            {price && <span className="shrink-0 text-xs font-semibold text-primary">{price}</span>}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {[vet.specialization, vet.yearsOfExperience !== null ? `${vet.yearsOfExperience} yrs experience` : null]
              .filter(Boolean)
              .join(" · ") || "Veterinarian"}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <ReviewedBadge />
            {vet.serviceTypes.slice(0, 2).map((t) => (
              <span key={t} className="rounded-full bg-foreground/5 px-2 py-0.5 text-[0.6875rem] text-foreground/70">
                {t}
              </span>
            ))}
            {vet.serviceTypes.length > 2 && (
              <span className="text-[0.6875rem] text-muted-foreground">+{vet.serviceTypes.length - 2} more</span>
            )}
          </div>
          {place && (
            <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
              <Icon name="map-pin" className="size-3.5 shrink-0" />
              <span className="truncate">{place}</span>
            </p>
          )}
          <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
            <Icon name="clock" className="size-3.5 shrink-0" />
            {vet.nextOpenSlot ? `Next open time: ${formatSlot(vet.nextOpenSlot)}` : "No open times in the next 14 days"}
          </p>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Link
          href={href}
          className={buttonClasses("outline", "h-10 text-sm")}
          aria-label={`View ${vet.name}'s profile`}
        >
          View profile
        </Link>
        <Link href={`${href}/book`} className={buttonClasses("solid", "h-10 text-sm")} aria-label={`Book ${vet.name}`}>
          Book now
        </Link>
      </div>
    </article>
  );
}

export function HoursList({ hours }: { hours: WeeklyHours }) {
  if (hours.length === 0) return <p className="text-sm text-muted-foreground">No working hours set.</p>;
  return (
    <dl className="space-y-1.5 text-sm">
      {hours.map((h) => (
        <div key={h.day} className="flex justify-between gap-3">
          <dt className="text-muted-foreground">{WEEKDAYS[h.day]}</dt>
          <dd className="tabular-nums">
            {minuteLabel(h.start)}–{minuteLabel(h.end)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The service amount, any fee (none is configured), the total, and how payment stands. */
export function PriceBreakdown({
  priceKobo,
  feeKobo,
  totalKobo,
  paymentStatus,
}: {
  priceKobo: number;
  feeKobo: number;
  totalKobo: number;
  paymentStatus: AppointmentPaymentStatus;
}) {
  return (
    <div className="space-y-1.5 text-sm">
      <p className="flex justify-between">
        <span className="text-muted-foreground">Service</span>
        <span className="tabular-nums">{priceKobo === 0 ? "Free" : formatKobo(priceKobo)}</span>
      </p>
      <p className="flex justify-between">
        <span className="text-muted-foreground">Booking fee</span>
        <span className="tabular-nums">{feeKobo === 0 ? "None" : formatKobo(feeKobo)}</span>
      </p>
      <p className="flex justify-between border-t border-foreground/8 pt-1.5 font-semibold">
        <span>Total</span>
        <span className="tabular-nums">{formatKobo(totalKobo)}</span>
      </p>
      <p className="pt-1 text-xs leading-relaxed text-muted-foreground">
        {paymentStatus === "not_required"
          ? "Nothing to pay for this service."
          : "Payment isn't collected in the app. Nothing is charged when you book; agree how to pay with the vet once they accept."}
      </p>
    </div>
  );
}

/**
 * What the booking amounts to right now. "Booking confirmed" appears only
 * when the vet has accepted and nothing is left to pay.
 */
export function bookingHeadline(a: Pick<Appointment, "bookingStatus" | "paymentStatus" | "viewer">): {
  title: string;
  detail: string;
  tone: keyof typeof TONES;
} {
  const vet = a.viewer === "vet";
  switch (a.bookingStatus) {
    case "requested":
      return vet
        ? {
            title: "New request",
            detail: "Accept or decline before the time to respond runs out.",
            tone: "waiting",
          }
        : {
            title: "Request sent",
            detail: "Waiting for the vet to accept. This isn't a confirmed booking yet.",
            tone: "waiting",
          };
    case "confirmed":
    case "en_route":
    case "in_progress":
      if (isFullyConfirmed(a))
        return {
          title: a.bookingStatus === "confirmed" ? "Booking confirmed" : BOOKING_STATUS_LABELS[a.bookingStatus],
          detail: "The vet accepted this visit.",
          tone: "good",
        };
      return {
        title: BOOKING_STATUS_LABELS[a.bookingStatus],
        detail: "The vet accepted. Payment for this service isn't collected in the app.",
        tone: "good",
      };
    case "completed":
      return {
        title: "Completed",
        detail: "The vet marked this visit as done.",
        tone: "good",
      };
    case "declined":
      return {
        title: "Declined",
        detail: "The vet couldn't take this visit. Nothing was charged.",
        tone: "bad",
      };
    case "cancelled":
      return {
        title: "Cancelled",
        detail: "This visit was cancelled. Nothing was charged.",
        tone: "neutral",
      };
    case "expired":
      return {
        title: "Not answered in time",
        detail: "The vet didn't respond before the deadline, so the request lapsed. Nothing was charged.",
        tone: "neutral",
      };
  }
}

const ICON_TONES: Record<keyof typeof TONES, string> = {
  neutral: "text-foreground/60",
  waiting: "text-amber-800",
  good: "text-primary",
  bad: "text-red-700",
};

export function Headline({ appointment }: { appointment: Appointment }) {
  const h = bookingHeadline(appointment);
  const icon = h.tone === "good" ? "check-circle" : h.tone === "waiting" ? "clock" : "alert-circle";
  return (
    <section
      role="status"
      className={`flex gap-3 rounded-3xl px-4 py-4 ring-1 ring-foreground/5 ${h.tone === "good" ? "bg-accent/10" : h.tone === "waiting" ? "bg-amber-50" : h.tone === "bad" ? "bg-red-50" : "bg-white"}`}
    >
      <Icon name={icon} className={`mt-0.5 size-6 shrink-0 ${ICON_TONES[h.tone]}`} />
      <div>
        <h2 className="text-base font-semibold">{h.title}</h2>
        <p className="mt-0.5 text-sm leading-relaxed text-foreground/75">{h.detail}</p>
        <p className="mt-1 font-mono text-[0.6875rem] text-muted-foreground">{appointment.reference}</p>
      </div>
    </section>
  );
}

const STEPS: { status: BookingStatus; label: string }[] = [
  { status: "requested", label: "Requested" },
  { status: "confirmed", label: "Accepted" },
  { status: "en_route", label: "On the way" },
  { status: "in_progress", label: "In progress" },
  { status: "completed", label: "Completed" },
];

/**
 * Progress through the visit, from the recorded history only. "On the way"
 * is the vet's own update: there is no live location or arrival estimate.
 */
export function Tracker({ appointment }: { appointment: Appointment }) {
  const reached = new Map(appointment.history.map((h) => [h.status, h.at]));
  const ended = ["declined", "cancelled", "expired"].includes(appointment.bookingStatus);
  return (
    <ol className="space-y-3">
      {STEPS.map((step) => {
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
          <span className="font-medium">{BOOKING_STATUS_LABELS[appointment.bookingStatus]}</span>
          {reached.get(appointment.bookingStatus) && (
            <span className="ml-auto text-xs text-muted-foreground">
              {formatSlot(reached.get(appointment.bookingStatus)!)}
            </span>
          )}
        </li>
      )}
    </ol>
  );
}

const ACTORS = {
  customer: "Customer",
  vet: "Vet",
  system: "Automatically",
} as const;

export function History({ appointment }: { appointment: Appointment }) {
  return (
    <ul className="space-y-2.5">
      {[...appointment.history].reverse().map((h, i) => (
        <li key={`${h.at}-${i}`} className="text-sm">
          <p className="flex justify-between gap-3">
            <span className="font-medium">{BOOKING_STATUS_LABELS[h.status]}</span>
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

export function AppointmentRow({ appointment: a, href }: { appointment: AppointmentSummary; href: string }) {
  return (
    <li>
      <Link
        href={href}
        className="flex items-start gap-3 px-4 py-3.5 outline-none transition-colors hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/8 text-primary">
          <Icon name="stethoscope" className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{a.serviceName}</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {a.viewer === "customer" ? `With ${a.otherParty}` : `For ${a.otherParty}`} · {formatSlot(a.startsAt)}
          </p>
          <p className="mt-0.5 font-mono text-[0.6875rem] text-muted-foreground">{a.reference}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-sm font-semibold tabular-nums">
            {a.totalKobo === 0 ? "Free" : formatKobo(a.totalKobo)}
          </span>
          <BookingBadge status={a.bookingStatus} viewer={a.viewer} />
        </div>
      </Link>
    </li>
  );
}

/**
 * One job on the vet's list: who and where, what and when, the flock from
 * the customer's farm record and the status. No distance or arrival time:
 * the app doesn't know either.
 */
export function JobCard({ job, href }: { job: AppointmentSummary; href: string }) {
  const flock = flockLabel(job.farm);
  return (
    <li className="rounded-3xl bg-white px-4 py-4 shadow-sm ring-1 ring-foreground/5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[0.6875rem] text-muted-foreground">{job.reference}</p>
          <h3 className="mt-0.5 truncate text-sm font-semibold">{job.otherParty}</h3>
          {job.farmName && <p className="truncate text-xs text-muted-foreground">{job.farmName}</p>}
        </div>
        <BookingBadge status={job.bookingStatus} viewer="vet" />
      </div>
      <dl className="mt-3 space-y-1.5 text-xs">
        <div className="flex items-start gap-2">
          <dt className="sr-only">Service</dt>
          <Icon name="stethoscope" className="size-4 shrink-0 text-primary" />
          <dd className="min-w-0 truncate">{job.serviceName}</dd>
        </div>
        <div className="flex items-start gap-2">
          <dt className="sr-only">When</dt>
          <Icon name="calendar" className="size-4 shrink-0 text-primary" />
          <dd>{formatSlot(job.startsAt)}</dd>
        </div>
        <div className="flex items-start gap-2">
          <dt className="sr-only">Flock</dt>
          <Icon name="egg" className="size-4 shrink-0 text-primary" />
          <dd className={flock ? "" : "text-muted-foreground"}>{flock ?? "Flock details not linked"}</dd>
        </div>
      </dl>
      <Link
        href={href}
        className={buttonClasses("outline", "mt-3")}
        aria-label={`View details of ${job.reference}, ${job.serviceName} for ${job.otherParty}`}
      >
        View details
      </Link>
    </li>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-3xl bg-white px-4 py-4 shadow-sm ring-1 ring-foreground/5">
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}
