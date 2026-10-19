"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FormAlert } from "@/components/auth/auth-screen";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { changeAppointment } from "@/lib/vets/api";
import { formatSlot } from "@/lib/vets/schedule";
import type { Appointment, AppointmentAction } from "@/lib/vets/types";

const LABELS: Record<AppointmentAction, string> = {
  accept: "Accept request",
  decline: "Decline",
  en_route: "I'm on my way",
  start: "Start visit",
  complete: "Mark visit completed",
  cancel: "Cancel appointment",
};

const DONE: Record<AppointmentAction, string> = {
  accept: "Request accepted. The customer has been notified.",
  decline: "Request declined. The time is free again.",
  en_route: "The customer has been told you're on your way.",
  start: "Visit started.",
  complete: "Visit marked as completed.",
  cancel: "Appointment cancelled. The time is free again.",
};

/** Actions that need a confirmation and take an optional reason. */
const ASKS_REASON: readonly AppointmentAction[] = ["decline", "cancel"];

/** Actions confirmed in a second step, with what accepting commits the vet to. */
const CONFIRMS: Partial<Record<AppointmentAction, string>> = {
  accept: "Accept this visit? The customer is told straight away and the time stays booked for them.",
};

/**
 * The buttons for what this viewer may do now. The server lists the
 * allowed actions and checks them again; each change carries the status
 * shown here, so acting on an out-of-date screen changes nothing.
 */
export function AppointmentActions({ appointment }: { appointment: Appointment }) {
  const router = useRouter();
  const [busy, setBusy] = useState<AppointmentAction | null>(null);
  const [asking, setAsking] = useState<AppointmentAction | null>(null);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const inFlight = useRef(false);

  async function run(action: AppointmentAction) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(action);
    setMessage(null);
    const res = await changeAppointment(appointment.id, {
      action,
      expectedStatus: appointment.bookingStatus,
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    });
    inFlight.current = false;
    setBusy(null);
    setAsking(null);
    setReason("");
    setMessage(res.ok ? { tone: "success", text: DONE[action] } : { tone: "error", text: res.error });
    router.refresh();
  }

  // the vet completes a visit from the visit record, which checks what's still needed
  const shown = appointment.actions.filter((a) => !(a === "complete" && appointment.viewer === "vet"));
  const primary = shown.filter((a) => !ASKS_REASON.includes(a));
  const secondary = shown.filter((a) => ASKS_REASON.includes(a));
  const customerCanCancel = appointment.viewer === "customer" && appointment.bookingStatus === "confirmed";

  return (
    <div className="space-y-3">
      {message && <FormAlert tone={message.tone}>{message.text}</FormAlert>}
      {primary.map((a) =>
        CONFIRMS[a] && asking === a ? (
          <div key={a} className="space-y-3 rounded-2xl bg-white p-4 ring-1 ring-foreground/8">
            <p className="text-sm">{CONFIRMS[a]}</p>
            <div className="grid grid-cols-2 gap-3">
              <Button type="button" variant="outline" disabled={busy !== null} onClick={() => setAsking(null)}>
                Go back
              </Button>
              <Button type="button" loading={busy === a} onClick={() => void run(a)}>
                {LABELS[a]}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            key={a}
            type="button"
            loading={busy === a}
            disabled={busy !== null}
            onClick={() => (CONFIRMS[a] ? setAsking(a) : void run(a))}
          >
            {LABELS[a]}
          </Button>
        ),
      )}
      {secondary.map((a) =>
        asking === a ? (
          <form
            key={a}
            onSubmit={(e) => {
              e.preventDefault();
              void run(a);
            }}
            className="space-y-3 rounded-2xl bg-white p-4 ring-1 ring-foreground/8"
          >
            <TextField
              name="reason"
              label="Reason (optional, shared with the other party)"
              value={reason}
              maxLength={200}
              onChange={(e) => setReason(e.target.value)}
            />
            <div className="grid grid-cols-2 gap-3">
              <Button type="button" variant="outline" disabled={busy !== null} onClick={() => setAsking(null)}>
                Keep it
              </Button>
              <Button type="submit" loading={busy === a}>
                {LABELS[a]}
              </Button>
            </div>
          </form>
        ) : (
          <Button key={a} type="button" variant="outline" disabled={busy !== null} onClick={() => setAsking(a)}>
            {LABELS[a]}
          </Button>
        ),
      )}
      {customerCanCancel && (
        <p className="text-center text-xs text-muted-foreground">
          {appointment.actions.includes("cancel")
            ? `You can cancel until ${formatSlot(appointment.cancelUntil)}.`
            : "It's too close to the visit to cancel here. Contact the vet directly."}
        </p>
      )}
      {appointment.bookingStatus === "requested" && (
        <p className="text-center text-xs text-muted-foreground">
          {appointment.viewer === "vet" ? "Respond by" : "The vet has until"} {formatSlot(appointment.respondBy)}
          {appointment.viewer === "vet" ? "." : " to respond."}
        </p>
      )}
      <button
        type="button"
        onClick={() => router.refresh()}
        className="mx-auto block rounded-full px-3 py-1.5 text-xs font-medium text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent"
      >
        Check for updates
      </button>
    </div>
  );
}
