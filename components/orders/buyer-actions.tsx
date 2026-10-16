"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FormAlert } from "@/components/auth/auth-screen";
import { Button } from "@/components/ui/button";
import { TextAreaField } from "@/components/ui/field";
import { formatDate } from "@/components/wallet/wallet-parts";
import { cancelOrder, reportIssue, startCheckout, verifyPayment } from "@/lib/orders/api";
import { ORDER_LIMITS, type Order, type PaymentCheck } from "@/lib/orders/types";
import { validateIssueNote } from "@/lib/orders/validation";
import { cleanText } from "@/lib/profile/validation";

const CHECK_MESSAGES: Record<Exclude<PaymentCheck, "paid">, string> = {
  pending:
    "Paystack hasn't confirmed this payment yet. If you completed it, it can take a moment; check again shortly. Your order isn't paid until it's confirmed.",
  failed: "That payment didn't go through. You weren't charged for it; you can try again.",
  unknown: "We couldn't reach Paystack to confirm your payment. Nothing is lost; check again in a moment.",
};

/**
 * What the buyer can do with their order. The server lists the allowed
 * actions; this only offers them. Returning from Paystack's checkout page
 * proves nothing by itself: the order is checked with Paystack on the
 * server, and shown as paid only when that check says so.
 */
export function BuyerActions({ order, returnedReference }: { order: Order; returnedReference: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "pay" | "check" | "cancel" | "issue">(null);
  const [message, setMessage] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const [issueOpen, setIssueOpen] = useState(false);
  const [note, setNote] = useState("");
  const [noteTouched, setNoteTouched] = useState(false);
  const checkedOnReturn = useRef(false);

  const awaitingPayment = order.paymentStatus === "pending" || order.paymentStatus === "failed";
  const paymentStarted = order.history.some((h) => h.event === "payment_started");

  async function check(reference: string | null) {
    setBusy("check");
    setMessage(null);
    const res = await verifyPayment(order.id, reference);
    setBusy(null);
    if (!res.ok) return setMessage({ tone: "error", text: res.error });
    if (res.data.result === "paid") {
      setMessage({ tone: "success", text: "Payment confirmed by Paystack. The seller has been notified of your order." });
      router.replace(`/orders/${order.id}`);
      router.refresh();
      return;
    }
    setMessage({ tone: "error", text: CHECK_MESSAGES[res.data.result] });
    router.refresh();
  }

  // back from Paystack: ask the server to confirm, once
  useEffect(() => {
    if (!returnedReference || !awaitingPayment || checkedOnReturn.current) return;
    checkedOnReturn.current = true;
    void check(returnedReference);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per return from checkout
  }, [returnedReference, awaitingPayment]);

  async function pay() {
    setBusy("pay");
    setMessage(null);
    const res = await startCheckout(order.id);
    if (!res.ok) {
      setBusy(null);
      setMessage({ tone: "error", text: res.error });
      router.refresh();
      return;
    }
    window.location.assign(res.data.authorizationUrl);
  }

  async function cancel() {
    const paid = order.paymentStatus === "paid";
    const prompt = paid
      ? "Cancel this order? Your payment will be refunded in full through Paystack."
      : "Cancel this order? The seller's stock is released.";
    if (!window.confirm(prompt)) return;
    setBusy("cancel");
    setMessage(null);
    const res = await cancelOrder(order.id, "");
    setBusy(null);
    if (!res.ok) return setMessage({ tone: "error", text: res.error });
    const refunded = res.data.order.paymentStatus === "refunded";
    const refunding = res.data.order.refundPendingKobo > 0;
    setMessage({
      tone: "success",
      text: refunded
        ? "Order cancelled and your payment refunded. It can take a few working days to reach your account."
        : refunding
          ? "Order cancelled. Your refund has been sent to Paystack and is being processed."
          : "Order cancelled.",
    });
    router.refresh();
  }

  const noteError = validateIssueNote(note);

  async function submitIssue(e: React.FormEvent) {
    e.preventDefault();
    setNoteTouched(true);
    if (noteError) return;
    setBusy("issue");
    setMessage(null);
    const res = await reportIssue(order.id, cleanText(note, true));
    setBusy(null);
    if (!res.ok) return setMessage({ tone: "error", text: res.error });
    setIssueOpen(false);
    setMessage({ tone: "success", text: "Problem reported. Our team will look into it with the seller." });
    router.refresh();
  }

  const can = (action: Order["actions"][number]) => order.actions.includes(action);

  return (
    <div className="space-y-3">
      {busy === "check" && (
        <p role="status" className="rounded-2xl bg-foreground/5 px-4 py-3 text-sm text-foreground/75">
          Checking your payment with Paystack…
        </p>
      )}
      {message && <FormAlert tone={message.tone}>{message.text}</FormAlert>}

      {can("pay") && order.payBy && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Pay by {formatDate(order.payBy, true)} or the order is cancelled and the stock released.
        </p>
      )}
      {can("pay") && (
        <Button type="button" loading={busy === "pay"} disabled={busy !== null} onClick={pay}>
          {busy === "pay" ? "Opening Paystack…" : order.paymentStatus === "failed" ? "Try paying again" : "Pay with Paystack"}
        </Button>
      )}
      {awaitingPayment && paymentStarted && (
        <Button type="button" variant="outline" loading={busy === "check"} disabled={busy !== null} onClick={() => check(null)}>
          I&apos;ve paid, check again
        </Button>
      )}

      {can("report_issue") && !issueOpen && (
        <>
          {order.reportIssueUntil && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Something wrong with your order? You can report it until {formatDate(order.reportIssueUntil, true)}.
            </p>
          )}
          <Button type="button" variant="outline" disabled={busy !== null} onClick={() => setIssueOpen(true)}>
            Report a problem
          </Button>
        </>
      )}
      {issueOpen && (
        <form onSubmit={submitIssue} noValidate className="space-y-3 rounded-3xl bg-white p-4 shadow-sm ring-1 ring-foreground/5">
          <TextAreaField
            name="note"
            label="What went wrong?"
            placeholder="e.g. 6 of the eggs arrived cracked."
            maxLength={ORDER_LIMITS.issueNote.max + 50}
            value={note}
            error={noteTouched ? noteError : undefined}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => setNoteTouched(true)}
          />
          <div className="grid grid-cols-2 gap-3">
            <Button type="button" variant="outline" disabled={busy !== null} onClick={() => setIssueOpen(false)}>
              Back
            </Button>
            <Button type="submit" loading={busy === "issue"}>
              {busy === "issue" ? "Sending…" : "Report"}
            </Button>
          </div>
        </form>
      )}

      {can("cancel") && (
        <Button type="button" variant="ghost" className="text-red-600 hover:text-red-700" loading={busy === "cancel"} disabled={busy !== null} onClick={cancel}>
          {busy === "cancel" ? "Cancelling…" : "Cancel order"}
        </Button>
      )}
    </div>
  );
}
