"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormAlert } from "@/components/auth/auth-screen";
import { buttonClasses } from "@/components/ui/button";
import { Icon } from "@/components/ui/icons";
import { Switch } from "@/components/ui/switch";
import type { Role } from "@/lib/auth/types";
import { deleteService, updateService } from "@/lib/services/api";
import { categoryLabel, durationLabel, formatNaira } from "@/lib/services/config";
import type { Service } from "@/lib/services/types";

type Toggle = "active" | "bookingAvailable";

const NEW_PATH = "/profile/services/new";

/**
 * The signed-in user's services, as loaded by the server. Every change is
 * sent to the API and only shown once the server confirms it; a failed change
 * leaves the service as it was and says why.
 */
export function ServicesManager({
  role,
  initialServices,
  notice,
}: {
  role: Role;
  initialServices: Service[];
  /** a server-confirmed result from the previous screen, e.g. "Service added." */
  notice: string | null;
}) {
  const router = useRouter();
  const [services, setServices] = useState(initialServices);
  const [pending, setPending] = useState<Record<string, Toggle | undefined>>({});
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [status, setStatus] = useState(notice);
  const [removing, setRemoving] = useState<Service | null>(null);

  async function toggle(service: Service, field: Toggle) {
    if (pending[service.id]) return;
    setPending((p) => ({ ...p, [service.id]: field }));
    setErrors((e) => ({ ...e, [service.id]: undefined }));
    setStatus(null);

    const res = await updateService(service.id, { [field]: !service[field] });
    setPending((p) => ({ ...p, [service.id]: undefined }));
    if (!res.ok) {
      setErrors((e) => ({ ...e, [service.id]: res.error }));
      return;
    }
    const saved = res.data.service;
    setServices((list) => list.map((s) => (s.id === saved.id ? saved : s)));
    setStatus(
      field === "active"
        ? `“${saved.name}” is now ${saved.active ? "active" : "inactive"}.`
        : `“${saved.name}” is ${saved.bookingAvailable ? "open for booking" : "no longer taking bookings"}.`,
    );
  }

  function removed(service: Service) {
    setRemoving(null);
    setServices((list) => list.filter((s) => s.id !== service.id));
    setStatus(`“${service.name}” was removed.`);
    router.refresh();
  }

  if (services.length === 0)
    return (
      <>
        <div aria-live="polite" className="mb-4 empty:hidden">
          {status && <FormAlert tone="success">{status}</FormAlert>}
        </div>
        <div className="flex flex-col items-center rounded-3xl bg-white px-6 py-10 text-center shadow-sm ring-1 ring-foreground/5">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/8 text-primary">
            <Icon name="list" className="size-7" />
          </div>
          <h3 className="mt-4 text-base font-semibold">No services yet</h3>
          <p className="mt-1.5 max-w-xs text-sm leading-relaxed text-muted-foreground">
            Add the services you offer and what you charge. Only you can see them until bookings open.
          </p>
          <Link href={NEW_PATH} className={buttonClasses("solid", "mt-6 max-w-xs gap-2")}>
            <Icon name="plus" className="size-[18px]" />
            Add New Service
          </Link>
        </div>
      </>
    );

  return (
    <>
      <Link href={NEW_PATH} className={buttonClasses("solid", "gap-2")}>
        <Icon name="plus" className="size-[18px]" />
        Add New Service
      </Link>

      <div aria-live="polite" className="empty:hidden mt-4">
        {status && <FormAlert tone="success">{status}</FormAlert>}
      </div>

      <h3 className="mt-6 mb-3 text-sm font-semibold text-foreground/70">
        {services.length} service{services.length === 1 ? "" : "s"}
      </h3>
      <ul className="space-y-3">
        {services.map((service) => (
          <li key={service.id}>
            <ServiceCard
              role={role}
              service={service}
              pending={pending[service.id]}
              error={errors[service.id]}
              onToggle={(field) => toggle(service, field)}
              onRemove={() => setRemoving(service)}
            />
          </li>
        ))}
      </ul>

      {removing && <ConfirmRemove service={removing} onCancel={() => setRemoving(null)} onRemoved={removed} />}
    </>
  );
}

function availability(service: Service): { label: string; tone: "on" | "partial" | "off" } {
  if (!service.active) return { label: "Inactive · not bookable", tone: "off" };
  if (service.bookable) return { label: "Active · available for booking", tone: "on" };
  return { label: "Active · not taking bookings", tone: "partial" };
}

const TONE_CLASS = {
  on: "bg-accent/12 text-primary",
  partial: "bg-amber-100 text-amber-800",
  off: "bg-foreground/8 text-foreground/60",
} as const;

function ServiceCard({
  role,
  service,
  pending,
  error,
  onToggle,
  onRemove,
}: {
  role: Role;
  service: Service;
  pending: Toggle | undefined;
  error: string | undefined;
  onToggle: (field: Toggle) => void;
  onRemove: () => void;
}) {
  const state = availability(service);
  return (
    <article
      aria-label={service.name}
      className={`rounded-3xl bg-white p-4 shadow-sm ring-1 ring-foreground/5 ${service.active ? "" : "bg-white/70"}`}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h4 className={`text-[0.9375rem] font-semibold break-words ${service.active ? "" : "text-foreground/60"}`}>
            {service.name}
          </h4>
          <p className="mt-0.5 text-xs font-medium text-primary">{categoryLabel(role, service.category)}</p>
        </div>
        <p className="shrink-0 text-base font-semibold text-foreground">{formatNaira(service.priceNgn)}</p>
      </div>

      <p className="mt-2 line-clamp-3 text-sm leading-relaxed whitespace-pre-line text-muted-foreground">
        {service.description}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-1 rounded-full bg-foreground/5 px-2.5 py-1 font-medium text-foreground/70">
          <Icon name="clock" className="size-3.5" />
          {durationLabel(service.durationMinutes)}
        </span>
        <span className={`rounded-full px-2.5 py-1 font-semibold ${TONE_CLASS[state.tone]}`}>{state.label}</span>
      </div>

      <div className="mt-4 space-y-3 border-t border-foreground/6 pt-3.5">
        <Switch
          label="Active"
          description={service.active ? "Listed on your profile." : "Hidden from your profile."}
          checked={service.active}
          busy={pending === "active"}
          disabled={pending !== undefined}
          onChange={() => onToggle("active")}
        />
        <Switch
          label="Available for booking"
          description={
            service.active
              ? "Farmers can book it once bookings open."
              : "Only counts while the service is active."
          }
          checked={service.bookingAvailable}
          busy={pending === "bookingAvailable"}
          disabled={pending !== undefined}
          onChange={() => onToggle("bookingAvailable")}
        />
      </div>

      {error && (
        <div className="mt-3">
          <FormAlert>{error}</FormAlert>
        </div>
      )}

      <div className="mt-4 grid grid-cols-2 gap-2.5">
        <Link
          href={`/profile/services/${service.id}/edit`}
          aria-label={`Edit ${service.name}`}
          className={buttonClasses("outline", "h-10 gap-1.5 text-sm")}
        >
          <Icon name="pencil" className="size-4" />
          Edit
        </Link>
        <button
          type="button"
          onClick={onRemove}
          disabled={pending !== undefined}
          aria-label={`Remove ${service.name}`}
          className="flex h-10 items-center justify-center gap-1.5 rounded-full border border-red-200 bg-white px-4 text-sm font-medium text-red-600 outline-none hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 disabled:opacity-50"
        >
          <Icon name="trash" className="size-4" />
          Remove
        </button>
      </div>
    </article>
  );
}

/** Asks before removing; stays open with the reason if the server refuses. */
function ConfirmRemove({
  service,
  onCancel,
  onRemoved,
}: {
  service: Service;
  onCancel: () => void;
  onRemoved: (service: Service) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => cancelRef.current?.focus(), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await deleteService(service.id);
    if (!res.ok) {
      setBusy(false);
      setError(res.error);
      return;
    }
    onRemoved(service);
  }

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-center bg-foreground/40 p-4 sm:items-center">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="remove-service-title"
        aria-describedby="remove-service-body"
        className="w-full max-w-sm rounded-3xl bg-white p-5 shadow-xl"
      >
        <div className="flex size-11 items-center justify-center rounded-2xl bg-red-50 text-red-600">
          <Icon name="trash" />
        </div>
        <h2 id="remove-service-title" className="mt-3 text-lg font-semibold">
          Remove this service?
        </h2>
        <p id="remove-service-body" className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
          “{service.name}” will be taken off your profile and can no longer be booked. This can&apos;t be undone.
        </p>
        {error && (
          <div className="mt-4">
            <FormAlert>{error}</FormAlert>
          </div>
        )}
        <div className="mt-5 grid grid-cols-2 gap-3">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={busy}
            className={buttonClasses("outline")}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={busy}
            aria-busy={busy || undefined}
            className="flex h-12 w-full items-center justify-center rounded-full bg-red-600 px-5 text-base font-medium text-white outline-none hover:bg-red-700 focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2 disabled:opacity-80"
          >
            {busy && (
              <span
                aria-hidden="true"
                className="mr-2.5 size-4 animate-spin rounded-full border-2 border-current border-r-transparent"
              />
            )}
            {busy ? "Removing…" : "Remove"}
          </button>
        </div>
      </div>
    </div>
  );
}
