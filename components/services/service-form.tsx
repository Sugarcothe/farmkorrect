"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FormAlert } from "@/components/auth/auth-screen";
import { backButtonClass, ProfileTopBar } from "@/components/profile/profile-parts";
import { Button } from "@/components/ui/button";
import { SelectField, TextAreaField, TextField } from "@/components/ui/field";
import { Icon } from "@/components/ui/icons";
import { Switch } from "@/components/ui/switch";
import type { Role } from "@/lib/auth/types";
import { cleanText } from "@/lib/profile/validation";
import { createService, updateService } from "@/lib/services/api";
import {
  DURATION_OPTIONS,
  DURATION_VARIES_LABEL,
  formatNaira,
  SERVICE_CATEGORIES,
  SERVICE_LIMITS,
  serviceCategory,
} from "@/lib/services/config";
import type { Service, ServiceFields, ServiceUpdateRequest } from "@/lib/services/types";
import {
  parsePriceInput,
  validateDurationMinutes,
  validatePriceNgn,
  validateServiceCategory,
  validateServiceDescription,
  validateServiceName,
} from "@/lib/services/validation";
import { useForm } from "@/lib/use-form";

type Values = {
  name: string;
  category: string;
  description: string;
  price: string;
  duration: string;
  bookingAvailable: boolean;
};

const VARIES = "varies";
const LIST_PATH = "/profile/services";
const DISCARD_MESSAGE = "Discard your unsaved changes?";

const durationOptions = [
  ...DURATION_OPTIONS.map((d) => ({ value: String(d.minutes), label: d.label })),
  { value: VARIES, label: `${DURATION_VARIES_LABEL} — agreed with the farmer` },
];

/** API field names → the form's own field names, for server field errors. */
const FORM_FIELD: Record<string, keyof Values> = {
  name: "name",
  category: "category",
  description: "description",
  priceNgn: "price",
  durationMinutes: "duration",
  bookingAvailable: "bookingAvailable",
};

function initialValues(service?: Service): Values {
  if (!service)
    return { name: "", category: "", description: "", price: "", duration: "", bookingAvailable: true };
  return {
    name: service.name,
    category: service.category,
    description: service.description,
    price: String(service.priceNgn),
    duration: service.durationMinutes === null ? VARIES : String(service.durationMinutes),
    bookingAvailable: service.bookingAvailable,
  };
}

/** What the server would store for these values (only meaningful once they're valid). */
function toFields(v: Values): Omit<ServiceFields, "active"> {
  return {
    name: cleanText(v.name),
    category: v.category,
    description: cleanText(v.description, true),
    priceNgn: parsePriceInput(v.price),
    durationMinutes: v.duration === VARIES || v.duration === "" ? null : Number(v.duration),
    bookingAvailable: v.bookingAvailable,
  };
}

/**
 * Adds a service, or edits one when `service` is given. The categories come
 * from the role on the server-rendered page; the API enforces the same rules
 * and decides whose service it is from the session.
 */
export function ServiceForm({ role, service }: { role: Role; service?: Service }) {
  const router = useRouter();
  const editing = service !== undefined;
  const categories = SERVICE_CATEGORIES[role];

  const [initial] = useState(() => initialValues(service));
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<Values>(initial, (v) => {
    const price = parsePriceInput(v.price);
    return {
      name: validateServiceName(v.name),
      category: validateServiceCategory(role, v.category),
      description: validateServiceDescription(v.description),
      price: !v.price.trim()
        ? "Enter a price in naira."
        : Number.isNaN(price)
          ? "Enter the price as a number, like 5000."
          : validatePriceNgn(role, price, v.category),
      duration: v.duration ? validateDurationMinutes(toFields(v).durationMinutes) : "Choose a duration.",
    };
  });

  /** Only the fields that actually changed (all of them for a new service). */
  function changes(values: Values): ServiceUpdateRequest {
    const next = toFields(values);
    if (!editing) return next;
    const before = toFields(initial);
    return Object.fromEntries(
      (Object.keys(next) as Array<keyof typeof next>)
        .filter((key) => next[key] !== before[key])
        .map((key) => [key, next[key]]),
    );
  }

  const dirty = editing
    ? Object.keys(changes(form.values)).length > 0
    : JSON.stringify(form.values) !== JSON.stringify(initial);

  // warn before a reload or tab close throws away edits (in-app navigation
  // goes through leave(), which asks first)
  useEffect(() => {
    if (!dirty || submitting) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, submitting]);

  function leave() {
    if (submitting) return;
    if (dirty && !window.confirm(DISCARD_MESSAGE)) return;
    router.push(LIST_PATH);
  }

  const onSubmit = form.handleSubmit(async (values) => {
    if (submitting || (editing && !dirty)) return;
    setSubmitting(true);
    setFormError(null);

    const res = editing
      ? await updateService(service.id, changes(values))
      : await createService(toFields(values) as ServiceFields);

    if (!res.ok) {
      // keep everything that was typed so it can be fixed and resent
      setSubmitting(false);
      setFormError(res.error);
      if (res.fieldErrors)
        form.setServerErrors(
          Object.fromEntries(
            Object.entries(res.fieldErrors)
              .filter(([key]) => key in FORM_FIELD)
              .map(([key, message]) => [FORM_FIELD[key], message]),
          ),
        );
      return;
    }

    // stays "Saving…" (and locked) until the list has loaded
    router.push(`${LIST_PATH}?saved=${editing ? "updated" : "added"}`);
    router.refresh();
  });

  const category = serviceCategory(role, form.values.category);
  const price = parsePriceInput(form.values.price);
  const priceHint =
    Number.isInteger(price) && price >= 0 && !form.errors.price
      ? `Farmers will see ${formatNaira(price)}.`
      : category?.allowsFree === false
        ? "In whole naira, e.g. 5,000."
        : "In whole naira, e.g. 5,000. Enter 0 to offer it free.";

  return (
    <main className="flex flex-1 flex-col">
      <ProfileTopBar
        title={editing ? "Edit Service" : "Add New Service"}
        back={
          <button type="button" aria-label="Back" onClick={leave} className={backButtonClass}>
            <Icon name="arrow-left" />
          </button>
        }
      />

      <form onSubmit={onSubmit} noValidate className="flex flex-1 flex-col px-5 pb-6">
        <div className="space-y-4">
          <TextField
            label="Service Name"
            placeholder={role === "veterinarian" ? "e.g. Farm visit & flock check" : "e.g. Broiler farm setup advice"}
            maxLength={SERVICE_LIMITS.name.max + 20}
            {...form.field("name")}
          />
          <SelectField label="Category" placeholder="Select a category" options={categories} {...form.field("category")} />
          <TextAreaField
            label="Description"
            placeholder="What's included, and anything the farmer should prepare."
            maxLength={SERVICE_LIMITS.description.max + 50}
            hint={`${cleanText(form.values.description, true).length}/${SERVICE_LIMITS.description.max} characters`}
            {...form.field("description")}
          />
          <TextField label="Price (₦)" inputMode="numeric" placeholder="e.g. 5,000" hint={priceHint} {...form.field("price")} />
          <SelectField label="Duration" placeholder="Select how long it takes" options={durationOptions} {...form.field("duration")} />

          <div className="rounded-2xl bg-white px-4 py-3.5 ring-1 ring-foreground/8">
            <Switch
              label="Available for booking"
              description={
                editing && !service.active
                  ? "This service is inactive, so it can't be booked until you activate it."
                  : "Bookings aren't open yet. When they launch, farmers can book this service."
              }
              checked={form.values.bookingAvailable}
              onChange={(checked) => form.setValue("bookingAvailable", checked)}
              disabled={submitting}
            />
          </div>
        </div>

        {formError && (
          <div className="mt-5">
            <FormAlert>{formError}</FormAlert>
          </div>
        )}

        <div className="mt-auto grid grid-cols-2 gap-3 pt-6">
          <Button type="button" variant="outline" onClick={leave} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" loading={submitting} disabled={editing && !dirty}>
            {submitting ? "Saving…" : editing ? "Save" : "Add Service"}
          </Button>
        </div>
      </form>
    </main>
  );
}
