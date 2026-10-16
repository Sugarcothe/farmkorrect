"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FormAlert } from "@/components/auth/auth-screen";
import { Button } from "@/components/ui/button";
import { TextAreaField, TextField } from "@/components/ui/field";
import { cancelSale, fulfilSale, refundSale } from "@/lib/orders/api";
import { ORDER_LIMITS, type FulfillmentAction, type Order } from "@/lib/orders/types";
import { validateRefundReason } from "@/lib/orders/validation";
import { cleanText } from "@/lib/profile/validation";
import { formatKobo, koboToInput, parseNairaToKobo } from "@/lib/wallet/money";

const STEPS: Record<FulfillmentAction, { label: string; busy: string; done: string; confirm?: string }> = {
  accept: { label: "Accept order", busy: "Accepting…", done: "Order accepted. The buyer can no longer cancel it." },
  ship: { label: "Mark as sent", busy: "Saving…", done: "Marked as on the way." },
  deliver: {
    label: "Mark as delivered",
    busy: "Saving…",
    done: "Marked as delivered. Your earning becomes available 24 hours from now unless the buyer reports a problem.",
    confirm: "Mark this order as delivered? Only do this once the buyer has received it.",
  },
};

type Busy = null | FulfillmentAction | "cancel" | "refund";

/**
 * What the seller can do with an order: move it along, cancel it (refunding
 * the buyer if they paid) or refund part of it after delivery. The server
 * lists the allowed actions and records the time of each step itself.
 */
export function SellerActions({ order }: { order: Order }) {
  const router = useRouter();
  const [busy, setBusy] = useState<Busy>(null);
  const [message, setMessage] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const [panel, setPanel] = useState<null | "cancel" | "refund">(null);
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState(() => koboToInput(order.refundableKobo));
  const [touched, setTouched] = useState(false);
  // one key per refund the seller fills in, so a retry can't refund twice
  const [refundKey, setRefundKey] = useState(() => crypto.randomUUID());

  const can = (action: Order["actions"][number]) => order.actions.includes(action);
  const steps = (["accept", "ship", "deliver"] as const).filter(can);

  async function step(action: FulfillmentAction) {
    if (STEPS[action].confirm && !window.confirm(STEPS[action].confirm)) return;
    setBusy(action);
    setMessage(null);
    const res = await fulfilSale(order.id, action);
    setBusy(null);
    if (!res.ok) return setMessage({ tone: "error", text: res.error });
    setMessage({ tone: "success", text: STEPS[action].done });
    router.refresh();
  }

  const reasonError = validateRefundReason(reason);
  const amountKobo = parseNairaToKobo(amount);
  const amountError =
    amountKobo === null || amountKobo < 1
      ? "Enter an amount in naira."
      : amountKobo > order.refundableKobo
        ? `You can refund up to ${formatKobo(order.refundableKobo)}.`
        : undefined;

  function open(which: "cancel" | "refund") {
    setPanel(which);
    setReason("");
    setAmount(koboToInput(order.refundableKobo));
    setTouched(false);
    setMessage(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (reasonError || (panel === "refund" && amountError)) return;
    setBusy(panel);
    setMessage(null);
    const res =
      panel === "cancel"
        ? await cancelSale(order.id, cleanText(reason, true))
        : await refundSale(order.id, { amountKobo: amountKobo!, reason: cleanText(reason, true), idempotencyKey: refundKey });
    setBusy(null);
    if (!res.ok) return setMessage({ tone: "error", text: res.error });
    const after = res.data.order;
    setPanel(null);
    setRefundKey(crypto.randomUUID());
    setMessage({
      tone: "success",
      text:
        after.refundPendingKobo > 0
          ? `${panel === "cancel" ? "Order cancelled. " : ""}The refund was sent to Paystack and is being processed; it's held from your earnings until it completes.`
          : panel === "cancel"
            ? after.refundedKobo > 0
              ? "Order cancelled and the buyer refunded."
              : "Order cancelled and the stock returned to your listing."
            : "Refund completed.",
    });
    router.refresh();
  }

  if (steps.length === 0 && !can("cancel") && !can("refund") && !message) return null;

  return (
    <div className="space-y-3">
      {message && <FormAlert tone={message.tone}>{message.text}</FormAlert>}

      {steps.map((action) => (
        <Button key={action} type="button" loading={busy === action} disabled={busy !== null} onClick={() => step(action)}>
          {busy === action ? STEPS[action].busy : STEPS[action].label}
        </Button>
      ))}

      {panel ? (
        <form onSubmit={submit} noValidate className="space-y-3 rounded-3xl bg-white p-4 shadow-sm ring-1 ring-foreground/5">
          <h3 className="text-sm font-semibold">{panel === "cancel" ? "Cancel this order" : "Refund the buyer"}</h3>
          {panel === "cancel" && order.paymentStatus === "paid" && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              The buyer is refunded {formatKobo(order.refundableKobo)} in full through Paystack.
            </p>
          )}
          {panel === "refund" && (
            <TextField
              name="amount"
              label="Amount (₦)"
              inputMode="decimal"
              value={amount}
              hint={`Up to ${formatKobo(order.refundableKobo)}. Taken from your earnings for this order.`}
              error={touched ? amountError : undefined}
              onChange={(e) => setAmount(e.target.value)}
              onBlur={() => setTouched(true)}
            />
          )}
          <TextAreaField
            name="reason"
            label="Reason"
            maxLength={ORDER_LIMITS.refundReason.max + 50}
            value={reason}
            error={touched ? reasonError : undefined}
            onChange={(e) => setReason(e.target.value)}
            onBlur={() => setTouched(true)}
          />
          <div className="grid grid-cols-2 gap-3">
            <Button type="button" variant="outline" disabled={busy !== null} onClick={() => setPanel(null)}>
              Back
            </Button>
            <Button type="submit" loading={busy === panel}>
              {busy === panel ? "Sending…" : panel === "cancel" ? "Cancel order" : "Refund"}
            </Button>
          </div>
        </form>
      ) : (
        <>
          {can("refund") && (
            <Button type="button" variant="outline" disabled={busy !== null} onClick={() => open("refund")}>
              Refund the buyer
            </Button>
          )}
          {can("cancel") && (
            <Button type="button" variant="ghost" className="text-red-600 hover:text-red-700" disabled={busy !== null} onClick={() => open("cancel")}>
              Cancel order
            </Button>
          )}
        </>
      )}
    </div>
  );
}
