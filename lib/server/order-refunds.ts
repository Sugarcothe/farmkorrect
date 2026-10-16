import "server-only";
import { MongoServerError, ObjectId, type ClientSession } from "mongodb";
import { CURRENCY } from "@/lib/wallet/types";
import type { OrderActor } from "@/lib/orders/types";
import type { OrderDoc, RefundDoc } from "./models";
import { syncOrderLedger } from "./order-ledger";
import { bestEffort, flagOrder, historyItem, orderCollections } from "./order-store";
import {
  createRefund,
  fetchRefund,
  listRefunds,
  PaystackError,
  refundOutcome,
  verifyTransaction,
  type RefundResult,
} from "./paystack";

// Refunds to buyers through Paystack.
//
//   creating ──► pending ──► processed
//      │            └──────► failed
//      └──────────────────► failed
//
// An order refund is claimed on the order (refundInFlight) in the same
// transaction that creates it, so only one runs per order and the amount
// can never exceed what's left of the payment. Before it's sent, the
// seller's earning is put on hold; the ledger only records the refund once
// Paystack confirms it was processed.
//
// Paystack doesn't take our own reference for a refund, so a refund is sent
// at most once (sentAt is set first). If its answer is lost, the refund
// stays "creating" until it's found in Paystack's list of refunds for the
// transaction, or is given up as failed once it still isn't there after
// NOT_FOUND_GRACE_MS. Webhook payloads are never trusted: they only trigger
// a lookup through the API.

export const REFUND_REFERENCE = /^fkr_[0-9a-f]{24}$/;
const NOT_FOUND_GRACE_MS = 30 * 60_000;

export type NewRefund = {
  amountKobo: number;
  reason: string;
  by: OrderActor;
  userId: ObjectId | null;
  idempotencyKey: string | null;
};

/** A refund document for `order`, ready to insert (status "creating"). */
export function newRefundDoc(order: OrderDoc, kind: RefundDoc["kind"], paymentReference: string, input: NewRefund): RefundDoc {
  const now = new Date();
  const _id = new ObjectId();
  return {
    _id,
    orderId: order._id,
    kind,
    reference: `fkr_${_id.toHexString()}`,
    paymentReference,
    amountKobo: input.amountKobo,
    currency: CURRENCY,
    reason: input.reason,
    requestedBy: input.by,
    requestedByUserId: input.userId,
    idempotencyKey: input.idempotencyKey,
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
 * Inside a transaction: claims the order for an order refund and inserts it.
 * Returns null if the order can't be refunded that much right now (another
 * refund is running, or not enough is left).
 */
export async function claimOrderRefund(
  order: OrderDoc,
  input: NewRefund,
  session: ClientSession,
  extraSet: Record<string, unknown> = {},
): Promise<RefundDoc | null> {
  if (!order.paymentReference) return null;
  const { orders, refunds } = await orderCollections();
  const refund = newRefundDoc(order, "order", order.paymentReference, input);
  const now = new Date();
  const claimed = await orders.updateOne(
    {
      _id: order._id,
      refundInFlight: null,
      paymentStatus: { $in: ["paid", "partially_refunded"] },
      $expr: { $gte: [{ $subtract: ["$paidKobo", "$refundedKobo"] }, input.amountKobo] },
    },
    {
      $set: { ...extraSet, refundInFlight: refund._id, refundPendingKobo: input.amountKobo, ledgerSyncAt: now, updatedAt: now },
      $push: { history: historyItem("refund_requested", input.by, input.userId, now) },
    },
    { session },
  );
  if (claimed.modifiedCount !== 1) return null;
  await refunds.insertOne(refund, { session });
  return refund;
}

/**
 * Starts a late-payment refund: a payment that succeeded after its order
 * was closed or already paid never counts towards the order and is returned
 * in full, once per payment.
 */
export async function refundLatePayment(order: OrderDoc, paymentReference: string, amountKobo: number): Promise<void> {
  const { refunds } = await orderCollections();
  const refund = newRefundDoc(order, "late_payment", paymentReference, {
    amountKobo,
    reason: "Payment received after the order was closed",
    by: "system",
    userId: null,
    idempotencyKey: null,
  });
  try {
    await refunds.insertOne(refund);
  } catch (error) {
    // already being returned
    if (error instanceof MongoServerError && error.code === 11000) return;
    throw error;
  }
  console.error(`[orders] order ${order._id.toHexString()}: returning a late payment`);
  await sendRefund(refund);
}

// --- applying Paystack's answer ------------------------------------------------------

async function markProcessed(refund: RefundDoc, result: RefundResult | null) {
  const { refunds, orders } = await orderCollections();
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
    await orders.updateOne(
      { _id: refund.orderId },
      { $set: { updatedAt: now }, $push: { history: historyItem("late_payment_refunded", "system", null, now) } },
    );
    return;
  }
  // computed in the update itself, so the totals can't drift
  const refunded = { $add: ["$refundedKobo", refund.amountKobo] };
  await orders.updateOne({ _id: refund.orderId, refundInFlight: refund._id }, [
    {
      $set: {
        refundedKobo: refunded,
        refundPendingKobo: 0,
        refundInFlight: null,
        paymentStatus: { $cond: [{ $gte: [refunded, "$paidKobo"] }, "refunded", "partially_refunded"] },
        ledgerSyncAt: now,
        updatedAt: now,
        history: { $concatArrays: ["$history", [historyItem("refund_processed", "system", null, now)]] },
      },
    },
  ]);
  await bestEffort("ledger sync", () => syncOrderLedger(refund.orderId));
}

async function markFailed(refund: RefundDoc, providerStatus: string) {
  const { refunds, orders } = await orderCollections();
  const now = new Date();
  const updated = await refunds.findOneAndUpdate(
    { _id: refund._id, status: { $in: ["creating", "pending"] } },
    { $set: { status: "failed", failedAt: now, providerStatus, lastCheckedAt: now, updatedAt: now } },
  );
  if (!updated) return;
  await flagOrder(refund.orderId, `refund ${refund.reference} failed (${providerStatus})`);
  if (refund.kind === "late_payment") return;
  await orders.updateOne(
    { _id: refund.orderId, refundInFlight: refund._id },
    {
      $set: { refundInFlight: null, refundPendingKobo: 0, ledgerSyncAt: now, updatedAt: now },
      $push: { history: historyItem("refund_failed", "system", null, now) },
    },
  );
  await bestEffort("ledger sync", () => syncOrderLedger(refund.orderId));
}

async function applyResult(refund: RefundDoc, result: RefundResult) {
  if (result.amountKobo !== refund.amountKobo) {
    await flagOrder(refund.orderId, `refund ${refund.reference} amount doesn't match Paystack's`);
    return;
  }
  const outcome = refundOutcome(result.status);
  if (outcome === "processed") return markProcessed(refund, result);
  if (outcome === "failed") return markFailed(refund, result.status);
  const now = new Date();
  const { refunds } = await orderCollections();
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

async function noteChecked(refund: RefundDoc) {
  const now = new Date();
  const { refunds } = await orderCollections();
  await refunds.updateOne({ _id: refund._id }, { $set: { lastCheckedAt: now, updatedAt: now } });
}

// --- sending and reconciling -----------------------------------------------------------

/** Sends a refund to Paystack, unless it was already sent. */
async function sendRefund(refund: RefundDoc) {
  const { refunds } = await orderCollections();
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
    // unknown outcome: found or given up on by reconcileRefund
    console.error(`[orders] refund ${refund.reference}: outcome unknown (${error instanceof PaystackError ? error.failure : "error"})`);
    return noteChecked(refund);
  }
  await applyResult(refund, result);
}

/** The Paystack transaction id of the payment a refund returns. */
async function transactionIdFor(refund: RefundDoc): Promise<number | null> {
  const { payments } = await orderCollections();
  const payment = await payments.findOne({ reference: refund.paymentReference });
  if (payment?.providerTransactionId) return payment.providerTransactionId;
  return (await verifyTransaction(refund.paymentReference))?.transactionId ?? null;
}

/** Looks for a refund whose answer was lost among the transaction's refunds. */
async function findLostRefund(refund: RefundDoc) {
  let found: RefundResult | undefined;
  try {
    const transactionId = await transactionIdFor(refund);
    if (transactionId === null) return noteChecked(refund);
    const { refunds } = await orderCollections();
    const known = new Set(
      (await refunds.find({ paymentReference: refund.paymentReference, providerRefundId: { $ne: null } }).toArray()).map(
        (r) => r.providerRefundId,
      ),
    );
    found = (await listRefunds(transactionId)).find((r) => !known.has(r.id) && r.amountKobo === refund.amountKobo);
  } catch (error) {
    if (!(error instanceof PaystackError)) throw error;
    return noteChecked(refund);
  }
  if (found) return applyResult(refund, found);
  if (Date.now() - (refund.sentAt?.getTime() ?? 0) >= NOT_FOUND_GRACE_MS) return markFailed(refund, "not_found");
  await noteChecked(refund);
}

/**
 * Moves a refund forward: puts the hold in place and sends it if it wasn't
 * sent yet, or asks Paystack what became of it.
 */
export async function continueRefund(refundId: ObjectId): Promise<void> {
  const { refunds } = await orderCollections();
  const refund = await refunds.findOne({ _id: refundId, status: { $in: ["creating", "pending"] } });
  if (!refund) return;
  if (refund.status === "creating" && !refund.sentAt) {
    // the seller's earning must be on hold before any money goes back
    if (refund.kind === "order") await syncOrderLedger(refund.orderId);
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

/** A verified refund webhook for one of our payments: re-checks its open refunds. */
export async function handleRefundEvent(paymentReference: string): Promise<"applied" | "ignored"> {
  const { refunds } = await orderCollections();
  const open = await refunds.find({ paymentReference, status: { $in: ["creating", "pending"] } }).toArray();
  for (const refund of open) await continueRefund(refund._id);
  return open.length ? "applied" : "ignored";
}

/** The job's share: refunds not yet settled, oldest first. */
export async function reconcileRefunds(limit: number, olderThanMs: number): Promise<number> {
  const { refunds } = await orderCollections();
  const before = new Date(Date.now() - olderThanMs);
  const open = await refunds
    .find({ status: { $in: ["creating", "pending"] }, updatedAt: { $lt: before } })
    .sort({ updatedAt: 1 })
    .limit(limit)
    .toArray();
  for (const refund of open) await bestEffort(`refund ${refund.reference}`, () => continueRefund(refund._id));
  return open.length;
}
