"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { FormAlert } from "@/components/auth/auth-screen";
import { ProfileAvatar } from "@/components/profile/profile-parts";
import { Button, buttonClasses } from "@/components/ui/button";
import { SelectField, TextAreaField, TextField } from "@/components/ui/field";
import { Icon, type IconName } from "@/components/ui/icons";
import { FARM_TYPE_LABELS, type FarmType } from "@/lib/auth/types";
import { NIGERIAN_STATES, stateLabel, type NigerianState } from "@/lib/locations/nigeria";
import { bookAppointment, getSlots } from "@/lib/vets/api";
import { addDays, formatDay, formatSlot, lagosDate, lagosMinute, lastBookableDate, weekday } from "@/lib/vets/schedule";
import { isFullyConfirmed, type Appointment, type VetProfile } from "@/lib/vets/types";
import {
  bookingHeadline,
  BookingBadge,
  durationLabel,
  PaymentBadge,
  PriceBreakdown,
  priceLabel,
  ReviewedBadge,
  Section,
} from "./vet-parts";

export type FarmOption = {
  id: string;
  farmName: string;
  location: string;
  state: NigerianState | null;
  farmType: FarmType;
  birdCount: number;
};

type Step = "service" | "time" | "location" | "review" | "done";
const STEPS: { key: Step; title: string }[] = [
  { key: "service", title: "Book Appointment" },
  { key: "time", title: "Book Appointment" },
  { key: "location", title: "Confirm Location" },
  { key: "review", title: "Review & Confirm" },
  { key: "done", title: "Request Sent" },
];

const OTHER = "other";
const NOON = 12 * 60;
const WEEK_HEADINGS = ["M", "T", "W", "T", "F", "S", "S"];

const SERVICE_ICONS: Record<string, IconName> = {
  Consultation: "stethoscope",
  Vaccination: "shield-check",
  "Biosecurity Audit": "shield-check",
  "Disease Diagnosis & Advisory": "search",
  "Routine Flock Health Check": "egg",
  "Post-mortem & Lab Referral": "list",
  "Emergency Farm Visit": "alert-circle",
};

const newKey = () => crypto.randomUUID();

/**
 * Booking a vet: service, date and time, the farm's location and a review,
 * then the request as the server recorded it. Nothing here is trusted by
 * the server: the vet, price and status are decided there, and the chosen
 * time is checked again (here on Continue, and there when the request is
 * sent). Sending the same request twice (a double tap, a retry after a
 * dropped connection) books once: it carries one idempotency key.
 */
export function BookingWizard({
  vet,
  initialServiceId,
  farms,
}: {
  vet: VetProfile;
  initialServiceId: string | null;
  farms: FarmOption[];
}) {
  const today = lagosDate(new Date());
  const last = lastBookableDate(new Date());
  const [step, setStep] = useState<Step>(initialServiceId ? "time" : "service");
  const [serviceId, setServiceId] = useState<string | null>(initialServiceId);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [date, setDate] = useState<string | null>(null);
  const [slots, setSlots] = useState<string[] | null>(null);
  const [slotsError, setSlotsError] = useState<string | null>(null);
  const [startsAt, setStartsAt] = useState<string | null>(null);
  const [farmId, setFarmId] = useState<string>(farms[0]?.id ?? OTHER);
  const [changingFarm, setChangingFarm] = useState(farms.length === 0);
  const [farmName, setFarmName] = useState("");
  const [address, setAddress] = useState(farms[0]?.location ?? "");
  const [state, setState] = useState<string>(farms[0]?.state ?? "");
  const [directions, setDirections] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(newKey);
  const [booked, setBooked] = useState<Appointment | null>(null);
  const seq = useRef(0);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const service = vet.services.find((s) => s.id === serviceId) ?? null;
  const workDays = new Set(vet.workingHours.map((h) => h.day));
  const farm = farms.find((f) => f.id === farmId) ?? null;

  useEffect(() => headingRef.current?.focus(), [step]);

  /** One day's open times; only the newest request's answer is kept. */
  function fetchDay(day: string, forService: string) {
    const id = ++seq.current;
    setSlots(null);
    setSlotsError(null);
    return getSlots(vet.id, forService, day).then((res) => {
      if (id !== seq.current) return null;
      if (!res.ok) {
        setSlotsError(res.error);
        return null;
      }
      const open = res.data.days.find((d) => d.date === day)?.slots ?? [];
      setSlots(open);
      return open;
    });
  }

  function chooseService(id: string) {
    if (id === serviceId) return;
    setServiceId(id);
    setDate(null);
    setSlots(null);
    setSlotsError(null);
    setStartsAt(null);
    setKey(newKey());
    setMessage(null);
  }

  function chooseDate(day: string) {
    if (!serviceId) return;
    setDate(day);
    setStartsAt(null);
    setMessage(null);
    void fetchDay(day, serviceId);
  }

  function chooseSlot(iso: string) {
    if (iso !== startsAt) setKey(newKey());
    setStartsAt(iso);
    setMessage(null);
  }

  /** The chosen time is checked again before moving on: someone else may have just booked it. */
  async function confirmTime() {
    if (!serviceId || !date || !startsAt) return setMessage("Choose a time to continue.");
    setBusy(true);
    const chosen = startsAt;
    const fresh = await fetchDay(date, serviceId);
    setBusy(false);
    if (!fresh) return;
    if (!fresh.includes(chosen)) {
      setStartsAt(null);
      return setMessage("That time is no longer available. Please choose another.");
    }
    setStartsAt(chosen);
    setMessage(null);
    setStep("location");
  }

  function checkLocation() {
    const next: Record<string, string> = {};
    if (address.trim().length < 5 || address.trim().length > 160)
      next["location.address"] = "Enter the farm's address or nearest landmark (5–160 characters).";
    if (!state) next["location.state"] = "Choose the farm's state.";
    if (directions.length > 300) next["location.directions"] = "Keep notes to 300 characters.";
    if (farmId === OTHER && farmName.length > 80) next["location.farmName"] = "Keep the farm name to 80 characters.";
    setErrors(next);
    if (Object.keys(next).length > 0) return setChangingFarm(true);
    setStep("review");
  }

  function pickFarm(id: string) {
    setFarmId(id);
    const picked = farms.find((f) => f.id === id);
    if (picked) {
      setAddress(picked.location);
      setState(picked.state ?? "");
    }
  }

  async function submit() {
    if (!service || !startsAt) return;
    setBusy(true);
    setMessage(null);
    const res = await bookAppointment({
      serviceId: service.id,
      startsAt,
      farmId: farmId === OTHER ? null : farmId,
      location: {
        farmName: farmId === OTHER ? farmName : undefined,
        address,
        state: state as NigerianState,
        directions,
      },
      idempotencyKey: key,
    });
    setBusy(false);
    if (res.ok) {
      setBooked(res.data.appointment);
      setStep("done");
      return;
    }
    setMessage(res.error);
    if (res.fieldErrors) {
      setErrors(res.fieldErrors);
      if (Object.keys(res.fieldErrors).some((k) => k.startsWith("location") || k === "farmId")) {
        setChangingFarm(true);
        setStep("location");
      }
    } else if (/no longer available/.test(res.error)) {
      // someone else got there first: pick again (a new time is a new request)
      setStartsAt(null);
      setKey(newKey());
      if (date && serviceId) void fetchDay(date, serviceId);
      setStep("time");
    }
  }

  const index = STEPS.findIndex((s) => s.key === step);
  const percent = Math.round(((index + 1) / STEPS.length) * 100);

  if (step === "done" && booked) return <Confirmation appointment={booked} headingRef={headingRef} />;

  return (
    <div className="flex flex-1 flex-col px-5 pb-8">
      <div className="mb-4">
        <div className="mb-1.5 flex justify-between text-xs">
          <span className="font-semibold text-primary">
            Step {index + 1} of {STEPS.length}
          </span>
          <span className="text-muted-foreground">{percent}% complete</span>
        </div>
        <div
          role="progressbar"
          aria-label="Booking progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-1.5 rounded-full bg-foreground/8"
        >
          <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
        </div>
      </div>

      {message && (
        <div className="mb-3">
          <FormAlert>{message}</FormAlert>
        </div>
      )}

      {step === "service" && (
        <section aria-labelledby="step-heading" className="flex flex-col gap-3">
          <StepHeading headingRef={headingRef} title="Select service type">
            Choose the service you need from {vet.name}.
          </StepHeading>
          <div role="radiogroup" aria-labelledby="step-heading" className="flex flex-col gap-2.5">
            {vet.services.map((s) => {
              const selected = s.id === serviceId;
              return (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => chooseService(s.id)}
                  className={`flex w-full items-start gap-3 rounded-2xl px-4 py-3.5 text-left ring-1 outline-none focus-visible:ring-2 focus-visible:ring-accent ${selected ? "bg-primary/5 ring-2 ring-primary" : "bg-white ring-foreground/8 hover:bg-primary/5"}`}
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/8 text-primary">
                    <Icon name={SERVICE_ICONS[s.categoryLabel] ?? "stethoscope"} className="size-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold">{s.name}</span>
                    <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">{s.description}</span>
                    <span className="mt-1 block text-xs">
                      <span className="font-semibold text-primary tabular-nums">{priceLabel(s.priceNgn)}</span>
                      <span className="text-muted-foreground"> · {durationLabel(s.durationMinutes)}</span>
                    </span>
                  </span>
                  <span
                    aria-hidden="true"
                    className={`mt-1 flex size-5 shrink-0 items-center justify-center rounded-full ring-2 ${selected ? "ring-primary" : "ring-foreground/25"}`}
                  >
                    {selected && <span className="size-2.5 rounded-full bg-primary" />}
                  </span>
                </button>
              );
            })}
          </div>
          <Button type="button" className="mt-2" disabled={!service} onClick={() => setStep("time")}>
            Continue
          </Button>
        </section>
      )}

      {step === "time" && service && (
        <section aria-labelledby="step-heading" className="flex flex-col gap-3">
          <StepHeading headingRef={headingRef} title="Select date & time">
            {service.name} · {durationLabel(service.durationMinutes)}. Times are Lagos time and need at least 2
            hours&rsquo; notice.
          </StepHeading>

          <MonthCalendar
            month={month}
            onMonth={setMonth}
            today={today}
            last={last}
            selected={date}
            isWorkDay={(d) => workDays.has(weekday(d))}
            onSelect={chooseDate}
          />

          {!date ? (
            <p className="text-sm text-muted-foreground">Choose a day to see its open times.</p>
          ) : slotsError ? (
            <div role="alert" className="rounded-2xl bg-white px-4 py-5 text-center ring-1 ring-foreground/8">
              <p className="text-sm">{slotsError}</p>
              <Button
                type="button"
                variant="outline"
                className="mx-auto mt-3 h-10 w-auto px-5 text-sm"
                onClick={() => void fetchDay(date, service.id)}
              >
                Try again
              </Button>
            </div>
          ) : !slots ? (
            <div aria-busy="true" aria-label="Loading open times" className="grid animate-pulse grid-cols-4 gap-2">
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="h-10 rounded-xl bg-foreground/6" />
              ))}
            </div>
          ) : slots.length === 0 ? (
            <p className="rounded-2xl bg-white px-4 py-5 text-center text-sm text-muted-foreground ring-1 ring-foreground/8">
              No open times on {formatDay(date)}. Try another day.
            </p>
          ) : (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">Available time slots</h3>
              {(
                [
                  ["Morning", slots.filter((s) => lagosMinute(new Date(s)) < NOON)],
                  ["Afternoon", slots.filter((s) => lagosMinute(new Date(s)) >= NOON)],
                ] as const
              ).map(([label, group]) =>
                group.length === 0 ? null : (
                  <div key={label}>
                    <p className="mb-1.5 text-[0.6875rem] font-semibold tracking-wide text-muted-foreground uppercase">
                      {label}
                    </p>
                    <div role="radiogroup" aria-label={`${label} times`} className="grid grid-cols-4 gap-2">
                      {group.map((s) => (
                        <button
                          key={s}
                          type="button"
                          role="radio"
                          aria-checked={s === startsAt}
                          onClick={() => chooseSlot(s)}
                          className={`h-10 rounded-xl text-xs font-medium ring-1 outline-none focus-visible:ring-2 focus-visible:ring-accent ${s === startsAt ? "bg-primary text-primary-foreground ring-primary" : "bg-white ring-foreground/8 hover:bg-primary/5"}`}
                        >
                          {formatSlot(s, false)}
                        </button>
                      ))}
                    </div>
                  </div>
                ),
              )}
            </div>
          )}
          <div className="mt-2 grid grid-cols-2 gap-3">
            <Button type="button" variant="outline" onClick={() => setStep("service")}>
              Back
            </Button>
            <Button type="button" loading={busy} disabled={!startsAt} onClick={() => void confirmTime()}>
              Continue
            </Button>
          </div>
        </section>
      )}

      {step === "location" && (
        <section aria-labelledby="step-heading" className="flex flex-col gap-3">
          <StepHeading headingRef={headingRef} title="Farm location details">
            Confirm where the vet should come. It&rsquo;s shared with the vet for this visit only; they see your phone
            number once they accept.
          </StepHeading>

          {!changingFarm && farm ? (
            <div className="rounded-2xl bg-white p-4 ring-1 ring-foreground/8">
              <div className="flex items-start justify-between gap-3">
                <p className="flex min-w-0 items-start gap-1.5 text-sm">
                  <Icon name="map-pin" className="mt-0.5 size-4 shrink-0 text-primary" />
                  <span className="min-w-0">
                    <span className="block font-semibold">{farm.farmName}</span>
                    <span className="block text-xs text-muted-foreground">
                      {address}
                      {state ? `, ${stateLabel(state as NigerianState)}` : ""}
                    </span>
                  </span>
                </p>
                <button
                  type="button"
                  onClick={() => setChangingFarm(true)}
                  className="shrink-0 rounded-full px-2 py-1 text-xs font-semibold text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent"
                >
                  Change location
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {farms.length > 0 && (
                <SelectField
                  name="farmId"
                  label="Farm"
                  placeholder="Choose a farm"
                  value={farmId}
                  onChange={(e) => pickFarm(e.target.value)}
                  options={[
                    ...farms.map((f) => ({ value: f.id, label: f.farmName })),
                    { value: OTHER, label: "Somewhere else" },
                  ]}
                  error={errors.farmId}
                />
              )}
              {farmId === OTHER && (
                <TextField
                  name="farmName"
                  label="Farm name (optional)"
                  value={farmName}
                  maxLength={80}
                  onChange={(e) => setFarmName(e.target.value)}
                  error={errors["location.farmName"]}
                />
              )}
              <TextField
                name="address"
                label="Address or nearest landmark"
                value={address}
                maxLength={160}
                onChange={(e) => setAddress(e.target.value)}
                error={errors["location.address"]}
                autoComplete="street-address"
              />
              <SelectField
                name="state"
                label="State"
                placeholder="Choose a state"
                value={state}
                onChange={(e) => setState(e.target.value)}
                options={NIGERIAN_STATES}
                error={errors["location.state"]}
              />
            </div>
          )}

          {farm && farmId !== OTHER && (
            <Section title="Farm profile">
              <div className="grid grid-cols-2 gap-2">
                <Tile label="Poultry type" value={FARM_TYPE_LABELS[farm.farmType]} />
                <Tile label="Flock size" value={`${farm.birdCount.toLocaleString("en-NG")} birds`} />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">From your farm profile.</p>
            </Section>
          )}

          <TextAreaField
            name="directions"
            label="Add notes / special instructions (optional)"
            value={directions}
            maxLength={300}
            onChange={(e) => setDirections(e.target.value)}
            error={errors["location.directions"]}
            hint="For example, directions to the gate, who to ask for, or what the flock is showing."
          />
          <div className="mt-2 grid grid-cols-2 gap-3">
            <Button type="button" variant="outline" onClick={() => setStep("time")}>
              Back
            </Button>
            <Button type="button" onClick={checkLocation}>
              Continue
            </Button>
          </div>
        </section>
      )}

      {step === "review" && service && startsAt && (
        <section aria-labelledby="step-heading" className="flex flex-col gap-3">
          <StepHeading headingRef={headingRef} title="Review booking details">
            Check everything before you send the request.
          </StepHeading>
          <Section title="Booking">
            <dl className="space-y-1.5 text-sm">
              <Row label="Service selected" value={service.name} />
              <Row label="Date" value={formatDay(lagosDate(new Date(startsAt)))} />
              <Row label="Time slot" value={`${formatSlot(startsAt, false)} (Lagos time)`} />
              <Row label="Length" value={durationLabel(service.durationMinutes)} />
              <Row
                label="Farm site"
                value={[
                  farm && farmId !== OTHER ? farm.farmName : farmName,
                  address,
                  state ? stateLabel(state as NigerianState) : "",
                ]
                  .filter(Boolean)
                  .join(", ")}
              />
            </dl>
          </Section>
          <div className="flex items-center gap-3 rounded-2xl bg-white p-3.5 ring-1 ring-foreground/8">
            <ProfileAvatar photoUrl={vet.photoUrl} name={vet.name} className="size-11 text-sm ring-2" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{vet.name}</p>
              <div className="mt-0.5">
                <ReviewedBadge />
              </div>
            </div>
          </div>
          <Section title="Fee breakdown">
            <PriceBreakdown
              priceKobo={service.priceNgn * 100}
              feeKobo={0}
              totalKobo={service.priceNgn * 100}
              paymentStatus={service.priceNgn === 0 ? "not_required" : "payment_required"}
            />
            <p className="mt-2 text-xs text-muted-foreground">The price is checked again when you send the request.</p>
          </Section>
          <p className="text-xs leading-relaxed text-muted-foreground">
            This sends a request. It&rsquo;s confirmed only when the vet accepts; if they don&rsquo;t respond within 24
            hours (or by the visit time), the request lapses and the time is freed.
          </p>
          <div className="mt-1 grid grid-cols-2 gap-3">
            <Button type="button" variant="outline" disabled={busy} onClick={() => setStep("location")}>
              Back
            </Button>
            <Button type="button" loading={busy} onClick={() => void submit()}>
              {busy ? "Sending…" : "Send request"}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}

function StepHeading({
  headingRef,
  title,
  children,
}: {
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h2 id="step-heading" ref={headingRef} tabIndex={-1} className="text-base font-semibold outline-none">
        {title}
      </h2>
      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{children}</p>
    </div>
  );
}

/**
 * A month of days, Monday first. Only days inside the booking window on
 * the vet's working weekdays can be picked; whether a day still has open
 * times is asked of the server when it's picked (days off and bookings
 * aren't known here).
 */
function MonthCalendar({
  month,
  onMonth,
  today,
  last,
  selected,
  isWorkDay,
  onSelect,
}: {
  month: string;
  onMonth: (month: string) => void;
  today: string;
  last: string;
  selected: string | null;
  isWorkDay: (date: string) => boolean;
  onSelect: (date: string) => void;
}) {
  const first = `${month}-01`;
  const lead = (weekday(first) + 6) % 7;
  const nextMonth = addDays(`${month}-28`, 4).slice(0, 7);
  const prevMonth = addDays(first, -1).slice(0, 7);
  const days: string[] = [];
  for (let d = first; d.startsWith(month); d = addDays(d, 1)) days.push(d);
  const title = new Intl.DateTimeFormat("en-NG", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${first}T00:00:00Z`));
  const arrow =
    "flex size-9 items-center justify-center rounded-full text-primary outline-none hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-30";

  return (
    <div className="rounded-2xl bg-white p-3 ring-1 ring-foreground/8">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="pl-1 text-sm font-semibold" aria-live="polite">
          {title}
        </h3>
        <div className="flex gap-1">
          <button
            type="button"
            aria-label="Previous month"
            disabled={prevMonth < today.slice(0, 7)}
            onClick={() => onMonth(prevMonth)}
            className={arrow}
          >
            <Icon name="arrow-left" className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Next month"
            disabled={nextMonth > last.slice(0, 7)}
            onClick={() => onMonth(nextMonth)}
            className={arrow}
          >
            <Icon name="chevron-right" className="size-4" />
          </button>
        </div>
      </div>
      <div role="grid" aria-label={title} className="grid grid-cols-7 gap-y-1 text-center">
        {WEEK_HEADINGS.map((h, i) => (
          <span key={i} aria-hidden="true" className="py-1 text-[0.6875rem] font-medium text-muted-foreground">
            {h}
          </span>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          <span key={`lead-${i}`} />
        ))}
        {days.map((d) => {
          const bookable = d >= today && d <= last && isWorkDay(d);
          const isSelected = d === selected;
          return (
            <button
              key={d}
              type="button"
              disabled={!bookable}
              aria-pressed={isSelected}
              aria-label={`${formatDay(d)}${bookable ? "" : ", not bookable"}`}
              onClick={() => onSelect(d)}
              className={`mx-auto flex size-9 items-center justify-center rounded-full text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:text-foreground/25 ${isSelected ? "bg-primary font-semibold text-primary-foreground" : bookable ? "font-medium text-foreground hover:bg-primary/8" : ""} ${d === today && !isSelected ? "ring-1 ring-primary/40" : ""}`}
            >
              {Number(d.slice(8))}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * What the server recorded. "Booking confirmed" only appears when it's
 * true (accepted, nothing to pay); a new request is shown as waiting.
 */
function Confirmation({
  appointment: a,
  headingRef,
}: {
  appointment: Appointment;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}) {
  const h = bookingHeadline(a);
  const confirmed = isFullyConfirmed(a);
  return (
    <div className="flex flex-1 flex-col items-center px-5 pt-4 pb-8 text-center">
      <span
        className={`flex size-16 items-center justify-center rounded-full ring-4 ${confirmed ? "text-primary ring-primary/30" : "bg-amber-50 text-amber-800 ring-amber-200"}`}
      >
        <Icon name={confirmed ? "check-circle" : "clock"} className="size-8" />
      </span>
      <h2 ref={headingRef} tabIndex={-1} role="status" className="mt-4 text-xl font-semibold outline-none">
        {h.title}
      </h2>
      <p className="mt-1 max-w-xs text-sm leading-relaxed text-foreground/75">{h.detail}</p>
      <p className="mt-2 text-xs text-muted-foreground">
        Ref ID: <span className="font-mono font-semibold text-foreground">{a.reference}</span>
      </p>

      <dl className="mt-5 w-full space-y-1.5 rounded-2xl bg-white p-4 text-left text-sm ring-1 ring-foreground/8">
        <Row label="Vet" value={a.vet.name} />
        <Row label="Service" value={a.service.name} />
        <Row label="Date & time" value={`${formatSlot(a.startsAt)} (Lagos time)`} />
        <Row
          label="Address"
          value={[a.location.farmName, a.location.address, stateLabel(a.location.state)].filter(Boolean).join(", ")}
        />
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted-foreground">Booking</dt>
          <dd>
            <BookingBadge status={a.bookingStatus} />
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted-foreground">Payment</dt>
          <dd>
            <PaymentBadge status={a.paymentStatus} />
          </dd>
        </div>
      </dl>
      {a.bookingStatus === "requested" && (
        <p className="mt-3 max-w-xs text-xs leading-relaxed text-muted-foreground">
          The vet has until {formatSlot(a.respondBy)} to respond. You&rsquo;ll get a notification either way.
        </p>
      )}

      <div className="mt-6 flex w-full flex-col gap-2">
        <Link href={`/appointments/${a.id}`} className={buttonClasses("solid")}>
          View booking details
        </Link>
        <Link href="/home" className={buttonClasses("ghost")}>
          Back to home
        </Link>
      </div>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-foreground/[0.03] px-3 py-2">
      <p className="text-[0.6875rem] text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold">{value}</p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}
