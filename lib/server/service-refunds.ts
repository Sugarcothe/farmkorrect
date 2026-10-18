import "server-only";
import { MongoServerError, ObjectId } from "mongodb";
import { CURRENCY } from "@/lib/wallet/types";
import type { ServiceBookingDoc, ServiceRefundDoc } from "./models";
import { bestEffort } from "./order-store";
import {
  createRefund,
  fetchRefund,
  listRefunds,
  PaystackError,
  refundOutcome,
  verifyTransaction,
  type RefundResult,
} from "./paystack";
import { bookingCollections, bookingHistoryItem, flagBooking, notifyBooking } from "./service-booking-store";
import { syncBookingLedger } from "./service-ledger";

// Refunds to customers for bookings, through Paystack (docs/other-services.md).
// The same lifecycle and safeguards as order refunds (lib/server/order-refunds.ts):
//
//   creating ──► pending ──► processed
//      │            └──────► failed
//      └──────────────────► failed
//
// A booking is only ever refunded in full, once: the refund is created in
// the same transaction that ends the booking (which sets refundInFlight),
// and a unique index allows one refund per payment. It's sent at most once
// (sentAt is set first); a lost answer is found in Paystack's list of the
// transaction's refunds, or given up as failed (and flagged) after
// NOT_FOUND_GRACE_MS. Webhooks only trigger a lookup through the API.

export const SERVICE_REFUND_REFERENCE = /^fsr_[0-9a-f]{24}$/;
const NOT_FOUND_GRACE_MS = 30 * 60_000;

/** A refund document for a booking, ready to insert (status "creating"). */
export function newBookingRefund(
  booking: Pick<ServiceBookingDoc, "_id">,
  kind: ServiceRefundDoc["kind"],
  paymentReference: string,
  amountKobo: number,
  reason: string,
): ServiceRefundDoc {
  const now = new Date();
  const _id = new ObjectId();
  return {
    _id,
    bookingId: booking._id,
    kind,
    reference: `fsr_${_id.toHexString()}`,
    paymentReference,
    amountKobo,
    currency: CURRENCY,
    reason,
    status: "creating",
    providerRefundId: null,
    providerStatus: null,
    sentAt: null,
    processedAt: null,
    failedAt: null,
    lastCheckedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Returns a payment that succeeded after its booking stopped waiting for one
 * (it lapsed, was cancelled, or another attempt paid it). Never counts
 * towards the booking; returned in full, once per payment.
 */
export async function refundLateBookingPayment(
  booking: ServiceBookingDoc,
  paymentReference: string,
  amountKobo: number,
): Promise<void> {
  const { refunds } = await bookingCollections();
  const refund = newBookingRefund(
    booking,
    "late_payment",
    paymentReference,
    amountKobo,
    "Payment received after the booking closed",
  );
  try {
    await refunds.insertOne(refund);
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000) return; // already being returned
    throw error;
  }
  console.error(`[service-bookings] booking ${booking._id.toHexString()}: returning a late payment`);
  await sendRefund(refund);
}

// --- applying Paystack's answer ------------------------------------------------------

async function markProcessed(refund: ServiceRefundDoc, result: RefundResult | null) {
  const { refunds, bookings } = await bookingCollections();
  const now = new Date();
  const updated = await refunds.findOneAndUpdate(
    { _id: refund._id, status: { $in: ["creating", "pending"] } },
    {
      $set: {
        status: "processed",
        processedAt: now,
        providerStatus: result?.status ?? "processed",
        providerRefundId: result?.id ?? refund.providerRefundId,
        lastCheckedAt: now,
        updatedAt: now,
      },
    },
    { returnDocument: "after" },
  );
  if (!updated) return;
  if (refund.kind === "late_payment") {
    await bookings.updateOne(
      { _id: refund.bookingId },
      {
        $set: { notifySyncAt: now, updatedAt: now },
        $push: { history: bookingHistoryItem("late_payment_refunded", "system", null, now) },
      },
    );
    await notifyBooking(refund.bookingId);
    return;
  }
  await bookings.updateOne(
    { _id: refund.bookingId, refundInFlight: refund._id },
    {
      $set: {
        refundInFlight: null,
        paymentStatus: "refunded",
        ledgerSyncAt: now,
        notifySyncAt: now,
        updatedAt: now,
      },
      $inc: { refundedKobo: refund.amountKobo },
      $push: { history: bookingHistoryItem("refund_processed", "system", null, now) },
    },
  );
  await bestEffort("booking ledger sync", () => syncBookingLedger(refund.bookingId));
  await notifyBooking(refund.bookingId);
}

async function markFailed(refund: ServiceRefundDoc, providerStatus: string) {
  const { refunds, bookings } = await bookingCollections();
  const now = new Date();
  const updated = await refunds.findOneAndUpdate(
    { _id: refund._id, status: { $in: ["creating", "pending"] } },
    { $set: { status: "failed", failedAt: now, providerStatus, lastCheckedAt: now, updatedAt: now } },
  );
  if (!updated) return;
  await flagBooking(refund.bookingId, `refund ${refund.reference} failed (${providerStatus})`);
  if (refund.kind === "late_payment") return;
  // the provider's earning stays on hold until a person sorts it out
  await bookings.updateOne(
    { _id: refund.bookingId, refundInFlight: refund._id },
    {
      $set: { paymentStatus: "refund_failed", notifySyncAt: now, updatedAt: now },
      $push: { history: bookingHistoryItem("refund_failed", "system", null, now) },
    },
  );
  await notifyBooking(refund.bookingId);
}

async function applyResult(refund: ServiceRefundDoc, result: RefundResult) {
  if (result.amountKobo !== refund.amountKobo) {
    await flagBooking(refund.bookingId, `refund ${refund.reference} amount doesn't match Paystack's`);
    return;
  }
  const outcome = refundOutcome(result.status);
  if (outcome === "processed") return markProcessed(refund, result);
  if (outcome === "failed") return markFailed(refund, result.status);
  const now = new Date();
  const { refunds } = await bookingCollections();
  await refunds.updateOne(
    { _id: refund._id, status: { $in: ["creating", "pending"] } },
    {
      $set: {
        status: "pending",
        providerRefundId: result.id,
        providerStatus: result.status,
        lastCheckedAt: now,
        updatedAt: now,
      },
    },
  );
}

async function noteChecked(refund: ServiceRefundDoc) {
  const now = new Date();
  const { refunds } = await bookingCollections();
  await refunds.updateOne({ _id: refund._id }, { $set: { lastCheckedAt: now, updatedAt: now } });
}

// --- sending and reconciling -----------------------------------------------------------

async function sendRefund(refund: ServiceRefundDoc) {
  const { refunds } = await bookingCollections();
  const now = new Date();
  const marked = await refunds.updateOne(
    { _id: refund._id, status: "creating", sentAt: null },
    { $set: { sentAt: now, updatedAt: now } },
  );
  if (marked.modifiedCount !== 1) return;
  let result: RefundResult;
  try {
    result = await createRefund({
      transactionReference: refund.paymentReference,
      amountKobo: refund.amountKobo,
      note: refund.reference,
    });
  } catch (error) {
    if (error instanceof PaystackError && error.failure === "rejected") return markFailed(refund, "rejected");
    console.error(
      `[service-bookings] refund ${refund.reference}: outcome unknown (${error instanceof PaystackError ? error.failure : "error"})`,
    );
    return noteChecked(refund);
  }
  await applyResult(refund, result);
}

async function transactionIdFor(refund: ServiceRefundDoc): Promise<number | null> {
  const { payments } = await bookingCollections();
  const payment = await payments.findOne({ reference: refund.paymentReference });
  if (payment?.providerTransactionId) return payment.providerTransactionId;
  return (await verifyTransaction(refund.paymentReference))?.transactionId ?? null;
}

async function findLostRefund(refund: ServiceRefundDoc) {
  let found: RefundResult | undefined;
  try {
    const transactionId = await transactionIdFor(refund);
    if (transactionId === null) return noteChecked(refund);
    found = (await listRefunds(transactionId)).find((r) => r.amountKobo === refund.amountKobo);
  } catch (error) {
    if (!(error instanceof PaystackError)) throw error;
    return noteChecked(refund);
  }
  if (found) return applyResult(refund, found);
  if (Date.now() - (refund.sentAt?.getTime() ?? 0) >= NOT_FOUND_GRACE_MS) return markFailed(refund, "not_found");
  await noteChecked(refund);
}

/** Moves a refund forward: sends it (after putting the earning on hold) or asks Paystack what became of it. */
export async function continueBookingRefund(refundId: ObjectId): Promise<void> {
  const { refunds } = await bookingCollections();
  const refund = await refunds.findOne({ _id: refundId, status: { $in: ["creating", "pending"] } });
  if (!refund) return;
  if (refund.status === "creating" && !refund.sentAt) {
    if (refund.kind === "booking") await syncBookingLedger(refund.bookingId);
    return sendRefund(refund);
  }
  if (refund.status === "creating") return findLostRefund(refund);
  if (!refund.providerRefundId) return noteChecked(refund);
  let result: RefundResult | null;
  try {
    result = await fetchRefund(refund.providerRefundId);
  } catch (error) {
    if (!(error instanceof PaystackError)) throw error;
    return noteChecked(refund);
  }
  if (!result) return markFailed(refund, "not_found");
  await applyResult(refund, result);
}

/** A verified refund webhook for one of our booking payments: re-checks its open refunds. */
export async function handleBookingRefundEvent(paymentReference: string): Promise<"applied" | "ignored"> {
  const { refunds } = await bookingCollections();
  const open = await refunds.find({ paymentReference, status: { $in: ["creating", "pending"] } }).toArray();
  for (const refund of open) await continueBookingRefund(refund._id);
  return open.length ? "applied" : "ignored";
}

/** The job's share: refunds not yet settled, oldest first. */
export async function reconcileBookingRefunds(limit: number, olderThanMs: number): Promise<number> {
  const { refunds } = await bookingCollections();
  const before = new Date(Date.now() - olderThanMs);
  const open = await refunds
    .find({ status: { $in: ["creating", "pending"] }, updatedAt: { $lt: before } })
    .sort({ updatedAt: 1 })
    .limit(limit)
    .toArray();
  for (const refund of open)
    await bestEffort(`booking refund ${refund.reference}`, () => continueBookingRefund(refund._id));
  return open.length;
}
