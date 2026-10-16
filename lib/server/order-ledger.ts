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
import type { OrderDoc } from "./models";
import { flagOrder, ledgerSource, orderCollections } from "./order-store";

// Keeps the seller's ledger in step with an order. Everything here is derived
// from the order's own (server-written) state and every ledger call is
// idempotent, so it's safe to run any number of times, in any order:
//
// - earning: recorded once the order is paid *and* a commission policy is
//   configured. The policy applied is stored on the order (settlement) so it
//   never changes afterwards, even if the configured rate does.
// - delivery: the server time the seller marked it delivered, which starts
//   the 24-hour window before the earning can be withdrawn.
// - refunds: only refunds Paystack confirmed as processed; each debits the
//   seller's share of it (the platform returns its own share of the fee).
// - hold: while a refund is in flight or the buyer has an open issue, the
//   earning is put under review (a ledger dispute) so it can't be withdrawn.

/** The configured policy, or null when none is set or it's misconfigured (logged). */
function commissionPolicy(): CommissionPolicy | null {
  try {
    return getCommissionPolicy();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(`[orders] commission configuration error: ${error.message}`);
    return null;
  }
}

/** The platform's fee on `grossKobo` at `rateBps`, rounded down to the kobo. */
export function commissionKobo(grossKobo: number, rateBps: number): number {
  return Math.floor((grossKobo * rateBps) / 10_000);
}

/**
 * How much of the seller's earning `refundedKobo` (cumulative) of the
 * payment takes back: the refund less the platform's proportional share of
 * the fee. Refunding everything takes back exactly gross − fee.
 */
export function sellerRefundShare(refundedKobo: number, grossKobo: number, feeKobo: number): number {
  return refundedKobo - Math.floor((feeKobo * refundedKobo) / grossKobo);
}

const needsHold = (order: OrderDoc) => order.refundInFlight !== null || (order.issue !== null && order.issue.closedAt === null);

/** Fixes the commission for a paid order, once. Returns the order as stored. */
async function settle(order: OrderDoc, policy: CommissionPolicy): Promise<OrderDoc | null> {
  const { orders } = await orderCollections();
  const now = new Date();
  const settlement = {
    policyId: policy.id,
    rateBps: policy.rateBps,
    grossKobo: order.paidKobo,
    feeKobo: commissionKobo(order.paidKobo, policy.rateBps),
    settledAt: now,
  };
  await orders.updateOne(
    // an order cancelled before it was settled never earned anything
    { _id: order._id, settlement: null, paidAt: { $type: "date" }, fulfillmentStatus: { $ne: "cancelled" } },
    { $set: { settlement, updatedAt: now } },
  );
  return orders.findOne({ _id: order._id });
}

/** Applies the order's state to the ledger. */
async function apply(order: OrderDoc) {
  if (!order.paidAt || !order.paymentReference) return;
  if (!order.settlement) {
    const policy = commissionPolicy();
    if (!policy || order.fulfillmentStatus === "cancelled") return;
    const settled = await settle(order, policy);
    if (!settled?.settlement) return;
    order = settled;
  }
  const settlement = order.settlement!;
  const source = ledgerSource(order);

  await recordEarning({
    merchantUserId: order.sellerUserId,
    ...source,
    paymentReference: order.paymentReference!,
    grossKobo: settlement.grossKobo,
    platformFeeKobo: settlement.feeKobo,
    currency: CURRENCY,
  });
  if (order.deliveredAt) await recordDelivery({ ...source, deliveredAt: order.deliveredAt });

  // processed refunds, in the order they happened (only one runs at a time)
  const { refunds, orders } = await orderCollections();
  const processed = await refunds
    .find({ orderId: order._id, kind: "order", status: "processed" })
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

  if (needsHold(order)) {
    await openDispute(source);
  } else {
    await closeDispute(source);
    // a refund or issue may have started meanwhile: never leave it unheld
    const current = await orders.findOne({ _id: order._id });
    if (current && needsHold(current)) await openDispute(source);
  }
}

/**
 * Brings the seller's ledger in line with the order. Call it after any
 * change to payment, delivery, refunds or issues; the order's ledgerSyncAt
 * marker is cleared only if nothing changed while it ran, so the job retries
 * anything that was missed. A ledger refusal is flagged for review rather
 * than retried forever.
 */
export async function syncOrderLedger(orderId: ObjectId): Promise<void> {
  const { orders } = await orderCollections();
  const order = await orders.findOne({ _id: orderId });
  if (!order) return;
  const marker = order.ledgerSyncAt;
  try {
    await apply(order);
  } catch (error) {
    if (!(error instanceof LedgerValidationError || error instanceof LedgerConflictError)) throw error;
    await flagOrder(order._id, `ledger refused the order: ${error.message}`);
  }
  if (marker) await orders.updateOne({ _id: orderId, ledgerSyncAt: marker }, { $set: { ledgerSyncAt: null } });
}
