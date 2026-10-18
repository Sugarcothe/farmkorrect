"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FormAlert } from "@/components/auth/auth-screen";
import { Button } from "@/components/ui/button";
import { SelectField, TextAreaField, TextField } from "@/components/ui/field";
import { changeServiceBooking, checkoutServiceBooking, verifyServicePayment } from "@/lib/services/api";
import { SERVICE_LIMITS } from "@/lib/services/config";
import {
  SERVICE_BOOKING_ACTION_LABELS,
  SERVICE_BOOKING_RULES,
  type ServiceBooking,
  type ServiceBookingAction,
  type ServicePaymentCheck,
} from "@/lib/services/marketplace";
import { formatDay, formatSlot } from "@/lib/vets/schedule";
import { formatKobo } from "@/lib/wallet/money";

const DONE: Record<ServiceBookingAction, string> = {
  accept: "Booking accepted. The customer has been notified.",
  decline: "Declined. The customer has been notified.",
  quote: "Quote sent. The customer has been notified.",
  accept_quote: "Quote accepted. Pay to confirm the booking.",
  reject_quote: "Quote rejected. The booking is closed.",
  en_route: "The customer has been told you're on the way.",
  start: "Job started.",
  complete: "Job marked as completed.",
  cancel: "Booking cancelled.",
};

/** Actions that ask first and take an optional reason. */
const ASKS_REASON: readonly ServiceBookingAction[] = ["decline", "cancel", "reject_quote"];

const VERIFY_RESULT: Record<ServicePaymentCheck, { tone: "error" | "success"; text: string }> = {
  paid: { tone: "success", text: "Payment confirmed by Paystack." },
  pending: {
    tone: "error",
    text: "Paystack hasn't confirmed this payment yet. If you paid, it will update here shortly — don't pay again.",
  },
  unknown: {
    tone: "error",
    text: "We couldn't check with Paystack just now. If you paid, it will update here shortly — don't pay again.",
  },
  failed: { tone: "error", text: "That payment didn't go through. You can try again." },
};

type Message = { tone: "error" | "success"; text: string };

/**
 * The buttons for what this viewer may do now. The server lists the allowed
 * actions and checks them again; each change carries the status shown here,
 * so acting on an out-of-date screen changes nothing.
 */
export function ServiceBookingActions({
  booking: b,
  returnedReference,
}: {
  booking: ServiceBooking;
  /** the reference Paystack sent the customer back with, if they just came back */
  returnedReference: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<ServiceBookingAction | "pay" | "verify" | null>(null);
  const [asking, setAsking] = useState<ServiceBookingAction | null>(null);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<Message | null>(null);
  const verified = useRef(false);

  // coming back from Paystack proves nothing: ask the server to check with Paystack
  useEffect(() => {
    if (!returnedReference || verified.current || b.viewer !== "customer") return;
    verified.current = true;
    void verify(returnedReference, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per return
  }, [returnedReference]);

  async function verify(reference: string | null, returning = false) {
    setBusy("verify");
    setMessage(null);
    const res = await verifyServicePayment(b.id, reference);
    setBusy(null);
    setMessage(res.ok ? VERIFY_RESULT[res.data.result] : { tone: "error", text: res.error });
    // drop ?reference= so a reload doesn't check again
    if (returning) router.replace(`/services/bookings/${b.id}`, { scroll: false });
    router.refresh();
  }

  async function pay() {
    setBusy("pay");
    setMessage(null);
    const res = await checkoutServiceBooking(b.id);
    if (!res.ok) {
      setBusy(null);
      setMessage({ tone: "error", text: res.error });
      router.refresh();
      return;
    }
    // stays locked while the browser leaves for Paystack
    window.location.assign(res.data.authorizationUrl);
  }

  async function run(action: ServiceBookingAction, quote?: { amountNgn: number; note?: string; validDays: number }) {
    setBusy(action);
    setMessage(null);
    const res = await changeServiceBooking(b.id, {
      action,
      expectedStatus: b.status,
      ...(reason.trim() ? { reason: reason.trim() } : {}),
      ...(quote ? { quote } : {}),
    });
    setBusy(null);
    setAsking(null);
    setReason("");
    setMessage(res.ok ? { tone: "success", text: DONE[action] } : { tone: "error", text: res.error });
    router.refresh();
  }

  const primary = b.actions.filter((a) => !ASKS_REASON.includes(a) && a !== "quote");
  const secondary = b.actions.filter((a) => ASKS_REASON.includes(a));
  const paying = b.viewer === "customer" && b.status === "awaiting_payment";

  return (
    <div className="space-y-3">
      {message && <FormAlert tone={message.tone}>{message.text}</FormAlert>}
      {busy === "verify" && (
        <p role="status" className="text-center text-sm text-muted-foreground">
          Checking your payment with Paystack…
        </p>
      )}

      {paying && (
        <section
          aria-labelledby="pay-heading"
          className="space-y-3 rounded-3xl bg-white px-4 py-4 shadow-sm ring-1 ring-foreground/5"
        >
          <div>
            <p className="text-[0.6875rem] font-semibold tracking-wide text-primary uppercase">Step 2 of 3</p>
            <h2 id="pay-heading" className="text-base font-semibold">
              Payment
            </h2>
          </div>
          {b.amountKobo !== null && (
            <p className="flex justify-between text-sm">
              <span className="text-muted-foreground">To pay</span>
              <span className="font-semibold tabular-nums">{formatKobo(b.amountKobo)}</span>
            </p>
          )}
          <p className="text-xs leading-relaxed text-muted-foreground">
            Paid securely with Paystack. There&rsquo;s no booking fee.
            {b.payBy ? ` Pay by ${formatSlot(b.payBy)} or this booking lapses.` : ""} Nothing is confirmed until
            Paystack confirms the payment to us.
          </p>
          {b.canPay ? (
            <Button type="button" loading={busy === "pay"} disabled={busy !== null} onClick={() => void pay()}>
              {busy === "pay" ? "Opening Paystack…" : `Pay ${b.amountKobo !== null ? formatKobo(b.amountKobo) : ""}`}
            </Button>
          ) : (
            <p className="text-sm text-amber-800">Payments aren&rsquo;t available right now. Please try again later.</p>
          )}
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void verify(null)}
            className="mx-auto block rounded-full px-3 py-1.5 text-xs font-medium text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
          >
            I&rsquo;ve paid — check again
          </button>
        </section>
      )}

      {b.actions.includes("quote") &&
        (asking === "quote" ? (
          <QuoteForm busy={busy === "quote"} onCancel={() => setAsking(null)} onSend={(q) => void run("quote", q)} />
        ) : (
          <Button type="button" disabled={busy !== null} onClick={() => setAsking("quote")}>
            {SERVICE_BOOKING_ACTION_LABELS.quote}
          </Button>
        ))}

      {primary.map((a) => (
        <Button key={a} type="button" loading={busy === a} disabled={busy !== null} onClick={() => void run(a)}>
          {a === "accept_quote" && b.quote
            ? `Accept quote (${formatKobo(b.quote.amountKobo)})`
            : SERVICE_BOOKING_ACTION_LABELS[a]}
        </Button>
      ))}

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
            <p className="text-sm">{confirmText(b, a)}</p>
            <TextField
              name="reason"
              label="Reason (optional, shared with the other party)"
              value={reason}
              maxLength={SERVICE_BOOKING_RULES.reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <div className="grid grid-cols-2 gap-3">
              <Button type="button" variant="outline" disabled={busy !== null} onClick={() => setAsking(null)}>
                Keep it
              </Button>
              <Button type="submit" loading={busy === a}>
                {SERVICE_BOOKING_ACTION_LABELS[a]}
              </Button>
            </div>
          </form>
        ) : (
          <Button key={a} type="button" variant="outline" disabled={busy !== null} onClick={() => setAsking(a)}>
            {SERVICE_BOOKING_ACTION_LABELS[a]}
          </Button>
        ),
      )}

      <Deadlines booking={b} />

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

function confirmText(b: ServiceBooking, action: ServiceBookingAction) {
  const paid = b.paymentStatus === "paid";
  if (action === "reject_quote") return "Reject this quote? The booking will be closed. Nothing has been charged.";
  if (action === "decline")
    return paid ? "Decline this job? The customer gets a full refund." : "Decline this request?";
  if (b.viewer === "provider")
    return paid ? "Cancel this job? The customer gets a full refund." : "Cancel this booking?";
  return paid ? "Cancel this booking? You'll get a full refund." : "Cancel this booking? Nothing has been charged.";
}

function Deadlines({ booking: b }: { booking: ServiceBooking }) {
  const provider = b.viewer === "provider";
  const lines: string[] = [];
  if (b.status === "requested" && b.respondBy)
    lines.push(
      provider
        ? `Respond by ${formatSlot(b.respondBy)}.`
        : `The provider has until ${formatSlot(b.respondBy)} to respond.`,
    );
  if (b.status === "quote_offered" && b.quote)
    lines.push(
      provider
        ? `Your quote is valid until ${formatSlot(b.quote.validUntil)}.`
        : `This quote is valid until ${formatSlot(b.quote.validUntil)}.`,
    );
  if (b.status === "confirmed" && !provider)
    lines.push(
      b.actions.includes("cancel") && b.cancelUntil
        ? `You can cancel for a full refund until the end of ${formatDay(b.cancelUntil)}.`
        : "It's too close to the booked day to cancel here. Contact the provider directly.",
    );
  if (lines.length === 0) return null;
  return (
    <div className="space-y-1">
      {lines.map((l) => (
        <p key={l} className="text-center text-xs text-muted-foreground">
          {l}
        </p>
      ))}
    </div>
  );
}

const VALID_DAY_OPTIONS = Array.from(
  { length: SERVICE_BOOKING_RULES.quoteValidDays.max - SERVICE_BOOKING_RULES.quoteValidDays.min + 1 },
  (_, i) => {
    const days = SERVICE_BOOKING_RULES.quoteValidDays.min + i;
    return { value: String(days), label: days === 1 ? "1 day" : `${days} days` };
  },
);

/** The provider's price for a quote request, in whole naira. */
function QuoteForm({
  busy,
  onCancel,
  onSend,
}: {
  busy: boolean;
  onCancel: () => void;
  onSend: (quote: { amountNgn: number; note?: string; validDays: number }) => void;
}) {
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [validDays, setValidDays] = useState(String(SERVICE_BOOKING_RULES.quoteValidDays.default));
  const [errors, setErrors] = useState<{ amount?: string; note?: string }>({});

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const raw = amount.replace(/[\s,₦]/g, "");
        const n = Number(raw);
        const found: typeof errors = {};
        if (!/^\d+$/.test(raw) || n < 1 || n > SERVICE_LIMITS.maxPriceNgn)
          found.amount = "Enter the price in whole naira, e.g. 25000.";
        if (note.trim().length > SERVICE_BOOKING_RULES.quoteNote)
          found.note = `Keep the note to ${SERVICE_BOOKING_RULES.quoteNote} characters.`;
        setErrors(found);
        if (Object.keys(found).length > 0) return;
        onSend({ amountNgn: n, ...(note.trim() ? { note: note.trim() } : {}), validDays: Number(validDays) });
      }}
      noValidate
      className="space-y-3 rounded-2xl bg-white p-4 ring-1 ring-foreground/8"
    >
      <TextField
        name="quote.amountNgn"
        label="Your price (₦)"
        inputMode="numeric"
        placeholder="e.g. 25,000"
        value={amount}
        error={errors.amount}
        hint="The full amount the customer pays. There's no booking fee on top."
        onChange={(e) => setAmount(e.target.value)}
      />
      <TextAreaField
        name="quote.note"
        label="Note (optional)"
        placeholder="What the price covers."
        maxLength={SERVICE_BOOKING_RULES.quoteNote + 50}
        value={note}
        error={errors.note}
        onChange={(e) => setNote(e.target.value)}
      />
      <SelectField
        name="quote.validDays"
        label="Valid for"
        placeholder="Choose"
        options={VALID_DAY_OPTIONS}
        value={validDays}
        hint="Never past the start of the booked day."
        onChange={(e) => setValidDays(e.target.value)}
      />
      <div className="grid grid-cols-2 gap-3">
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          Back
        </Button>
        <Button type="submit" loading={busy}>
          Send quote
        </Button>
      </div>
    </form>
  );
}
