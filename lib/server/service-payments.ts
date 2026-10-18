import "server-only";
import { MongoServerError, ObjectId } from "mongodb";
import {
  SERVICE_BOOKING_RULES,
  type ServiceCheckoutResponse,
  type ServicePaymentCheck,
} from "@/lib/services/marketplace";
import { lagosInstant } from "@/lib/vets/schedule";
import { CURRENCY } from "@/lib/wallet/types";
import { getAuthConfig } from "./config";
import { HttpError } from "./http";
import type { ServiceBookingDoc, ServicePaymentDoc, UserDoc } from "./models";
import { PAYMENTS_OFF, paymentsEnabled } from "./order-payments";
import { bestEffort, inTransaction } from "./order-store";
import {
  initializeTransaction,
  PaystackError,
  transactionOutcome,
  verifyTransaction,
  type TransactionResult,
} from "./paystack";
import { bookingCollections, bookingHistoryItem, flagBooking, notifyBooking } from "./service-booking-store";
import { syncBookingLedger } from "./service-ledger";
import { refundLateBookingPayment } from "./service-refunds";

// Collecting a booking's price through Paystack (docs/other-services.md),
// with the same attempt lifecycle as order payments:
//
//   initializing ──► open ──► success
//        │             └────► failed      (the customer may try again)
//        └──► superseded                  (never reached the customer)
//   open ──► closed                       (the booking ended unpaid)
//
// The amount is always the booking's own agreed price in kobo (the
// service's fixed price, or the quote the customer accepted), never one
// from the browser, and no fee is added. One attempt per booking is active
// at a time (a unique index). Coming back from Paystack proves nothing: a
// booking is only marked paid once the transaction is verified through the
// API and its reference, amount, currency, booking and status all match.
// Anything ambiguous stays pending; a mismatch is flagged for a person. A
// payment that succeeds after the booking stopped waiting for one is
// returned in full.

export const SERVICE_PAYMENT_REFERENCE = /^fsp_[0-9a-f]{24}$/;
const PAYSTACK_DOWN = "We couldn't reach our payment provider. Please try again in a minute.";
const START_GRACE_MS = 60_000;

async function setAttempt(
  payment: ServicePaymentDoc,
  from: ServicePaymentDoc["status"][],
  set: Partial<ServicePaymentDoc>,
) {
  const { payments } = await bookingCollections();
  const now = new Date();
  return payments.findOneAndUpdate(
    { _id: payment._id, status: { $in: from } },
    { $set: { ...set, lastCheckedAt: now, updatedAt: now } },
    { returnDocument: "after" },
  );
}

/** Whether the customer can pay this booking now. */
export const isBookingPayable = (b: ServiceBookingDoc, now = new Date()) =>
  b.status === "awaiting_payment" &&
  (b.paymentStatus === "pending" || b.paymentStatus === "failed") &&
  b.amountKobo !== null &&
  b.amountKobo > 0 &&
  b.payBy !== null &&
  b.payBy > now;

/** When the provider must answer a paid fixed-price request: 24 hours, or the start of the booked day if sooner. */
export const respondByFor = (date: string, now: Date) =>
  new Date(Math.min(now.getTime() + SERVICE_BOOKING_RULES.respondWithinMs, lagosInstant(date, 0).getTime()));

// --- applying a verified transaction --------------------------------------------------

async function markPaid(payment: ServicePaymentDoc, transaction: TransactionResult): Promise<ServicePaymentCheck> {
  const { bookings, payments } = await bookingCollections();
  const now = new Date();
  const booking = await bookings.findOne({ _id: payment.bookingId });
  if (!booking) return "unknown";
  const quoted = booking.service.pricing === "quote";
  const next = quoted ? "confirmed" : "requested";
  const updated = await inTransaction(async (session) => {
    await payments.updateOne(
      { _id: payment._id, status: { $ne: "success" } },
      {
        $set: {
          status: "success",
          active: false,
          providerStatus: transaction.status,
          providerTransactionId: transaction.transactionId,
          paidAt: transaction.paidAt ?? now,
          lastCheckedAt: now,
          updatedAt: now,
        },
      },
      { session },
    );
    const result = await bookings.updateOne(
      {
        _id: payment.bookingId,
        status: "awaiting_payment",
        paymentStatus: { $in: ["pending", "failed"] },
        amountKobo: payment.amountKobo,
      },
      {
        $set: {
          status: next,
          paymentStatus: "paid",
          paymentReference: payment.reference,
          paidKobo: transaction.amountKobo,
          paidAt: now,
          payBy: null,
          // a quoted price was the provider's own offer: paying it confirms the job
          ...(quoted ? { acceptedAt: now } : { respondBy: respondByFor(booking.schedule.date, now) }),
          ledgerSyncAt: now,
          notifySyncAt: now,
          updatedAt: now,
        },
        $push: {
          history: {
            $each: [bookingHistoryItem("paid", "system", null, now), bookingHistoryItem(next, "system", null, now)],
          },
        },
      },
      { session },
    );
    return result.modifiedCount === 1;
  });
  if (updated) {
    await bestEffort("booking ledger sync", () => syncBookingLedger(payment.bookingId));
    await notifyBooking(payment.bookingId);
    return "paid";
  }
  const current = await bookings.findOne({ _id: payment.bookingId });
  if (!current) return "unknown";
  if (current.paymentReference === payment.reference) return "paid";
  // the booking lapsed, was cancelled or was paid by another attempt meanwhile
  await refundLateBookingPayment(current, payment.reference, transaction.amountKobo);
  return current.paymentReference ? "paid" : "failed";
}

async function applyTransaction(
  payment: ServicePaymentDoc,
  transaction: TransactionResult,
): Promise<ServicePaymentCheck> {
  const outcome = transactionOutcome(transaction.status);
  if (outcome === "success") {
    const booking = await (await bookingCollections()).bookings.findOne({ _id: payment.bookingId });
    const matches =
      transaction.reference === payment.reference &&
      transaction.amountKobo === payment.amountKobo &&
      (!booking || booking.amountKobo === payment.amountKobo) &&
      transaction.currency === CURRENCY &&
      transaction.orderId === payment.bookingId.toHexString();
    if (!matches) {
      // money arrived, but not what we asked for: a person decides
      await setAttempt(payment, ["initializing", "open", "failed", "superseded", "closed"], {
        status: "success",
        active: false,
        providerStatus: transaction.status,
        providerTransactionId: transaction.transactionId,
      });
      await flagBooking(payment.bookingId, `payment ${payment.reference} doesn't match the booking`);
      return "pending";
    }
    return markPaid(payment, transaction);
  }

  if (outcome === "failed") {
    const failed = await setAttempt(payment, ["initializing", "open"], {
      status: "failed",
      active: false,
      providerStatus: transaction.status,
      providerTransactionId: transaction.transactionId,
    });
    if (failed) {
      const { bookings } = await bookingCollections();
      const now = new Date();
      const marked = await bookings.updateOne(
        { _id: payment.bookingId, status: "awaiting_payment", paymentStatus: "pending" },
        {
          $set: { paymentStatus: "failed", notifySyncAt: now, updatedAt: now },
          $push: { history: bookingHistoryItem("payment_failed", "system", null, now) },
        },
      );
      if (marked.modifiedCount === 1) await notifyBooking(payment.bookingId);
    }
    return "failed";
  }

  await setAttempt(payment, ["initializing", "open"], {
    providerStatus: transaction.status,
    providerTransactionId: transaction.transactionId,
  });
  return "pending";
}

/** Asks Paystack about one attempt and applies the answer; "unknown" when it can't be reached. */
export async function checkBookingAttempt(payment: ServicePaymentDoc): Promise<ServicePaymentCheck> {
  let transaction: TransactionResult | null;
  try {
    transaction = await verifyTransaction(payment.reference);
  } catch (error) {
    if (!(error instanceof PaystackError)) throw error;
    return "unknown";
  }
  if (transaction) return applyTransaction(payment, transaction);
  if (payment.status === "initializing" && Date.now() - payment.createdAt.getTime() >= START_GRACE_MS) {
    await setAttempt(payment, ["initializing"], { status: "superseded", active: false, providerStatus: "not_found" });
    return "failed";
  }
  return payment.status === "failed" ? "failed" : "pending";
}

// --- the customer's checkout ----------------------------------------------------------

async function startAttempt(booking: ServiceBookingDoc, customer: UserDoc): Promise<ServiceCheckoutResponse> {
  const { payments } = await bookingCollections();
  const now = new Date();
  const _id = new ObjectId();
  const payment: ServicePaymentDoc = {
    _id,
    bookingId: booking._id,
    customerUserId: booking.customerUserId,
    reference: `fsp_${_id.toHexString()}`,
    amountKobo: booking.amountKobo!,
    currency: CURRENCY,
    status: "initializing",
    active: true,
    authorizationUrl: null,
    providerStatus: null,
    providerTransactionId: null,
    paidAt: null,
    lastCheckedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await payments.insertOne(payment);
  } catch (error) {
    if (error instanceof MongoServerError && error.code === 11000)
      throw new HttpError(409, "Your payment is already being set up. Please try again in a moment.");
    throw error;
  }

  let authorizationUrl: string;
  try {
    ({ authorizationUrl } = await initializeTransaction({
      email: customer.emailNormalized,
      amountKobo: payment.amountKobo,
      reference: payment.reference,
      callbackUrl: `${getAuthConfig().appOrigin}/services/bookings/${booking._id.toHexString()}`,
      orderId: booking._id.toHexString(),
      orderNumber: booking.reference,
    }));
  } catch (error) {
    if (error instanceof PaystackError && error.failure !== "unavailable") {
      await setAttempt(payment, ["initializing"], { status: "failed", active: false, providerStatus: error.failure });
      if (error.failure === "misconfigured") throw new HttpError(503, PAYMENTS_OFF);
      throw new HttpError(502, "Our payment provider couldn't start this payment. Please try again.");
    }
    throw new HttpError(503, PAYSTACK_DOWN);
  }
  await setAttempt(payment, ["initializing"], { status: "open", authorizationUrl, providerStatus: "initialized" });
  return { authorizationUrl, reference: payment.reference };
}

/**
 * The checkout page for the customer's booking: the open attempt's if
 * Paystack still considers it payable, otherwise a new one. Never starts a
 * second attempt while an earlier one might still be paid.
 */
export async function checkoutBooking(booking: ServiceBookingDoc, customer: UserDoc): Promise<ServiceCheckoutResponse> {
  if (booking.paymentStatus === "paid") throw new HttpError(409, "This booking is already paid.");
  if (!isBookingPayable(booking)) throw new HttpError(409, "This booking can't be paid now. Reload to see its status.");
  if (!paymentsEnabled()) throw new HttpError(503, PAYMENTS_OFF);
  const { payments, bookings } = await bookingCollections();
  const active = await payments.findOne({ bookingId: booking._id, active: true });
  if (active) {
    const result = await checkBookingAttempt(active);
    if (result === "paid") throw new HttpError(409, "This booking is already paid.");
    if (result === "unknown") throw new HttpError(503, PAYSTACK_DOWN);
    if (result === "pending") {
      const current = await payments.findOne({ _id: active._id });
      if (
        current?.active &&
        current.status === "open" &&
        current.authorizationUrl &&
        current.amountKobo === booking.amountKobo
      )
        return { authorizationUrl: current.authorizationUrl, reference: current.reference };
      if (current?.active && current.status === "initializing")
        throw new HttpError(409, "Your payment is still being set up. Please try again in a minute.");
      if (current?.active) await setAttempt(current, ["initializing", "open"], { status: "superseded", active: false });
    }
    const fresh = await bookings.findOne({ _id: booking._id });
    if (!fresh || !isBookingPayable(fresh)) throw new HttpError(409, "This booking can no longer be paid.");
  }
  return startAttempt(booking, customer);
}

/**
 * Checks the booking's payment with Paystack when the customer returns.
 * `reference` (from the return URL) is only used if it's one of this
 * booking's own attempts.
 */
export async function verifyBookingPayment(
  booking: ServiceBookingDoc,
  reference: string | null,
): Promise<ServicePaymentCheck> {
  if (booking.paymentStatus !== "pending" && booking.paymentStatus !== "failed")
    return booking.paymentStatus === "none" ? "failed" : "paid";
  const { payments } = await bookingCollections();
  const attempt =
    (reference && SERVICE_PAYMENT_REFERENCE.test(reference)
      ? await payments.findOne({ bookingId: booking._id, reference })
      : null) ?? (await payments.findOne({ bookingId: booking._id, active: true }));
  if (!attempt) return booking.paymentStatus === "failed" ? "failed" : "pending";
  if (!paymentsEnabled()) return "unknown";
  return checkBookingAttempt(attempt);
}

/**
 * Before an unpaid booking is ended, its active attempt is settled: "paid"
 * if it turned out to be paid, "unknown" if Paystack can't be reached,
 * otherwise "clear" (closeBookingAttempts then closes it).
 */
export async function settleBookingAttempt(bookingId: ObjectId): Promise<"paid" | "unknown" | "clear"> {
  const { payments } = await bookingCollections();
  const active = await payments.findOne({ bookingId, active: true });
  if (!active) return "clear";
  if (!paymentsEnabled()) return active.status === "initializing" || active.status === "open" ? "unknown" : "clear";
  const result = await checkBookingAttempt(active);
  return result === "paid" ? "paid" : result === "unknown" ? "unknown" : "clear";
}

/** Closes attempts still open for a booking that ended unpaid; paying one later is refunded. */
export async function closeBookingAttempts(bookingId: ObjectId) {
  const { payments } = await bookingCollections();
  await payments.updateMany(
    { bookingId, active: true },
    { $set: { status: "closed", active: false, updatedAt: new Date() } },
  );
}

// --- webhooks and the job --------------------------------------------------------------

/** A verified charge.success webhook for a booking payment; throws while Paystack can't be reached, so it's retried. */
export async function handleBookingChargeEvent(reference: string): Promise<"applied" | "ignored"> {
  if (!SERVICE_PAYMENT_REFERENCE.test(reference)) return "ignored";
  const { payments } = await bookingCollections();
  const payment = await payments.findOne({ reference });
  if (!payment) return "ignored";
  const result = await checkBookingAttempt(payment);
  if (result === "unknown") throw new PaystackError("unavailable");
  return "applied";
}

/** The job's share: active attempts nobody has checked for a while. */
export async function reconcileBookingPayments(limit: number, olderThanMs: number): Promise<number> {
  const { payments } = await bookingCollections();
  const before = new Date(Date.now() - olderThanMs);
  const stale = await payments
    .find({ active: true, updatedAt: { $lt: before } })
    .sort({ updatedAt: 1 })
    .limit(limit)
    .toArray();
  for (const payment of stale) {
    const result = await checkBookingAttempt(payment);
    if (result === "pending" || result === "unknown") {
      const now = new Date();
      await payments.updateOne({ _id: payment._id, active: true }, { $set: { lastCheckedAt: now, updatedAt: now } });
    }
  }
  return stale.length;
}
