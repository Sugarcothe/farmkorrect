import "server-only";
import type { ExceptionCategory, MoneyOutcome } from "@/lib/admin/types";
import type { PaymentStatus } from "@/lib/orders/types";
import type { ServicePaymentStatus } from "@/lib/services/marketplace";
import type { PayoutStatus } from "@/lib/wallet/types";

// Turns the reasons stored on flagged orders, bookings and payouts into
// what the admin area shows: a fixed category, a sanitized one-line reason,
// and what is known about the money. The stored reason is written by our
// own code, but a ledger refusal carries an internal error message and a
// provider status can be anything, so neither reaches the page verbatim.

const RULES: Array<[RegExp, ExceptionCategory]> = [
  [/^payment \S+ doesn't match/, "amount_mismatch"],
  [/amounts don't add up/, "totals_mismatch"],
  [/^refund \S+ failed/, "refund_failed"],
  [/^refund \S+ amount doesn't match/, "refund_mismatch"],
  [/^ledger refused/, "ledger_refused"],
  [/provider details don't match/, "provider_mismatch"],
  [/reported after payment|success reported while|after the payout had failed/i, "late_provider_event"],
  [/carried status/, "unexpected_provider_status"],
];

export function issueCategory(issue: string | null | undefined): ExceptionCategory {
  if (!issue) return "other";
  return RULES.find(([pattern]) => pattern.test(issue))?.[1] ?? "other";
}

/**
 * One safe line: internal error text after "ledger refused the …:" is
 * dropped, long digit runs (possible account or card numbers) are masked,
 * control characters removed, and the result clipped.
 */
export function sanitizeIssue(issue: string | null | undefined, max = 300): string {
  if (!issue) return "";
  let text = issue.replace(/[\u0000-\u001F\u007F]/g, " ").trim();
  const ledger = /^(ledger refused the \w+)/.exec(text);
  if (ledger) text = ledger[1];
  text = text.replace(/\d{6,}/g, (digits) => `••••${digits.slice(-4)}`);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function orderOutcome(paymentStatus: PaymentStatus): MoneyOutcome {
  if (paymentStatus === "paid" || paymentStatus === "partially_refunded" || paymentStatus === "refunded")
    return "confirmed";
  if (paymentStatus === "failed" || paymentStatus === "cancelled") return "failed";
  // money may have arrived against a pending order: nobody knows yet
  return "ambiguous";
}

export function bookingOutcome(paymentStatus: ServicePaymentStatus): MoneyOutcome {
  switch (paymentStatus) {
    case "paid":
    case "refunded":
      return "confirmed";
    case "failed":
    case "refund_failed":
      return "failed";
    case "refund_pending":
      return "in_progress";
    default:
      return "ambiguous";
  }
}

/** A payout whose last provider call had no clear answer is ambiguous, whatever its status says. */
export function payoutOutcome(status: PayoutStatus, providerStatus: string | null): MoneyOutcome {
  if (providerStatus === "unknown") return "ambiguous";
  if (status === "paid") return "confirmed";
  if (status === "failed") return "failed";
  return "in_progress";
}
