import "server-only";
import { MongoServerError, ObjectId } from "mongodb";
import type { CheckoutResponse, PaymentCheck } from "@/lib/orders/types";
import { CURRENCY } from "@/lib/wallet/types";
import { ConfigError, getAuthConfig, getPaymentConfig } from "./config";
import { HttpError } from "./http";
import type { OrderDoc, PaymentDoc, UserDoc } from "./models";
import { syncOrderLedger } from "./order-ledger";
import { refundLatePayment } from "./order-refunds";
import { bestEffort, flagOrder, historyItem, inTransaction, isPayable, notifyOrder, orderCollections } from "./order-store";
import {
  initializeTransaction,
  PaystackError,
  transactionOutcome,
  verifyTransaction,
  type TransactionResult,
} from "./paystack";

// Collecting an order's total through Paystack.
//
//   initializing ──► open ──► success
//        │             └────► failed      (the buyer may start a new attempt)
//        └──► superseded                  (never reached the buyer)
//   open ──► closed                       (the order was cancelled unpaid)
//
// At most one attempt per order is active (a unique index), so a buyer who
// clicks Pay twice, or comes back later, resumes the same checkout instead of
// being charged twice. Being sent back from Paystack proves nothing: an
// order is only marked paid after the transaction is verified through the
// API (on the buyer's return, from the webhook or by the job) and its
// reference, amount, currency, order and status all match. Anything
// ambiguous leaves it pending. A payment that succeeds after its order was
// closed (or was paid by another attempt) is returned automatically.

export const PAYMENT_REFERENCE = /^fko_[0-9a-f]{24}$/;
export const PAYMENTS_OFF = "Online payment isn't available right now. Please try again later.";
const PAYSTACK_DOWN = "We couldn't reach our payment provider. Please try again in a minute.";
/** an attempt Paystack still doesn't know about this long after we created it never started */
const START_GRACE_MS = 60_000;

/** Whether payments can be taken; a configuration mistake counts as off (and is logged). */
export function paymentsEnabled(): boolean {
  try {
    return getPaymentConfig().enabled;
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(`[orders] payment configuration error: ${error.message}`);
    return false;
  }
}

async function setAttempt(payment: PaymentDoc, from: PaymentDoc["status"][], set: Partial<PaymentDoc>) {
  const { payments } = await orderCollections();
  const now = new Date();
  return payments.findOneAndUpdate(
    { _id: payment._id, status: { $in: from } },
    { $set: { ...set, lastCheckedAt: now, updatedAt: now } },
    { returnDocument: "after" },
  );
}

// --- applying a verified transaction --------------------------------------------------

/** Marks the order paid by this payment; anything else means the money is returned. */
async function markPaid(payment: PaymentDoc, transaction: TransactionResult): Promise<PaymentCheck> {
  const { orders, payments } = await orderCollections();
  const now = new Date();
  const paidAt = transaction.paidAt ?? now;
  const orderUpdated = await inTransaction(async (session) => {
    await payments.updateOne(
      { _id: payment._id, status: { $ne: "success" } },
      {
        $set: {
          status: "success",
          active: false,
          providerStatus: transaction.status,
          providerTransactionId: transaction.transactionId,
          paidAt,
          lastCheckedAt: now,
          updatedAt: now,
        },
      },
      { session },
    );
    const updated = await orders.updateOne(
      {
        _id: payment.orderId,
        paymentStatus: { $in: ["pending", "failed"] },
        fulfillmentStatus: "pending",
        "inventory.releasedAt": null,
      },
      {
        $set: {
          paymentStatus: "paid",
          paymentReference: payment.reference,
          paidKobo: transaction.amountKobo,
          paidAt: now,
          ledgerSyncAt: now,
          notifySyncAt: now,
          updatedAt: now,
        },
        $push: { history: historyItem("paid", "system", null, now) },
      },
      { session },
    );
    return updated.modifiedCount === 1;
  });
  if (orderUpdated) {
    await bestEffort("ledger sync", () => syncOrderLedger(payment.orderId));
    await notifyOrder(payment.orderId);
    return "paid";
  }
  const order = await orders.findOne({ _id: payment.orderId });
  if (!order) return "unknown";
  if (order.paymentReference === payment.reference) return "paid";
  // the order was cancelled, expired or paid by another attempt meanwhile
  await refundLatePayment(order, payment.reference, transaction.amountKobo);
  return order.paymentStatus === "paid" || order.paymentStatus === "partially_refunded" ? "paid" : "failed";
}

/** Applies what Paystack reported for one of our payment attempts. */
async function applyTransaction(payment: PaymentDoc, transaction: TransactionResult): Promise<PaymentCheck> {
  const outcome = transactionOutcome(transaction.status);
  if (outcome === "success") {
    const matches =
      transaction.reference === payment.reference &&
      transaction.amountKobo === payment.amountKobo &&
      transaction.currency === CURRENCY &&
      transaction.orderId === payment.orderId.toHexString();
    if (!matches) {
      // money arrived, but not what we asked for: a person decides
      await setAttempt(payment, ["initializing", "open", "failed", "superseded", "closed"], {
        status: "success",
        active: false,
        providerStatus: transaction.status,
        providerTransactionId: transaction.transactionId,
      });
      await flagOrder(payment.orderId, `payment ${payment.reference} doesn't match the order`);
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
      const { orders } = await orderCollections();
      const now = new Date();
      const marked = await orders.updateOne(
        { _id: payment.orderId, paymentStatus: "pending" },
        {
          $set: { paymentStatus: "failed", notifySyncAt: now, updatedAt: now },
          $push: { history: historyItem("payment_failed", "system", null, now) },
        },
      );
      if (marked.modifiedCount === 1) await notifyOrder(payment.orderId);
    }
    return "failed";
  }

  await setAttempt(payment, ["initializing", "open"], {
    providerStatus: transaction.status,
    providerTransactionId: transaction.transactionId,
  });
  return "pending";
}

/**
 * Asks Paystack about one attempt and applies the answer. "unknown" when
 * Paystack can't be reached (nothing changes).
 */
export async function checkAttempt(payment: PaymentDoc): Promise<PaymentCheck> {
  let transaction: TransactionResult | null;
  try {
    transaction = await verifyTransaction(payment.reference);
  } catch (error) {
    if (!(error instanceof PaystackError)) throw error;
    return "unknown";
  }
  if (transaction) return applyTransaction(payment, transaction);
  // Paystack has no such transaction: one we never finished creating is dropped
  if (payment.status === "initializing" && Date.now() - payment.createdAt.getTime() >= START_GRACE_MS) {
    await setAttempt(payment, ["initializing"], { status: "superseded", active: false, providerStatus: "not_found" });
    return "failed";
  }
  return payment.status === "failed" ? "failed" : "pending";
}

// --- the buyer's checkout ----------------------------------------------------------------

async function startAttempt(order: OrderDoc, buyer: UserDoc): Promise<CheckoutResponse> {
  const { payments, orders } = await orderCollections();
  const now = new Date();
  const _id = new ObjectId();
  const payment: PaymentDoc = {
    _id,
    orderId: order._id,
    buyerUserId: order.buyerUserId,
    reference: `fko_${_id.toHexString()}`,
    amountKobo: order.totalKobo,
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
    // another Pay click is starting one right now
    if (error instanceof MongoServerError && error.code === 11000)
      throw new HttpError(409, "Your payment is already being set up. Please try again in a moment.");
    throw error;
  }
  await orders.updateOne(
    { _id: order._id },
    { $set: { updatedAt: now }, $push: { history: historyItem("payment_started", "buyer", buyer._id, now) } },
  );

  let authorizationUrl: string;
  try {
    ({ authorizationUrl } = await initializeTransaction({
      email: buyer.emailNormalized,
      amountKobo: payment.amountKobo,
      reference: payment.reference,
      callbackUrl: `${getAuthConfig().appOrigin}/orders/${order._id.toHexString()}`,
      orderId: order._id.toHexString(),
      orderNumber: order.number,
    }));
  } catch (error) {
    if (error instanceof PaystackError && error.failure !== "unavailable") {
      // no transaction was created: this attempt is over
      await setAttempt(payment, ["initializing"], { status: "failed", active: false, providerStatus: error.failure });
      if (error.failure === "misconfigured") throw new HttpError(503, PAYMENTS_OFF);
      throw new HttpError(502, "Our payment provider couldn't start this payment. Please try again.");
    }
    // it may exist at Paystack; the next attempt checks before starting another
    throw new HttpError(503, PAYSTACK_DOWN);
  }
  await setAttempt(payment, ["initializing"], { status: "open", authorizationUrl, providerStatus: "initialized" });
  return { authorizationUrl, reference: payment.reference };
}

/**
 * The checkout page for the buyer's order: the open attempt's, if there is
 * one Paystack still considers payable, otherwise a new one. Never starts a
 * second attempt while an earlier one might still be paid.
 */
export async function checkout(order: OrderDoc, buyer: UserDoc): Promise<CheckoutResponse> {
  if (!isPayable(order)) {
    if (order.paymentStatus === "paid") throw new HttpError(409, "This order is already paid.");
    throw new HttpError(409, "This order can no longer be paid. Place a new order instead.");
  }
  if (!paymentsEnabled()) throw new HttpError(503, PAYMENTS_OFF);
  const { payments } = await orderCollections();
  const active = await payments.findOne({ orderId: order._id, active: true });
  if (active) {
    const result = await checkAttempt(active);
    if (result === "paid") throw new HttpError(409, "This order is already paid.");
    if (result === "unknown") throw new HttpError(503, PAYSTACK_DOWN);
    if (result === "pending") {
      const current = await payments.findOne({ _id: active._id });
      if (current?.active && current.status === "open" && current.authorizationUrl)
        return { authorizationUrl: current.authorizationUrl, reference: current.reference };
      if (current?.active && current.status === "initializing")
        throw new HttpError(409, "Your payment is still being set up. Please try again in a minute.");
      // pending at Paystack but we never got its checkout link: replace it
      if (current?.active) await setAttempt(current, ["initializing", "open"], { status: "superseded", active: false });
    }
    // a refreshed order may have been paid or expired meanwhile
    const { orders } = await orderCollections();
    const fresh = await orders.findOne({ _id: order._id });
    if (!fresh || !isPayable(fresh)) throw new HttpError(409, "This order can no longer be paid.");
  }
  return startAttempt(order, buyer);
}

/**
 * Checks the order's payment with Paystack (when the buyer returns from the
 * checkout page). `reference` is the one in the return URL: it's only used
 * if it's one of this order's own attempts.
 */
export async function verifyOrderPayment(order: OrderDoc, reference: string | null): Promise<PaymentCheck> {
  if (order.paymentStatus !== "pending" && order.paymentStatus !== "failed")
    return order.paymentStatus === "cancelled" ? "failed" : "paid";
  const { payments } = await orderCollections();
  const attempt =
    (reference && PAYMENT_REFERENCE.test(reference)
      ? await payments.findOne({ orderId: order._id, reference })
      : null) ?? (await payments.findOne({ orderId: order._id, active: true }));
  if (!attempt) return order.paymentStatus === "failed" ? "failed" : "pending";
  if (!paymentsEnabled()) return "unknown";
  return checkAttempt(attempt);
}

/**
 * Inside the cancel flow: the active attempt must be settled first. Returns
 * "paid" if it turned out to be paid, "unknown" if Paystack can't be
 * reached, otherwise "clear" (it's then closed by closeAttempts).
 */
export async function settleActiveAttempt(orderId: ObjectId): Promise<"paid" | "unknown" | "clear"> {
  const { payments } = await orderCollections();
  const active = await payments.findOne({ orderId, active: true });
  if (!active) return "clear";
  if (!paymentsEnabled()) return active.status === "initializing" || active.status === "open" ? "unknown" : "clear";
  const result = await checkAttempt(active);
  return result === "paid" ? "paid" : result === "unknown" ? "unknown" : "clear";
}

/** Closes any attempt still open for a cancelled order; paying it later is refunded. */
export async function closeAttempts(orderId: ObjectId) {
  const { payments } = await orderCollections();
  const now = new Date();
  await payments.updateMany(
    { orderId, active: true },
    { $set: { status: "closed", active: false, updatedAt: now } },
  );
}

// --- webhooks and the job --------------------------------------------------------------

/**
 * A verified charge.success webhook. The payload only says which reference to
 * check: the result always comes from the verification API. Throws if
 * Paystack can't be reached, so the webhook is retried.
 */
export async function handleChargeEvent(reference: string): Promise<"applied" | "ignored"> {
  if (!PAYMENT_REFERENCE.test(reference)) return "ignored";
  const { payments } = await orderCollections();
  const payment = await payments.findOne({ reference });
  if (!payment) return "ignored";
  const result = await checkAttempt(payment);
  if (result === "unknown") throw new PaystackError("unavailable");
  return "applied";
}

/** The job's share: active attempts nobody has checked for a while. */
export async function reconcilePayments(limit: number, olderThanMs: number): Promise<number> {
  const { payments } = await orderCollections();
  const before = new Date(Date.now() - olderThanMs);
  const stale = await payments
    .find({ active: true, updatedAt: { $lt: before } })
    .sort({ updatedAt: 1 })
    .limit(limit)
    .toArray();
  for (const payment of stale) {
    const result = await checkAttempt(payment);
    if (result === "pending" || result === "unknown") {
      const now = new Date();
      await payments.updateOne({ _id: payment._id, active: true }, { $set: { lastCheckedAt: now, updatedAt: now } });
    }
  }
  return stale.length;
}
