import "server-only";
import type { ObjectId } from "mongodb";
import { CURRENCY } from "@/lib/wallet/types";
import { ConfigError, getCommissionPolicy, type CommissionPolicy } from "./config";
import {
  closeDispute,
  LedgerConflictError,
  LedgerValidationError,
  openDispute,
  recordDelivery,
  recordEarning,
  recordRefund,
} from "./ledger";
import type { ServiceBookingDoc } from "./models";
import { commissionKobo, sellerRefundShare } from "./order-ledger";
import { bookingCollections, bookingLedgerSource, flagBooking } from "./service-booking-store";

// Keeps the provider's ledger in step with a booking, exactly as
// order-ledger does for a seller (same commission policy, same entries,
// source type "service_booking"). Derived only from the booking's own
// server-written state; every ledger call is idempotent.
//
// - earning: once the booking is paid *and* the provider has taken the job
//   (accepted it, or quoted the price that was paid), and a commission
//   policy is configured. A booking that ended before that never earns.
// - delivery: when the provider marked the job completed (starts the
//   24-hour window before the earning can be withdrawn).
// - refund: a refund Paystack confirmed, as the provider's share of it.
// - hold: while a refund is in flight the earning can't be withdrawn.

const ENDED_UNEARNED = ["declined", "expired"] as const;

function commissionPolicy(): CommissionPolicy | null {
  try {
    return getCommissionPolicy();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(`[service-bookings] commission configuration error: ${error.message}`);
    return null;
  }
}

const earns = (b: ServiceBookingDoc) =>
  b.paidAt !== null &&
  b.paymentReference !== null &&
  b.acceptedAt !== null &&
  !(ENDED_UNEARNED as readonly string[]).includes(b.status) &&
  b.status !== "cancelled";

/** Fixes the commission for a paid, accepted booking, once. */
async function settle(booking: ServiceBookingDoc, policy: CommissionPolicy): Promise<ServiceBookingDoc | null> {
  const { bookings } = await bookingCollections();
  const now = new Date();
  const settlement = {
    policyId: policy.id,
    rateBps: policy.rateBps,
    grossKobo: booking.paidKobo,
    feeKobo: commissionKobo(booking.paidKobo, policy.rateBps),
    settledAt: now,
  };
  await bookings.updateOne(
    // a booking that ended before it was settled never earned anything
    {
      _id: booking._id,
      settlement: null,
      paidAt: { $type: "date" },
      acceptedAt: { $type: "date" },
      status: { $nin: [...ENDED_UNEARNED, "cancelled"] },
    },
    { $set: { settlement, updatedAt: now } },
  );
  return bookings.findOne({ _id: booking._id });
}

async function apply(booking: ServiceBookingDoc) {
  if (!booking.settlement) {
    if (!earns(booking)) return;
    const policy = commissionPolicy();
    if (!policy) return;
    const settled = await settle(booking, policy);
    if (!settled?.settlement) return;
    booking = settled;
  }
  const settlement = booking.settlement!;
  const source = bookingLedgerSource(booking);

  await recordEarning({
    merchantUserId: booking.providerUserId,
    ...source,
    paymentReference: booking.paymentReference!,
    grossKobo: settlement.grossKobo,
    platformFeeKobo: settlement.feeKobo,
    currency: CURRENCY,
  });
  if (booking.completedAt) await recordDelivery({ ...source, deliveredAt: booking.completedAt });

  const { refunds, bookings } = await bookingCollections();
  const processed = await refunds
    .find({ bookingId: booking._id, kind: "booking", status: "processed" })
    .sort({ processedAt: 1, _id: 1 })
    .toArray();
  let before = 0;
  for (const refund of processed) {
    const after = before + refund.amountKobo;
    const share =
      sellerRefundShare(after, settlement.grossKobo, settlement.feeKobo) -
      sellerRefundShare(before, settlement.grossKobo, settlement.feeKobo);
    if (share > 0) await recordRefund({ ...source, refundId: refund.reference, amountKobo: share, currency: CURRENCY });
    before = after;
  }

  if (booking.refundInFlight !== null) {
    await openDispute(source);
  } else {
    await closeDispute(source);
    const current = await bookings.findOne({ _id: booking._id });
    if (current?.refundInFlight) await openDispute(source);
  }
}

/**
 * Brings the provider's ledger in line with the booking. The ledgerSyncAt
 * marker is only cleared if nothing changed while it ran, so the job
 * retries anything missed; a ledger refusal is flagged for review.
 */
export async function syncBookingLedger(bookingId: ObjectId): Promise<void> {
  const { bookings } = await bookingCollections();
  const booking = await bookings.findOne({ _id: bookingId });
  if (!booking) return;
  const marker = booking.ledgerSyncAt;
  try {
    await apply(booking);
  } catch (error) {
    if (!(error instanceof LedgerValidationError || error instanceof LedgerConflictError)) throw error;
    await flagBooking(booking._id, `ledger refused the booking: ${error.message}`);
  }
  if (marker) await bookings.updateOne({ _id: bookingId, ledgerSyncAt: marker }, { $set: { ledgerSyncAt: null } });
}
