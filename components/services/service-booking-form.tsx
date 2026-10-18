"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FormAlert } from "@/components/auth/auth-screen";
import { Button } from "@/components/ui/button";
import { SelectField, TextAreaField, TextField } from "@/components/ui/field";
import { NIGERIAN_STATES, stateLabel, type NigerianState } from "@/lib/locations/nigeria";
import { cleanText } from "@/lib/profile/validation";
import { bookService } from "@/lib/services/api";
import {
  CATEGORY_FIELDS,
  CONTACT_PREFERENCES,
  SERVICE_BOOKING_RULES,
  TIME_WINDOWS,
  validateBookingDetails,
  type ContactPreference,
  type DetailField,
  type MarketplaceServiceDetails,
  type TimeWindow,
} from "@/lib/services/marketplace";
import { formatDay } from "@/lib/vets/schedule";
import { servicePrice } from "./service-parts";

type Values = {
  date: string;
  window: string;
  address: string;
  state: string;
  directions: string;
  contactPreference: string;
  notes: string;
};

const newKey = () => crypto.randomUUID();

function without(errors: Record<string, string>, key: string) {
  if (!(key in errors)) return errors;
  const next = { ...errors };
  delete next[key];
  return next;
}

/**
 * Step 1 of booking a marketplace service: what the job is, when and where.
 * Only these choices are sent: the server reads the provider and the price
 * from the service itself. One idempotency key per attempt, so a double tap
 * or a retry after a dropped connection makes one booking, not two.
 */
export function ServiceBookingForm({
  service,
  firstDate,
  lastDate,
}: {
  service: MarketplaceServiceDetails;
  firstDate: string;
  lastDate: string;
}) {
  const router = useRouter();
  const fields = CATEGORY_FIELDS[service.category];
  const quote = service.pricing === "quote";
  const onlyState = service.serviceStates.length === 1 ? service.serviceStates[0] : "";
  const [values, setValues] = useState<Values>({
    date: "",
    window: "",
    address: "",
    state: onlyState,
    directions: "",
    contactPreference: "call",
    notes: "",
  });
  const [details, setDetails] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [key, setKey] = useState(newKey);

  const stateOptions = NIGERIAN_STATES.filter((s) => service.serviceStates.includes(s.value));

  function set<K extends keyof Values>(name: K, value: string) {
    setValues((v) => ({ ...v, [name]: value }));
    // a different day is a different booking
    if (name === "date") setKey(newKey());
    const errorKey = name === "address" || name === "state" || name === "directions" ? `location.${name}` : name;
    setErrors((e) => without(e, errorKey));
  }

  function setDetail(name: string, value: string) {
    setDetails((d) => ({ ...d, [name]: value }));
    setErrors((e) => without(e, `details.${name}`));
  }

  function validate(): Record<string, string> {
    const found: Record<string, string> = {};
    if (!values.date) found.date = "Choose a date.";
    else if (values.date < firstDate || values.date > lastDate)
      found.date = `Choose a date from ${formatDay(firstDate)} to ${formatDay(lastDate)}.`;
    if (!values.window) found.window = "Choose a time of day.";
    const address = cleanText(values.address);
    const { min, max } = SERVICE_BOOKING_RULES.address;
    if (address.length < min || address.length > max)
      found["location.address"] = `Enter the address or nearest landmark (${min}–${max} characters).`;
    if (!values.state) found["location.state"] = "Choose the state.";
    if (cleanText(values.directions, true).length > SERVICE_BOOKING_RULES.directions)
      found["location.directions"] = `Keep directions to ${SERVICE_BOOKING_RULES.directions} characters.`;
    if (cleanText(values.notes, true).length > SERVICE_BOOKING_RULES.notes)
      found.notes = `Keep notes to ${SERVICE_BOOKING_RULES.notes} characters.`;
    for (const [k, v] of Object.entries(validateBookingDetails(service.category, details).errors))
      found[`details.${k}`] = v;
    return found;
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    const found = validate();
    setErrors(found);
    setFormError(null);
    const firstInvalid = Object.keys(found)[0];
    if (firstInvalid) {
      e.currentTarget.querySelector<HTMLElement>(`[name="${firstInvalid}"]`)?.focus();
      return;
    }
    setSubmitting(true);
    const res = await bookService({
      serviceId: service.id,
      date: values.date,
      window: values.window as TimeWindow,
      location: {
        address: values.address,
        state: values.state as NigerianState,
        ...(values.directions.trim() ? { directions: values.directions } : {}),
      },
      contactPreference: values.contactPreference as ContactPreference,
      ...(values.notes.trim() ? { notes: values.notes } : {}),
      details: Object.fromEntries(Object.entries(details).filter(([, v]) => v.trim() !== "")),
      idempotencyKey: key,
    });
    if (!res.ok) {
      setSubmitting(false);
      setFormError(res.error);
      if (res.fieldErrors) {
        setErrors(res.fieldErrors);
        // refused outright, so nothing was booked: the next try is a new attempt
        setKey(newKey());
      }
      return;
    }
    // stays locked while the booking (and, for a fixed price, the payment step) loads
    router.push(`/services/bookings/${res.data.booking.id}`);
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-1 flex-col gap-4">
      <section className="rounded-3xl bg-white px-4 py-4 shadow-sm ring-1 ring-foreground/5">
        <p className="text-[0.6875rem] font-semibold tracking-wide text-primary uppercase">{service.categoryLabel}</p>
        <h2 className="mt-0.5 text-base font-semibold">{service.name}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {service.provider.name} · {servicePrice(service)}
        </p>
        {service.requirements && (
          <p className="mt-2 text-xs leading-relaxed whitespace-pre-line text-foreground/75">
            <span className="font-semibold">You&rsquo;ll need to provide: </span>
            {service.requirements}
          </p>
        )}
      </section>

      <fieldset className="space-y-4">
        <legend className="mb-2 text-sm font-semibold">About the job</legend>
        {fields.map((field) => (
          <DetailInput
            key={field.key}
            field={field}
            value={details[field.key] ?? ""}
            error={errors[`details.${field.key}`]}
            onChange={(v) => setDetail(field.key, v)}
          />
        ))}
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="mb-2 text-sm font-semibold">When</legend>
        <TextField
          name="date"
          type="date"
          label="Date"
          min={firstDate}
          max={lastDate}
          value={values.date}
          error={errors.date}
          hint={`From ${formatDay(firstDate)} up to ${SERVICE_BOOKING_RULES.maxDaysAhead} days ahead.`}
          onChange={(e) => set("date", e.target.value)}
        />
        <SelectField
          name="window"
          label="Time of day"
          placeholder="Choose a time of day"
          options={TIME_WINDOWS}
          value={values.window}
          error={errors.window}
          onChange={(e) => set("window", e.target.value)}
        />
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="mb-2 text-sm font-semibold">
          {service.category === "transportation" || service.category === "logistics" ? "Pickup location" : "Location"}
        </legend>
        <TextField
          name="location.address"
          label="Address or nearest landmark"
          autoComplete="street-address"
          maxLength={SERVICE_BOOKING_RULES.address.max + 20}
          value={values.address}
          error={errors["location.address"]}
          onChange={(e) => set("address", e.target.value)}
        />
        <SelectField
          name="location.state"
          label="State"
          placeholder="Choose the state"
          options={stateOptions}
          value={values.state}
          error={errors["location.state"]}
          hint={`This provider covers ${service.serviceStates.map(stateLabel).join(", ")}.`}
          onChange={(e) => set("state", e.target.value)}
        />
        <TextAreaField
          name="location.directions"
          label="Directions (optional)"
          maxLength={SERVICE_BOOKING_RULES.directions + 50}
          value={values.directions}
          error={errors["location.directions"]}
          onChange={(e) => set("directions", e.target.value)}
        />
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-sm font-semibold">How should the provider contact you?</legend>
        <div className="grid grid-cols-2 gap-2">
          {CONTACT_PREFERENCES.map((c) => (
            <label
              key={c.value}
              className={`flex h-11 cursor-pointer items-center justify-center rounded-xl text-sm font-medium ring-1 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent ${values.contactPreference === c.value ? "bg-primary text-primary-foreground ring-primary" : "bg-white ring-foreground/10"}`}
            >
              <input
                type="radio"
                name="contactPreference"
                value={c.value}
                checked={values.contactPreference === c.value}
                onChange={() => set("contactPreference", c.value)}
                className="sr-only"
              />
              {c.label}
            </label>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Your phone number is shared with the provider only once the booking is confirmed.
        </p>
      </fieldset>

      <TextAreaField
        name="notes"
        label="Notes for the provider (optional)"
        maxLength={SERVICE_BOOKING_RULES.notes + 50}
        value={values.notes}
        error={errors.notes}
        onChange={(e) => set("notes", e.target.value)}
      />

      {formError && <FormAlert>{formError}</FormAlert>}

      <p className="text-xs leading-relaxed text-muted-foreground">
        {quote
          ? "Nothing is charged now. The provider will send you a price; you pay only if you accept it."
          : `Next you'll pay ${servicePrice(service)} securely with Paystack. There's no booking fee. You'll get a full refund if the provider declines or doesn't respond in time.`}
      </p>

      <div className="mt-auto pt-2">
        <Button type="submit" loading={submitting}>
          {submitting ? "Sending…" : quote ? "Request quote" : "Continue to payment"}
        </Button>
      </div>
    </form>
  );
}

function DetailInput({
  field,
  value,
  error,
  onChange,
}: {
  field: DetailField;
  value: string;
  error?: string;
  onChange: (value: string) => void;
}) {
  const name = `details.${field.key}`;
  const label = field.required || field.label.includes("optional") ? field.label : `${field.label} (optional)`;
  switch (field.kind) {
    case "select":
      return (
        <SelectField
          name={name}
          label={label}
          placeholder="Choose one"
          options={field.options}
          value={value}
          error={error}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "state":
      return (
        <SelectField
          name={name}
          label={label}
          placeholder="Choose the state"
          options={NIGERIAN_STATES}
          value={value}
          error={error}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "textarea":
      return (
        <TextAreaField
          name={name}
          label={label}
          maxLength={field.max + 50}
          value={value}
          error={error}
          hint={field.hint}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "number":
      return (
        <TextField
          name={name}
          label={field.unit ? `${label} (${field.unit})` : label}
          inputMode="numeric"
          value={value}
          error={error}
          onChange={(e) => onChange(e.target.value.replace(/[\s,]/g, ""))}
        />
      );
    case "text":
      return (
        <TextField
          name={name}
          label={label}
          maxLength={field.max + 20}
          value={value}
          error={error}
          hint={field.hint}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}
